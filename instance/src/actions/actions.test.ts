import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebSession, setSetting } from "@mycelium/platform";
import { createTestD1 } from "@mycelium/platform/testing";
import { app } from "../api/app.js";
import type { Bindings } from "../api/bindings.js";
import { getDb } from "../db/migrations.js";
import { applyResult, runWorkflow, tailLog } from "../jobs/workflow.js";
import type { Workflow } from "../shared/types.js";
import { readWorkflows, type TreeReader } from "./load.js";
import { parseWorkflow, runsOn, WorkflowParseError } from "./parse.js";
import { createRuns, pushedBranch, triggerPushRuns, workflowsFor } from "./triggers.js";

const P = ".mycelium/workflows/test.yml";

describe("parseWorkflow", () => {
  test("the documented shape", () => {
    const wf = parseWorkflow(
      P,
      `name: test
on: [push, pull_request]
steps:
  - name: Install
    run: bun install
  - name: Test
    run: bun test
    timeout-minutes: 2
`,
    );
    expect(wf).toEqual({
      path: P,
      name: "test",
      on: ["push", "pull_request"],
      steps: [
        { name: "Install", run: "bun install" },
        { name: "Test", run: "bun test", timeoutSec: 120 },
      ],
      timeoutSec: 600,
    });
  });

  test("defaults: name from the file, on as a string, step name from the command", () => {
    const wf = parseWorkflow(
      ".mycelium/workflows/lint.yaml",
      "on: push\ntimeout-minutes: 0.5\nsteps:\n  - run: |\n      echo one\n      echo two\n  - echo three\n",
    );
    expect(wf.name).toBe("lint");
    expect(wf.on).toEqual(["push"]);
    expect(wf.timeoutSec).toBe(30);
    expect(wf.steps.map((s) => s.name)).toEqual(["echo one", "echo three"]);
  });

  test("timeouts are capped at 10 minutes", () => {
    const wf = parseWorkflow(P, "on: manual\ntimeout-minutes: 60\nsteps: [{run: x}]");
    expect(wf.timeoutSec).toBe(600);
  });

  const bad: [string, string][] = [
    ["steps: [{run: x}]", 'missing "on"'],
    ["on: deploy\nsteps: [{run: x}]", 'unknown event "deploy"'],
    ["on: []\nsteps: [{run: x}]", '"on" must be'],
    ["on: push", '"steps" must be a non-empty list'],
    ["on: push\nsteps: []", '"steps" must be a non-empty list'],
    ["on: push\nsteps: [{name: x}]", 'steps[0]: "run" must be'],
    ["on: push\nsteps: [{run: x, uses: y}]", 'steps[0]: unknown key "uses"'],
    ["on: push\njobs: {}\nsteps: [{run: x}]", 'unknown key "jobs"'],
    ["on: push\nsteps: [{run: x, timeout-minutes: -1}]", "timeout-minutes must be"],
    ["- just\n- a list", "expected a mapping"],
    ["on: [push\nsteps: x", "invalid YAML"],
    ["on: push\non: manual\nsteps: [{run: x}]", "invalid YAML"],
  ];
  for (const [text, message] of bad) {
    test(`rejects: ${message}`, () => {
      expect(() => parseWorkflow(P, text)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(P, text)).toThrow(message);
    });
  }
});

describe("trigger matching", () => {
  const wf = (name: string, on: Workflow["on"]): Workflow => ({
    path: `.mycelium/workflows/${name}.yml`,
    name,
    on,
    steps: [{ name: "x", run: "x" }],
    timeoutSec: 600,
  });
  const all = [wf("ci", ["push", "pull_request"]), wf("pr", ["pull_request"]), wf("m", ["manual"])];

  test("events pick workflows; manual is always allowed", () => {
    expect(workflowsFor(all, "push").map((w) => w.name)).toEqual(["ci"]);
    expect(workflowsFor(all, "pull_request").map((w) => w.name)).toEqual(["ci", "pr"]);
    expect(workflowsFor(all, "manual").map((w) => w.name)).toEqual(["ci", "pr", "m"]);
    expect(runsOn({ on: ["push"] }, "manual")).toBe(true);
  });

  test("only branch pushes with a new head start runs", () => {
    expect(pushedBranch({ ref: "refs/heads/feat/x", after: "a".repeat(40) })).toBe("feat/x");
    expect(pushedBranch({ ref: "refs/heads/main", after: "0".repeat(40) })).toBeNull();
    expect(pushedBranch({ ref: "refs/heads/main", after: null })).toBeNull();
    expect(pushedBranch({ ref: "refs/tags/v1", after: "a".repeat(40) })).toBeNull();
  });
});

