import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createWebSession, setSetting } from "@mycelium/platform";
import { createTestD1 } from "@mycelium/platform/testing";
import type { Bindings } from "../api/bindings.js";
import { getDb } from "../db/migrations.js";
import type { DiffResult, MergeResult } from "../shared/jobs.js";
import type { Pull, Refs } from "../shared/types.js";

// The runner and smart HTTP are replaced; D1 is real (Miniflare).
const SHA = { main: "a".repeat(40), feat: "b".repeat(40), merged: "c".repeat(40) };
let refs: Refs;
let mergeResult: MergeResult;
const calls: { kind: string; args: unknown[] }[] = [];
mock.module("./git.js", () => ({
  repoRefs: async () => refs,
  diffJob: async (...args: unknown[]) => {
    calls.push({ kind: "diff", args: args.slice(2) });
    return {
      mergeBase: SHA.main,
      ahead: 1,
      behind: 0,
      mergeable: true,
      conflicts: [],
      baseSha: SHA.main,
      headSha: SHA.feat,
      files: [],
      truncated: false,
      commits: [],
    } satisfies DiffResult;
  },
  mergeJob: async (...args: unknown[]) => {
    calls.push({ kind: "merge", args: args.slice(2) });
    return mergeResult;
  },
}));
const { app } = await import("../api/app.js");
const { handleEvent } = await import("../queue.js");

const OWNER = "did:plc:ownerabcdefghijklmnopqrs";
const BASE = "http://mycelium.test";
let env: Bindings;
let cookie: string;
let dispose: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestD1();
  dispose = t.dispose;
  const db = await getDb(t.db);
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
  mergeResult = { status: "merged", sha: SHA.merged, baseSha: SHA.main, headSha: SHA.feat };
  calls.length = 0;
});
afterEach(() => dispose());

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

describe("pull requests API", () => {
  test("open, list, read, comment, close and reopen", async () => {
    expect((await call("POST", "/pulls", { title: "x", head: "nope", base: "main" })).status).toBe(
      400,
    );
    expect((await call("POST", "/pulls", { title: "x", head: "main", base: "main" })).status).toBe(
      400,
    );
    const created = await call("POST", "/pulls", {
      title: "Feat",
      body: "b",
      head: "feat",
      base: "main",
    });
    expect(created.status).toBe(201);
    const pull = await json<Pull>(created);
    expect(pull).toMatchObject({
      number: 1,
      state: "open",
      author: "owner.test",
      headSha: SHA.feat,
    });
    expect(
      (await call("POST", "/pulls", { title: "Again", head: "feat", base: "main" })).status,
    ).toBe(409);

    const list = await json<{ pulls: Pull[]; counts: object }>(call("GET", "/pulls"));
    expect(list.pulls.map((p) => p.number)).toEqual([1]);
    expect(list.counts).toEqual({ open: 1, closed: 0 });
    expect((await call("GET", "/pulls/1")).status).toBe(200);
    expect((await call("GET", "/pulls/9")).status).toBe(404);
    // private repo: anonymous readers get 404
    expect((await app.request(`${BASE}/api/repos/r/pulls`, {}, env)).status).toBe(404);

    expect((await call("POST", "/pulls/1/comments", { body: "LGTM" })).status).toBe(201);
    const { comments } = await json<{ comments: { author: string; body: string }[] }>(
      call("GET", "/pulls/1/comments"),
    );
    expect(comments).toEqual([expect.objectContaining({ author: "owner.test", body: "LGTM" })]);

    const closed = await json<Pull>(
      call("PATCH", "/pulls/1", { state: "closed", title: "Feat 2" }),
    );
    expect(closed).toMatchObject({ state: "closed", title: "Feat 2" });
    expect(closed.closedAt).not.toBeNull();
    expect(await json(call("GET", "/pulls?state=closed"))).toMatchObject({
      counts: { open: 0, closed: 1 },
    });
    const reopened = await json<Pull>(call("PATCH", "/pulls/1", { state: "open" }));
    expect(reopened).toMatchObject({ state: "open", closedAt: null });
  });

  test("writes need the owner", async () => {
    const anon = (method: string, path: string, body: unknown) =>
      app.request(
        `${BASE}/api/repos/r${path}`,
        { method, body: JSON.stringify(body), headers: { origin: BASE } },
        env,
      );
    expect((await anon("POST", "/pulls", { title: "x", head: "feat", base: "main" })).status).toBe(
      401,
    );
  });

  test("diff refreshes shas; merge records the result; conflicts change nothing", async () => {
    await call("POST", "/pulls", { title: "Feat", head: "feat", base: "main" });
    const db = await getDb(env.DB);
    await db.prepare("UPDATE pulls SET head_sha = NULL").run();
    expect(await json(call("GET", "/pulls/1/diff"))).toMatchObject({ mergeable: true });
    expect(calls[0]!.args).toEqual(["main", "feat"]);
    expect(await json(call("GET", "/pulls/1"))).toMatchObject({ headSha: SHA.feat });

    mergeResult = { status: "conflict", files: ["a.txt"], diff: "<<<<<<<" };
    const conflict = await call("POST", "/pulls/1/merge", { method: "squash" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ status: "conflict", files: ["a.txt"] });
    expect(await json(call("GET", "/pulls/1"))).toMatchObject({ state: "open" });
    expect((await call("POST", "/pulls/1/merge", { method: "ff" })).status).toBe(400);

    mergeResult = { status: "merged", sha: SHA.merged, baseSha: SHA.main, headSha: SHA.feat };
    const merged = await json<Pull>(call("POST", "/pulls/1/merge", { method: "squash" }));
    expect(merged).toMatchObject({ state: "merged", mergeSha: SHA.merged, mergeMethod: "squash" });
    const job = calls.at(-1)!.args[0] as { message: string; author: { email: string } };
    expect(job.message).toBe("Feat (#1)");
    expect(job.author.email).toBe("owner.test@mycelium.test");
    expect((await call("POST", "/pulls/1/merge", {})).status).toBe(409);
    // a merged PR diffs by its recorded shas
    await call("GET", "/pulls/1/diff");
    expect(calls.at(-1)!.args).toEqual([SHA.main, SHA.feat]);
    expect((await call("PATCH", "/pulls/1", { state: "open" })).status).toBe(400);
  });

  test("pushes move head/base shas and deleting head closes", async () => {
    await call("POST", "/pulls", { title: "Feat", head: "feat", base: "main" });
    const push = (ref: string, after: string) =>
      handleEvent(env, {
        type: "cf.artifacts.repo.pushed",
        source: { type: "artifacts.repo", repoName: "r" },
        payload: { ref, before: "x", after, commits: [] },
        metadata: { eventTimestamp: new Date().toISOString() },
      });
    await push("refs/heads/feat", "d".repeat(40));
    await push("refs/heads/main", "e".repeat(40));
    expect(await json(call("GET", "/pulls/1"))).toMatchObject({
      headSha: "d".repeat(40),
      baseSha: "e".repeat(40),
      state: "open",
    });
    await push("refs/heads/feat", "0".repeat(40));
    expect(await json(call("GET", "/pulls/1"))).toMatchObject({ state: "closed" });
  });
});
