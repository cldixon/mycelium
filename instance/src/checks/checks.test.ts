import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createWebSession, setSetting } from "@mycelium/platform";
import { createTestD1 } from "@mycelium/platform/testing";
import type { Bindings } from "../api/bindings.js";
import { getDb } from "../db/migrations.js";
import { deleteRepoRows } from "../git/artifacts.js";
import type { DiffResult, MergeResult } from "../shared/jobs.js";
import type { ChecksEvaluation, Refs, RunStatus } from "../shared/types.js";
import { evaluate, getRequired, setRequired } from "./index.js";

// The runner and smart HTTP are replaced; D1 is real (Miniflare).
const SHA = { main: "a".repeat(40), feat: "b".repeat(40), next: "d".repeat(40) };
let refs: Refs;
const merges: unknown[] = [];
mock.module("../pulls/git.js", () => ({
  repoRefs: async () => refs,
  diffJob: async () => ({}) as DiffResult,
  mergeJob: async (_env: unknown, _row: unknown, job: { headSha?: string }) => {
    merges.push(job);
    return {
      status: "merged",
      sha: "c".repeat(40),
      baseSha: SHA.main,
      headSha: job.headSha ?? SHA.feat,
    } satisfies MergeResult;
  },
}));
const { app } = await import("../api/app.js");

const OWNER = "did:plc:ownerabcdefghijklmnopqrs";
const BASE = "http://mycelium.test";
let env: Bindings;
let db: D1Database;
let cookie: string;
let dispose: () => Promise<void>;
let runNumber = 0;