/** A fake repo: path → text, as one commit. */
function fakeRepo(files: Record<string, string>): TreeReader {
  // Trees and blobs are keyed by path; "commit" points at the root tree "".
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const tree = (path: string) => {
    if (!trees.has(path)) trees.set(path, []);
    return trees.get(path)!;
  };
  tree("");
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const self = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;
      const entries = tree(parent);
      if (!entries.some((e) => e.name === parts[i])) {
        entries.push({
          name: parts[i]!,
          mode: isFile ? "100644" : "40000",
          hash: self,
          type: isFile ? "blob" : "tree",
        });
      }
      if (!isFile) tree(self);
    }
  }
  return {
    readCommit: async (sha: string) =>
      sha === "c".repeat(40) ? ({ treeHash: "" } as ArtifactsCommitMetadata) : null,
    readTree: async (hash: string) => trees.get(hash) ?? null,
    readBlob: async (hash: string) => (hash in files ? new Blob([files[hash]!]) : null),
  };
}

describe("readWorkflows", () => {
  const sha = "c".repeat(40);
  test("reads .yml and .yaml files, reports bad ones and duplicate names", async () => {
    const repo = fakeRepo({
      "README.md": "hi",
      ".mycelium/workflows/a.yml": "on: push\nsteps: [{run: echo a}]",
      ".mycelium/workflows/b.yaml": "name: a\non: push\nsteps: [{run: echo b}]",
      ".mycelium/workflows/c.yml": "on: nope\nsteps: [{run: x}]",
      ".mycelium/workflows/notes.txt": "ignored",
    });
    const { workflows, errors } = await readWorkflows(repo, sha);
    expect(workflows.map((w) => w.path)).toEqual([".mycelium/workflows/a.yml"]);
    expect(errors).toEqual([
      {
        path: ".mycelium/workflows/b.yaml",
        error: 'name "a" is already used by .mycelium/workflows/a.yml',
      },
      {
        path: ".mycelium/workflows/c.yml",
        error: 'unknown event "nope" in "on" (use push, pull_request or manual)',
      },
    ]);
  });

  test("no workflow directory, no workflows", async () => {
    expect(await readWorkflows(fakeRepo({ "x.txt": "x" }), sha)).toEqual({
      workflows: [],
      errors: [],
    });
    await expect(readWorkflows(fakeRepo({}), "d".repeat(40))).rejects.toThrow("no commit");
  });
});

describe("run results", () => {
  test("tailLog keeps the end", () => {
    expect(tailLog("short")).toBe("short");
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const t = tailLog(long, 100);
    expect(t).toStartWith("[mycelium:");
    expect(t).toEndWith("line 999");
    expect(t.length).toBeLessThan(160);
  });

  test("applyResult marks failures and skips the rest", () => {
    const steps = [{ idx: 0 }, { idx: 1 }, { idx: 2 }];
    const r = applyResult(
      steps,
      {
        status: "failure",
        steps: [
          { exitCode: 0, log: "ok\n", durationMs: 10 },
          { exitCode: null, log: "zz", durationMs: 1000, timedOut: true },
        ],
      },
      Date.parse("2026-01-01T00:00:00Z"),
    );
    expect(r.status).toBe("failure");
    expect(r.steps.map((s) => s.status)).toEqual(["success", "failure", "skipped"]);
    expect(r.steps[1]!.log).toBe("zz\n[mycelium: step timed out after 1 s]\n");
    expect(r.steps[1]!.startedAt).toBe("2026-01-01T00:00:00.010Z");
  });

  test("applyResult puts infrastructure errors on the first step", () => {
    const r = applyResult(
      [{ idx: 0 }, { idx: 1 }],
      { status: "error", steps: [], error: "boom" },
      0,
    );
    expect(r.steps.map((s) => s.status)).toEqual(["error", "skipped"]);
    expect(r.steps[0]!.log).toContain("boom");
  });
});

