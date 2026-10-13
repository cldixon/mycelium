import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createWebSession, setSetting } from "@mycelium/platform";
import { createTestD1 } from "@mycelium/platform/testing";
import { app } from "../api/app.js";
import type { Bindings } from "../api/bindings.js";
import { createApiToken } from "../auth/tokens.js";
import { getDb } from "../db/migrations.js";

// D1 is real (Miniflare); Artifacts is a fake with one commit holding a
// workflow file, and smart HTTP ref listing is answered by a stubbed fetch.
const OWNER = "did:plc:ownerabcdefghijklmnopqrs";
const BASE = "http://mycelium.test";
const REMOTE = "https://git.example/r.git";
const SHA = { main: "a".repeat(40), feat: "b".repeat(40) };
const WORKFLOW = "on: [manual, pull_request]\nsteps: [{name: hi, run: echo hi}]";

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, "0") + s;
const advertisement = [
  pkt("# service=git-upload-pack\n"),
  "0000",
  pkt(`${SHA.main} HEAD\0symref=HEAD:refs/heads/main\n`),
  pkt(`${SHA.main} refs/heads/main\n`),
  pkt(`${SHA.feat} refs/heads/feat\n`),
  "0000",
].join("");

const trees: Record<string, ArtifactsTreeEntry[]> = {
  root: [{ name: ".mycelium", mode: "40000", hash: "m", type: "tree" }],
  m: [{ name: "workflows", mode: "40000", hash: "w", type: "tree" }],
  w: [{ name: "ci.yml", mode: "100644", hash: "ci", type: "blob" }],
};
const fakeArtifacts = {
  async get(name: string) {
    return {
      createToken: async (scope: string, ttl: number) => ({
        id: "t",
        plaintext: `art_${name}_${scope}?expires=${ttl}`,
        scope,
        expiresAt: "2030-01-01T00:00:00Z",
      }),
      readCommit: async () => ({ treeHash: "root" }),
      readTree: async (hash: string) => trees[hash] ?? null,
      readBlob: async (hash: string) => (hash === "ci" ? new Blob([WORKFLOW]) : null),
      [Symbol.dispose]() {},
    };
  },
};

let env: Bindings;
let db: D1Database;
let dispose: () => Promise<void>;
let sent: unknown[];
const realFetch = globalThis.fetch;
const tokens: Record<string, string> = {};

