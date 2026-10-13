import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebSession, setSetting } from "@mycelium/platform";
import { createTestD1 } from "@mycelium/platform/testing";
import type { Bindings } from "../api/bindings.js";
import { getDb } from "../db/migrations.js";
import type { LiveMessage } from "../shared/live.js";
import { activityLimit, recentActivity } from "./activity.js";
import {
  deliver,
  mayReceive,
  OWNER_SOCKET_MAX_AGE_MS,
  REAUTHORIZE,
  type LiveSocket,
} from "./deliver.js";
import { OWNER_HEADER, publish, publishRun } from "./publish.js";

const { app } = await import("../api/app.js");

const msg = (over: Partial<LiveMessage> = {}): LiveMessage =>
  ({
    type: "pull",
    number: 1,
    action: "opened",
    repo: "r",
    at: "2026-10-13T00:00:00.000Z",
    private: false,
    ...over,
  }) as LiveMessage;

function socket(owner: boolean | null, opened = Date.now()) {
  const sent: string[] = [];
  const closed: number[] = [];
  const ws: LiveSocket = {
    info: owner === null ? null : { owner, opened },
    send: (m) => sent.push(m),
    close: (code) => closed.push(code),
  };
  return { ws, sent, closed };
}

describe("deliver", () => {
  test("private events reach only owner sockets", () => {
    const owner = socket(true);
    const visitor = socket(false);
    const unknown = socket(null);
    expect(deliver([owner.ws, visitor.ws, unknown.ws], msg({ private: true }))).toBe(1);
    expect(owner.sent).toHaveLength(1);
    expect(visitor.sent).toHaveLength(0);
    expect(unknown.sent).toHaveLength(0);
    expect(JSON.parse(owner.sent[0]!).private).toBe(true);
  });

  test("public events reach everyone", () => {
    const sockets = [socket(true), socket(false), socket(null)];
    expect(
      deliver(
        sockets.map((s) => s.ws),
        msg(),
      ),
    ).toBe(3);
    expect(mayReceive(null, { private: false })).toBe(true);
  });

  test("old owner sockets are asked to reconnect", () => {
    const now = Date.now();
    const old = socket(true, now - OWNER_SOCKET_MAX_AGE_MS - 1);
    const oldVisitor = socket(false, now - OWNER_SOCKET_MAX_AGE_MS - 1);
    deliver([old.ws, oldVisitor.ws], msg({ private: true }), now);
    expect(old.closed).toEqual([REAUTHORIZE]);
    expect(old.sent).toHaveLength(0);
    expect(oldVisitor.closed).toHaveLength(0);
  });

  test("a socket that throws doesn't stop the others", () => {
    const bad: LiveSocket = {
      info: { owner: true, opened: Date.now() },
      send: () => {
        throw new Error("closed");
      },
      close: () => {},
    };
    const good = socket(true);
    expect(deliver([bad, good.ws], msg())).toBe(1);
  });
});

/** A LIVE namespace that records what each hub was sent. */
function fakeLive(fail = false) {
  const sent: { hub: string; message: LiveMessage }[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      broadcast: async (message: LiveMessage) => {
        if (fail) throw new Error("hub down");
        sent.push({ hub: id, message });
        return 1;
      },
      fetch: async (req: Request) =>
        new Response(JSON.stringify({ hub: id, owner: req.headers.get(OWNER_HEADER) === "1" }), {
          status: 200,
        }),
    }),
  };
  return { ns: ns as unknown as Bindings["LIVE"], sent };
}

const OWNER = "did:plc:ownerabcdefghijklmnopqrs";
const BASE = "http://mycelium.test";
let env: Bindings;
let db: D1Database;
let cookie: string;
let dispose: () => Promise<void>;

async function addRepo(name: string, visibility: "public" | "private") {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO repos (name, visibility, remote, created_at, updated_at) VALUES (?, ?, 'https://git.example/x.git', ?, ?)",
    )
    .bind(name, visibility, now, now)
    .run();
}

beforeEach(async () => {
  const t = await createTestD1();
  dispose = t.dispose;
  db = await getDb(t.db);
  env = { DB: t.db, INSTANCE_TITLE: "mycelium" } as unknown as Bindings;
  await setSetting(db, "owner_did", OWNER);
  await setSetting(db, "owner_handle", "owner.test");
  await setSetting(db, "owner_handle_checked_at", new Date().toISOString());
  cookie = `mycelium_session=${await createWebSession(db, OWNER)}`;
  await addRepo("priv", "private");
  await addRepo("pub", "public");
});
afterEach(() => dispose());

describe("publish", () => {
  test("goes to the repo's hub and the instance's, with the repo's visibility", async () => {
    const live = fakeLive();
    env.LIVE = live.ns;
    await publish(env, "priv", { type: "repo", action: "updated" });
    await publish(env, "pub", {
      type: "push",
      ref: "refs/heads/main",
      before: null,
      after: "a",
      count: 2,
    });
    expect(live.sent.map((s) => s.hub).sort()).toEqual([
      "instance",
      "instance",
      "repo:priv",
      "repo:pub",
    ]);
    const priv = live.sent.find((s) => s.hub === "repo:priv")!.message;
    expect(priv).toMatchObject({ type: "repo", action: "updated", repo: "priv", private: true });
    const pub = live.sent.find((s) => s.hub === "repo:pub")!.message;
    expect(pub).toMatchObject({ type: "push", count: 2, private: false });
  });

  test("an unknown repo counts as private; an explicit visibility wins", async () => {
    const live = fakeLive();
    env.LIVE = live.ns;
    await publish(env, "gone", { type: "repo", action: "deleted" });
    await publish(env, "gone2", { type: "repo", action: "deleted" }, "public");
    expect(live.sent.find((s) => s.hub === "repo:gone")!.message.private).toBe(true);
    expect(live.sent.find((s) => s.hub === "repo:gone2")!.message.private).toBe(false);
  });

  test("never throws: no binding, or a hub that fails", async () => {
    await publish(env, "pub", { type: "repo", action: "updated" });
    env.LIVE = fakeLive(true).ns;
    await publishRun(env, { repo: "pub", number: 1, workflow: "test" }, "running", {
      idx: 0,
      status: "running",
    });
  });
});

