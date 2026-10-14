/**
 * One scripted agent: an MCP client on the instance's `/mcp` with its own API token, plus plain
 * git in its own clone, with exactly the moves a real agent makes (see skills/mycelium/SKILL.md).
 * Also the shared timeline every agent prints to.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ timeline

const COLORS = [36, 33, 35, 32, 34, 91, 96, 93, 95, 92];
let useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
let width = 8;

export function timelineOptions(o: { color?: boolean; nameWidth?: number }) {
  if (o.color !== undefined) useColor = o.color;
  if (o.nameWidth) width = o.nameWidth;
}

const clock = () => new Date().toTimeString().slice(0, 8);
export const paint = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = (s: string) => paint(2, s);
export const bold = (s: string) => paint(1, s);

/** A line of the timeline: `[12:03:04] agent-b   opened PR #7 …`. */
export function line(who: string, color: number, text: string) {
  console.log(`${dim(`[${clock()}]`)} ${paint(color, who.padEnd(width))}  ${text}`);
}

// ------------------------------------------------------------------ MCP

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly text: string,
  ) {
    super(`${tool}: ${text}`);
  }
  /** The HTTP status in "Error 409: …", if any. */
  get status(): number | null {
    const m = /^Error (\d{3})/.exec(this.text);
    return m ? Number(m[1]) : null;
  }
}

export type Stats = {
  agent: string;
  feature: string;
  role: string;
  pr: number | null;
  result: "merged" | "failed" | "running";
  error?: string;
  startedAt: number;
  endedAt: number | null;
  /** Time spent waiting on required checks. */
  checkWaitMs: number;
  ciFixes: number;
  rebases: number;
  mergeRetries: number;
  toolCalls: number;
};

export class FleetAgent {
  private client: Client | null = null;
  readonly color: number;
  stats: Stats;

  constructor(
    readonly name: string,
    readonly token: string,
    readonly url: string,
    index: number,
    readonly paceMs: number,
  ) {
    this.color = COLORS[index % COLORS.length]!;
    this.stats = {
      agent: name,
      feature: "",
      role: "",
      pr: null,
      result: "running",
      startedAt: Date.now(),
      endedAt: null,
      checkWaitMs: 0,
      ciFixes: 0,
      rebases: 0,
      mergeRetries: 0,
      toolCalls: 0,
    };
  }

  say(text: string) {
    line(this.name, this.color, text);
  }

  /** The delay between steps that lets a person follow along in the browser. */
  pace(factor = 1) {
    return sleep(this.paceMs * factor);
  }

  async connect() {
    // A fresh workers.dev deployment can answer 404 for a minute; retry a few times.
    for (let attempt = 1; ; attempt++) {
      try {
        const transport = new StreamableHTTPClientTransport(new URL("/mcp", this.url), {
          requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
        });
        const client = new Client({ name: `mycelium-fleet/${this.name}`, version: "0.1.0" });
        await client.connect(transport);
        this.client = client;
        return;
      } catch (error) {
        if (attempt >= 4) throw new Error(`${this.name} could not connect to /mcp: ${error}`);
        await sleep(2000 * attempt);
      }
    }
  }

  async close() {
    await this.client?.close().catch(() => {});
  }

  /** Calls a tool; returns its text. Throws ToolError for a tool error (isError). */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    if (!this.client) throw new Error(`${this.name} is not connected`);
    for (let attempt = 1; ; attempt++) {
      try {
        this.stats.toolCalls++;
        const r = await this.client.callTool({ name: tool, arguments: args });
        const text = (r.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
        if (r.isError) throw new ToolError(tool, text);
        return text;
      } catch (error) {
        // Transport hiccups (a 5xx, a dropped connection) are retried; tool errors are answers.
        if (error instanceof ToolError || attempt >= 3) throw error;
        await sleep(1500 * attempt);
      }
    }
  }

  async json<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    return JSON.parse(await this.call(tool, args)) as T;
  }
}

// ------------------------------------------------------------------ git