beforeEach(async () => {
  const t = await createTestD1();
  dispose = t.dispose;
  db = await getDb(t.db);
  sent = [];
  env = {
    DB: t.db,
    INSTANCE_TITLE: "mycelium",
    ARTIFACTS: fakeArtifacts,
    JOBS: { send: async (m: unknown) => void sent.push(m) },
    ASSETS: { fetch: async () => new Response("spa") },
  } as unknown as Bindings;
  await setSetting(db, "owner_did", OWNER);
  await setSetting(db, "owner_handle", "owner.test");
  await setSetting(db, "owner_handle_checked_at", new Date().toISOString());
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO repos (name, visibility, remote, created_at, updated_at) VALUES ('r', 'private', ?, ?, ?)",
    )
    .bind(REMOTE, now, now)
    .run();
  tokens.a = (await createApiToken(db, "a", 1, { agent: "agent-a" })).token;
  tokens.b = (await createApiToken(db, "b", 1, { agent: "Agent-B" })).token;
  tokens.reader = (await createApiToken(db, "r", 1, { agent: "reader", scope: "read" })).token;
  tokens.owner = (await createApiToken(db, "script", 1)).token;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${REMOTE}/info/refs`)) return new Response(advertisement);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await dispose();
});

type Text = { type: "text"; text: string };

async function connect(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(url.toString(), init as RequestInit, env),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Text[]).map((c) => c.text).join("\n");
    return { text, isError: !!r.isError, json: () => JSON.parse(text) };
  };
  return { client, call };
}

describe("MCP server", () => {
  test("needs a live API token", async () => {
    const res = await app.request(`${BASE}/mcp`, { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    const bad = await app.request(
      `${BASE}/mcp`,
      { method: "POST", body: "{}", headers: { authorization: "Bearer myc_nope" } },
      env,
    );
    expect(bad.status).toBe(401);
  });

  test("tools follow the token's scope; instructions name the agent", async () => {
    const write = await connect(tokens.a!);
    const names = (await write.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "comment_pull",
        "create_repo",
        "get_commit",
        "get_pull",
        "get_repo",
        "get_run",
        "git_credentials",
        "list_commits",
        "list_pulls",
        "list_refs",
        "list_repos",
        "list_runs",
        "list_workflows",
        "merge_pull",
        "open_pull",
        "read_file",
        "read_tree",
        "run_workflow",
      ].sort(),
    );
    expect(write.client.getInstructions()).toContain("`agent-a`");

    const read = await connect(tokens.reader!);
    const readNames = (await read.client.listTools()).tools.map((t) => t.name);
    for (const w of ["create_repo", "open_pull", "comment_pull", "merge_pull", "run_workflow"]) {
      expect(readNames).not.toContain(w);
    }
    expect(read.client.getInstructions()).toContain("read-only");
    // A read token gets read git credentials, never write ones.
    const denied = await read.call("git_credentials", { repo: "r", scope: "write" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("403");
    const ok = await read.call("git_credentials", { repo: "r" });
    expect(ok.text).toContain("scope: read");
    // And the REST API refuses its writes too.
    const post = await app.request(
      `${BASE}/api/repos/r/pulls`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.reader}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "x", head: "feat", base: "main" }),
      },
      env,
    );
    expect(post.status).toBe(403);
  });

  test("reads repos, refs and workflows", async () => {
    const { call } = await connect(tokens.a!);
    expect((await call("list_repos")).json().map((r: { name: string }) => r.name)).toEqual(["r"]);
    const repo = (await call("get_repo", { repo: "r" })).json();
    expect(repo.branches.map((b: { name: string }) => b.name)).toEqual(["main", "feat"]);
    const wfs = (await call("list_workflows", { repo: "r" })).json();
    expect(wfs.workflows.map((w: { name: string }) => w.name)).toEqual(["ci"]);
    const missing = await call("get_repo", { repo: "nope" });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain("404");
  });

  test("agents' pull requests, comments, runs and git credentials are attributed", async () => {
    const a = await connect(tokens.a!);
    const b = await connect(tokens.b!);

    const cred = await a.call("git_credentials", { repo: "r" });
    expect(cred.text).toContain("scope: write");
    expect(cred.text).toContain(
      'git -c http.extraHeader="Authorization: Bearer art_r_write?expires=3600" clone https://git.example/r.git r',
    );

    const pull = (await a.call("open_pull", { repo: "r", title: "Feat", head: "feat" })).json();
    expect(pull).toMatchObject({ number: 1, base: "main", author: "agent-a", authorKind: "agent" });
    expect(pull.url).toBe(`${BASE}/r/pulls/1`);

    const comment = (await b.call("comment_pull", { repo: "r", number: 1, body: "LGTM" })).json();
    expect(comment).toMatchObject({ author: "agent-b", authorKind: "agent" });

    const run = (await b.call("run_workflow", { repo: "r", workflow: "ci", ref: "feat" })).json();
    expect(run).toMatchObject({
      workflow: "ci",
      event: "manual",
      sha: SHA.feat,
      status: "queued",
      actor: { kind: "agent", name: "agent-b" },
    });
    expect(sent.length).toBeGreaterThan(0);
    const detail = (await a.call("get_run", { repo: "r", number: run.number })).json();
    expect(detail.steps).toEqual([expect.objectContaining({ name: "hi", status: "pending" })]);

    // get_pull: comments and checks (the diff needs the runner: an error here, unless mocked).
    const got = (await a.call("get_pull", { repo: "r", number: 1 })).json();
    expect(got.comments).toEqual([expect.objectContaining({ author: "agent-b", body: "LGTM" })]);
    expect(got.diff).toBeObject();
    expect(got.checks.map((c: { workflow: string }) => c.workflow)).toEqual(["ci"]);

    // Who minted git credentials, in the owner's API.
    const owner = await app.request(
      `${BASE}/api/repos/r/git-credentials`,
      { headers: { authorization: `Bearer ${tokens.owner}` } },
      env,
    );
    const { grants } = (await owner.json()) as { grants: { actor: object; scope: string }[] };
    expect(grants).toEqual([
      expect.objectContaining({ actor: { kind: "agent", name: "agent-a" }, scope: "write" }),
    ]);
  });

  test("the owner's own script token acts as the owner", async () => {
    const { call } = await connect(tokens.owner!);
    const pull = (await call("open_pull", { repo: "r", title: "Feat", head: "feat" })).json();
    expect(pull).toMatchObject({ author: "owner.test", authorKind: "owner" });
    // So does the browser session.
    const cookie = `mycelium_session=${await createWebSession(db, OWNER)}`;
    const res = await app.request(
      `${BASE}/api/repos/r/pulls/1/comments`,
      {
        method: "POST",
        headers: { cookie, origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ body: "hi" }),
      },
      env,
    );
    expect(await res.json()).toMatchObject({ author: "owner.test", authorKind: "owner" });
  });
});

describe("agent tokens", () => {
  test("names are checked and listed with their scope", async () => {
    const cookie = `mycelium_session=${await createWebSession(db, OWNER)}`;
    const post = (body: unknown) =>
      app.request(
        `${BASE}/api/tokens`,
        {
          method: "POST",
          headers: { cookie, origin: BASE, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        env,
      );
    expect((await post({ name: "x", days: 7, agent: "bad name" })).status).toBe(400);
    expect((await post({ name: "x", days: 7, scope: "admin" })).status).toBe(400);
    const created = await post({ name: "ci bot", days: 7, agent: "ci-bot", scope: "read" });
    expect(created.status).toBe(201);
    expect(((await created.json()) as any).apiToken).toMatchObject({
      agent: "ci-bot",
      scope: "read",
    });
    const list = (await (
      await app.request(`${BASE}/api/tokens`, { headers: { cookie } }, env)
    ).json()) as { tokens: { name: string; agent: string | null }[] };
    expect(list.tokens.find((t) => t.name === "script")).toMatchObject({ agent: null });
  });
});