describe("routes", () => {
  const ws = { upgrade: "websocket" };
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, { headers }, env);

  test("sockets need an upgrade", async () => {
    env.LIVE = fakeLive().ns;
    expect((await get("/api/live")).status).toBe(426);
  });

  test("a private repo's feed is the owner's alone", async () => {
    env.LIVE = fakeLive().ns;
    expect((await get("/api/repos/priv/live", ws)).status).toBe(404);
    expect((await get("/api/repos/nope/live", { ...ws, cookie })).status).toBe(404);
    const owner = await get("/api/repos/priv/live", { ...ws, cookie, origin: BASE });
    expect(await owner.json()).toEqual({ hub: "repo:priv", owner: true });
    const visitor = await get("/api/repos/pub/live", ws);
    expect(await visitor.json()).toEqual({ hub: "repo:pub", owner: false });
  });

  test("the instance feed marks owner sockets; a forged header or another origin isn't owner", async () => {
    env.LIVE = fakeLive().ns;
    const owner = await get("/api/live", { ...ws, cookie, origin: BASE });
    expect(await owner.json()).toEqual({ hub: "instance", owner: true });
    const forged = await get("/api/live", { ...ws, [OWNER_HEADER]: "1" });
    expect(await forged.json()).toEqual({ hub: "instance", owner: false });
    const elsewhere = await get("/api/live", { ...ws, cookie, origin: "https://evil.test" });
    expect(await elsewhere.json()).toEqual({ hub: "instance", owner: false });
    expect(
      (await get("/api/repos/priv/live", { ...ws, cookie, origin: "https://evil.test" })).status,
    ).toBe(404);
  });

  test("activity hides private repos from visitors", async () => {
    const now = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO pushes (repo, ref, before, after, commits, at) VALUES ('priv', 'refs/heads/main', NULL, 'a', '[{},{}]', ?)",
        )
        .bind(now),
      db
        .prepare(
          "INSERT INTO pushes (repo, ref, before, after, commits, at) VALUES ('pub', 'refs/heads/main', NULL, 'b', '[{}]', ?)",
        )
        .bind(now),
    ]);
    const anon = (await (await get("/api/activity")).json()) as { items: { repo: string }[] };
    expect(anon.items.map((i) => i.repo)).toEqual(["pub"]);
    const owner = (await (await get("/api/activity", { cookie })).json()) as {
      items: { repo: string }[];
    };
    expect(owner.items.map((i) => i.repo).sort()).toEqual(["priv", "pub"]);
    expect((await get("/api/activity?repo=priv")).status).toBe(404);
  });
});

describe("recentActivity", () => {
  test("merges pushes, pull events and runs, newest first", async () => {
    const t = (m: number) => new Date(Date.UTC(2026, 9, 13, 12, m)).toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO pushes (repo, ref, before, after, commits, at) VALUES ('pub', 'refs/heads/main', NULL, 'a', '[{},{},{}]', ?)",
        )
        .bind(t(1)),
      db
        .prepare(
          `INSERT INTO pulls (repo, number, title, head, base, state, author, created_at, updated_at, closed_at, merged_at)
           VALUES ('pub', 1, 'Feature', 'feat', 'main', 'merged', 'me', ?1, ?2, ?2, ?2)`,
        )
        .bind(t(2), t(4)),
      db
        .prepare(
          "INSERT INTO pull_comments (pull_id, author, body, created_at) SELECT id, 'me', 'hi', ? FROM pulls WHERE number = 1",
        )
        .bind(t(3)),
      db
        .prepare(
          `INSERT INTO runs (repo, number, workflow, event, ref, sha, status, created_at, started_at)
           VALUES ('pub', 1, 'test', 'push', 'main', 'a', 'running', ?, ?)`,
        )
        .bind(t(5), t(6)),
      db
        .prepare(
          `INSERT INTO runs (repo, number, workflow, event, ref, sha, status, created_at)
           VALUES ('priv', 1, 'test', 'push', 'main', 'a', 'queued', ?)`,
        )
        .bind(t(7)),
    ]);
    const items = await recentActivity(db, { owner: false, limit: 10 });
    expect(items.map((i) => [i.kind, "action" in i ? i.action : "", i.at])).toEqual([
      ["run", "", t(6)],
      ["pull", "merged", t(4)],
      ["pull", "commented", t(3)],
      ["pull", "opened", t(2)],
      ["push", "", t(1)],
    ]);
    expect(items.at(-1)).toMatchObject({ kind: "push", count: 3 });
    const all = await recentActivity(db, { owner: true, limit: 2 });
    expect(all.map((i) => i.repo)).toEqual(["priv", "pub"]);
    const one = await recentActivity(db, { owner: true, limit: 10, repo: "priv" });
    expect(one).toHaveLength(1);
  });

  test("limit parsing", () => {
    expect(activityLimit(undefined)).toBe(50);
    expect(activityLimit("0")).toBe(50);
    expect(activityLimit("5")).toBe(5);
    expect(activityLimit("9999")).toBe(200);
  });
});