describe("runs in D1", () => {
  const OWNER = "did:plc:ownerabcdefghijklmnopqrs";
  let env: Bindings;
  let db: D1Database;
  let sent: unknown[];
  let cookie: string;
  let dispose: () => Promise<void>;
  const sha = "c".repeat(40);
  const files = {
    ".mycelium/workflows/ci.yml":
      "on: [push]\nsteps:\n  - {name: one, run: echo 1}\n  - {name: two, run: echo 2}",
    ".mycelium/workflows/manual.yml": "on: manual\nsteps: [{run: echo m}]",
  };

  beforeEach(async () => {
    const t = await createTestD1();
    dispose = t.dispose;
    db = await getDb(t.db);
    sent = [];
    const repo = fakeRepo(files);
    env = {
      DB: t.db,
      INSTANCE_TITLE: "mycelium",
      JOBS: { send: async (m: unknown) => void sent.push(m) },
      ARTIFACTS: { get: async () => ({ ...repo, [Symbol.dispose]: () => {} }) },
      ASSETS: { fetch: async () => new Response("spa") },
    } as unknown as Bindings;
    await setSetting(db, "owner_did", OWNER);
    cookie = `mycelium_session=${await createWebSession(db, OWNER)}`;
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO repos (name, visibility, remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind("demo", "private", "https://git.example/demo.git", now, now)
      .run();
  });
  afterEach(() => dispose());

  test("a push creates queued runs with steps and queues them", async () => {
    const push = {
      id: 1,
      repo: "demo",
      ref: "refs/heads/main",
      before: null,
      after: sha,
      commits: [],
      at: "",
    };
    const created = await triggerPushRuns(env, "demo", push);
    expect(created.map((r) => [r.number, r.workflow])).toEqual([[1, "ci"]]);
    expect(sent).toEqual([{ runId: created[0]!.id }]);
    const steps = await db
      .prepare("SELECT idx, name, command, status FROM run_steps ORDER BY idx")
      .all();
    expect(steps.results).toEqual([
      { idx: 0, name: "one", command: "echo 1", status: "pending" },
      { idx: 1, name: "two", command: "echo 2", status: "pending" },
    ]);
    // Tag pushes don't run anything.
    expect(await triggerPushRuns(env, "demo", { ...push, ref: "refs/tags/v1" })).toEqual([]);

    // Listing and detail (private repo: owner only).
    const res = await app.request(
      "http://x/api/repos/demo/runs?sha=" + sha,
      { headers: { cookie } },
      env,
    );
    const { runs } = (await res.json()) as { runs: any[] };
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      number: 1,
      workflow: "ci",
      event: "push",
      ref: "main",
      status: "queued",
    });
    expect((await app.request("http://x/api/repos/demo/runs", {}, env)).status).toBe(404);
    const detail = (await (
      await app.request("http://x/api/repos/demo/runs/1", { headers: { cookie } }, env)
    ).json()) as any;
    expect(detail.steps.map((s: any) => s.name)).toEqual(["one", "two"]);
  });

  test("runWorkflow skips runs that aren't queued (redelivery)", async () => {
    const [run] = await createRuns(env, "demo", [parseWorkflow(P, "on: push\nsteps: [{run: x}]")], {
      event: "manual",
      ref: "main",
      sha,
    });
    await db.prepare("UPDATE runs SET status = 'success' WHERE id = ?").bind(run!.id).run();
    await runWorkflow(env, run!.id); // no RUNNER binding: would throw if it tried to run
    const row = await db.prepare("SELECT status FROM runs WHERE id = ?").bind(run!.id).first();
    expect(row).toEqual({ status: "success" });
  });

  test("a runner failure ends the run as error, not a retry", async () => {
    const [run] = await createRuns(
      env,
      "demo",
      [parseWorkflow(P, "on: push\nsteps: [{run: x}, {run: y}]")],
      {
        event: "manual",
        ref: "main",
        sha,
      },
    );
    // No RUNNER and a token-less ARTIFACTS: execute() throws inside.
    await runWorkflow(env, run!.id);
    const row = await db
      .prepare("SELECT status, started_at, finished_at FROM runs WHERE id = ?")
      .bind(run!.id)
      .first<any>();
    expect(row.status).toBe("error");
    expect(row.finished_at).not.toBeNull();
    const steps = await db
      .prepare("SELECT status FROM run_steps WHERE run_id = ? ORDER BY idx")
      .bind(run!.id)
      .all();
    expect(steps.results.map((s: any) => s.status)).toEqual(["error", "skipped"]);
  });
});