export type Credentials = { remote: string; token: string; expires: string };

/** Parse `git_credentials`' text answer (`remote: …`, `token: …`, `expires: …` lines). */
export function parseCredentials(text: string): Credentials {
  const field = (name: string) => new RegExp(`^${name}: (.+)$`, "m").exec(text)?.[1]?.trim();
  const remote = field("remote");
  const token = field("token");
  if (!remote || !token) throw new Error(`git_credentials answer without remote/token:\n${text}`);
  return { remote, token, expires: field("expires") ?? "" };
}

export type GitResult = { code: number; out: string; err: string };

/** A working clone; network commands carry the Artifacts token in a header, never in the URL. */
export class Clone {
  constructor(
    readonly dir: string,
    private creds: () => Promise<Credentials>,
    private identity: { name: string; email: string },
  ) {}

  private current: Credentials | null = null;

  async run(args: string[], cwd = this.dir): Promise<GitResult> {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: this.identity.name,
        GIT_AUTHOR_EMAIL: this.identity.email,
        GIT_COMMITTER_NAME: this.identity.name,
        GIT_COMMITTER_EMAIL: this.identity.email,
      },
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out: out.trim(), err: err.trim() };
  }

  async ok(args: string[], cwd = this.dir): Promise<string> {
    const r = await this.run(args, cwd);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.err || r.out}`);
    return r.out;
  }

  /** A network command with the token header; asks for new credentials once on a 401. */
  async net(args: string[], cwd = this.dir): Promise<GitResult> {
    for (let attempt = 1; ; attempt++) {
      if (!this.current) this.current = await this.creds();
      const header = `http.extraHeader=Authorization: Bearer ${this.current.token}`;
      const r = await this.run(["-c", header, ...args], cwd);
      if (r.code === 0 || attempt >= 3) return r;
      if (/401|403|Authentication failed|could not read Username/i.test(r.err)) {
        this.current = null; // expired: ask again
      } else if (!/50\d|timed out|Connection reset|RPC failed|unexpected disconnect/i.test(r.err)) {
        return r;
      }
      await sleep(1000 * attempt);
    }
  }

  async netOk(args: string[], cwd = this.dir): Promise<string> {
    const r = await this.net(args, cwd);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.err || r.out}`);
    return r.out;
  }

  async clone(): Promise<void> {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(join(this.dir, ".."), { recursive: true });
    if (!this.current) this.current = await this.creds();
    await this.netOk(["clone", "-q", this.current.remote, this.dir], join(this.dir, ".."));
  }

  head(rev = "HEAD") {
    return this.ok(["rev-parse", rev]);
  }

  /** `N files changed, +A −D` for the working tree against HEAD, new files included. */
  async shortstat(): Promise<string> {
    await this.ok(["add", "-A"]);
    const s = await this.ok(["diff", "--cached", "--shortstat"]);
    const files = /(\d+) files? changed/.exec(s)?.[1] ?? "0";
    const add = /(\d+) insertions?/.exec(s)?.[1] ?? "0";
    const del = /(\d+) deletions?/.exec(s)?.[1] ?? "0";
    return `${files} file${files === "1" ? "" : "s"}, +${add} −${del}`;
  }
}

/** Run `bun test` (optionally on some files) in a clone; the pass/fail counts and failures. */
export async function bunTest(
  dir: string,
  files: string[] = [],
): Promise<{ ok: boolean; pass: number; fail: number; failures: string[] }> {
  const proc = Bun.spawn(["bun", "test", ...files.map((f) => `./${f}`)], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, ...testCounts(out + err) };
}

/** Pass/fail counts and `(fail) …` lines from bun test output (also from a run's step log). */
export function testCounts(log: string) {
  const pass = Number(/(\d+) pass/.exec(log)?.[1] ?? 0);
  const fail = Number(/(\d+) fail/.exec(log)?.[1] ?? 0);
  const failures = [
    ...new Set([...log.matchAll(/\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]!.trim())),
  ];
  return { pass, fail, failures };
}