beforeEach(async () => {
  const t = await createTestD1();
  dispose = t.dispose;
  db = await getDb(t.db);
  env = { DB: t.db, INSTANCE_TITLE: "mycelium" } as unknown as Bindings;
  await setSetting(db, "owner_did", OWNER);
  await setSetting(db, "owner_handle", "owner.test");
  await setSetting(db, "owner_handle_checked_at", new Date().toISOString());
  cookie = `mycelium_session=${await createWebSession(db, OWNER)}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO repos (name, visibility, remote, created_at, updated_at) VALUES ('r', 'private', 'https://git.example/r.git', ?, ?)",
    )
    .bind(now, now)
    .run();
  refs = {
    head: "main",
    branches: [
      { name: "main", sha: SHA.main },
      { name: "feat", sha: SHA.feat },
    ],
    tags: [],
  };
  merges.length = 0;
  runNumber = 0;
});
afterEach(() => dispose());

/** A run of `workflow` at `sha`; later calls get higher numbers. */
async function run(workflow: string, sha: string, status: RunStatus, event = "pull_request") {
  const number = ++runNumber;
  await db
    .prepare(
      `INSERT INTO runs (repo, number, workflow, event, ref, sha, status, created_at, started_at)
       VALUES ('r', ?, ?, ?, 'feat', ?, ?, ?, ?)`,
    )
    .bind(number, workflow, event, sha, status, new Date().toISOString(), new Date().toISOString())
    .run();
  return number;
}

const pull = (head_sha: string | null = SHA.feat) => ({ base: "main", head_sha });

describe("evaluate", () => {
  test("nothing required is satisfied", async () => {
    expect(await evaluate(env, "r", pull())).toEqual({
      sha: SHA.feat,
      required: [],
      satisfied: true,
    });
  });

  test("missing, pending, failed and successful checks", async () => {
    await setRequired(env, "r", "main", ["test", "lint", "build", "deploy", "test"]);
    expect(await getRequired(env, "r", "main")).toEqual(["build", "deploy", "lint", "test"]);
    expect(await getRequired(env, "r", "other")).toEqual([]);
    const t = await run("test", SHA.feat, "success", "push");
    const l = await run("lint", SHA.feat, "failure");
    const b = await run("build", SHA.feat, "running");
    await run("deploy", SHA.main, "success"); // another commit: doesn't count
    const e = await evaluate(env, "r", pull());
    expect(e.satisfied).toBe(false);
    expect(e.required).toEqual([
      { workflow: "build", status: "pending", runNumber: b },
      { workflow: "deploy", status: "missing" },
      { workflow: "lint", status: "failure", runNumber: l },
      { workflow: "test", status: "success", runNumber: t },
    ]);
  });

  test("queued is pending; error and cancelled are failures", async () => {
    await setRequired(env, "r", "main", ["a", "b", "c"]);
    await run("a", SHA.feat, "queued");
    await run("b", SHA.feat, "error");
    await run("c", SHA.feat, "cancelled");
    const statuses = (await evaluate(env, "r", pull())).required.map((r) => r.status);
    expect(statuses).toEqual(["pending", "failure", "failure"]);
  });

  test("the latest run wins", async () => {
    await setRequired(env, "r", "main", ["test"]);
    await run("test", SHA.feat, "failure");
    const rerun = await run("test", SHA.feat, "success");
    expect(await evaluate(env, "r", pull())).toMatchObject({
      satisfied: true,
      required: [{ workflow: "test", status: "success", runNumber: rerun }],
    });
    const again = await run("test", SHA.feat, "failure");
    expect(await evaluate(env, "r", pull())).toMatchObject({
      satisfied: false,
      required: [{ status: "failure", runNumber: again }],
    });
  });

  test("a new head sha needs new runs", async () => {
    await setRequired(env, "r", "main", ["test"]);
    await run("test", SHA.feat, "success");
    expect((await evaluate(env, "r", pull())).satisfied).toBe(true);
    const moved = await evaluate(env, "r", pull(SHA.next));
    expect(moved).toEqual({
      sha: SHA.next,
      required: [{ workflow: "test", status: "missing" }],
      satisfied: false,
    });
    expect((await evaluate(env, "r", pull(null))).satisfied).toBe(false);
  });

  test("an empty list clears; deleting the repo drops them", async () => {
    await setRequired(env, "r", "main", ["test"]);
    await setRequired(env, "r", "main", []);
    expect(await getRequired(env, "r", "main")).toEqual([]);
    await setRequired(env, "r", "main", ["test"]);
    await deleteRepoRows(db, "r");
    expect(await getRequired(env, "r", "main")).toEqual([]);
  });
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(
    `${BASE}/api/repos/r${path}`,
    {
      method,
      headers: { cookie, origin: BASE, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

describe("checks API and the merge gate", () => {
  test("required checks: read, set (owner), validate", async () => {
    expect(await json(call("GET", "/checks/required"))).toEqual({ branch: "main", workflows: [] });
    const put = await call("PUT", "/checks/required", {
      branch: "main",
      workflows: ["test", "lint"],
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toEqual({ branch: "main", workflows: ["lint", "test"] });
    expect(await json(call("GET", "/checks/required?branch=main"))).toEqual({
      branch: "main",
      workflows: ["lint", "test"],
    });
    expect((await call("PUT", "/checks/required", { branch: "main", workflows: "x" })).status).toBe(
      400,
    );
    expect((await call("PUT", "/checks/required", { branch: "..", workflows: [] })).status).toBe(
      400,
    );
    // not signed in: no reads of a private repo, no writes
    const anon = await app.request(`${BASE}/api/repos/r/checks/required`, {}, env);
    expect(anon.status).toBe(404);
    const anonPut = await app.request(
      `${BASE}/api/repos/r/checks/required`,
      {
        method: "PUT",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ branch: "main", workflows: [] }),
      },
      env,
    );
    expect(anonPut.status).toBe(401);
  });

  test("merge is refused with 409 until every required check passed on the head", async () => {
    expect(
      (await call("POST", "/pulls", { title: "Feat", head: "feat", base: "main" })).status,
    ).toBe(201);
    await call("PUT", "/checks/required", { branch: "main", workflows: ["test", "lint"] });

    const missing = await call("POST", "/pulls/1/merge", { method: "merge" });
    expect(missing.status).toBe(409);
    const body = await json<{ error: string; checks: ChecksEvaluation }>(missing);
    expect(body.error).toContain("not run: lint, test");
    expect(body.checks.satisfied).toBe(false);
    expect(merges).toHaveLength(0);

    await run("test", SHA.feat, "success");
    await run("lint", SHA.feat, "running");
    const pending = await json<{ error: string }>(call("POST", "/pulls/1/merge", {}));
    expect(pending.error).toContain("pending: lint");

    await run("lint", SHA.feat, "failure");
    const failing = await call("POST", "/pulls/1/merge", {});
    expect(failing.status).toBe(409);
    expect((await json<{ error: string }>(failing)).error).toContain("failing: lint");

    const lint = await run("lint", SHA.feat, "success");
    expect(await json(call("GET", "/pulls/1/checks"))).toEqual({
      sha: SHA.feat,
      required: [
        { workflow: "lint", status: "success", runNumber: lint },
        { workflow: "test", status: "success", runNumber: 1 },
      ],
      satisfied: true,
    });
    // A merge that names another head than the one the checks passed on is refused.
    expect((await call("POST", "/pulls/1/merge", { headSha: SHA.next })).status).toBe(409);
    expect(merges).toHaveLength(0);

    const merged = await call("POST", "/pulls/1/merge", { method: "merge" });
    expect(merged.status).toBe(200);
    expect(merges).toEqual([expect.objectContaining({ headSha: SHA.feat })]);
  });

  test("checks on another base branch don't gate this one", async () => {
    await call("POST", "/pulls", { title: "Feat", head: "feat", base: "main" });
    await call("PUT", "/checks/required", { branch: "release", workflows: ["test"] });
    expect((await call("POST", "/pulls/1/merge", {})).status).toBe(200);
  });

  test("run missing checks: workflows not at the head are unavailable", async () => {
    await call("POST", "/pulls", { title: "Feat", head: "feat", base: "main" });
    await call("PUT", "/checks/required", { branch: "main", workflows: ["test"] });
    await run("test", SHA.feat, "failure");
    // Nothing missing: nothing to start (and no workflow files need reading).
    const res = await json<{ started: unknown[]; unavailable: string[] }>(
      call("POST", "/pulls/1/checks/run"),
    );
    expect(res).toMatchObject({ started: [], unavailable: [] });
    expect((await call("POST", "/pulls/9/checks/run")).status).toBe(404);
  });
});
