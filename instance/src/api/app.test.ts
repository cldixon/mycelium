import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebSession, setSetting } from "@mycelium/platform";
import { createTestD1 } from "@mycelium/platform/testing";
import { app } from "./app.js";
import { getDb } from "../db/migrations.js";
import { createApiToken } from "../auth/tokens.js";
import { handleEvent } from "../queue.js";
import type { Bindings } from "./bindings.js";

const OWNER = "did:plc:ownerabcdefghijklmnopqrs";
const BASE = "http://mycelium.test";

let env: Bindings;
let db: D1Database;
let cookie: string;
let dispose: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestD1();
  dispose = t.dispose;
  db = await getDb(t.db);
  env = {
    DB: t.db,
    INSTANCE_TITLE: "mycelium",
    ASSETS: { fetch: async () => new Response("spa") },
  } as unknown as Bindings;
  await setSetting(db, "owner_did", OWNER);
  cookie = `mycelium_session=${await createWebSession(db, OWNER)}`;
  const now = new Date().toISOString();
  for (const [name, visibility] of [
    ["secret", "private"],
    ["open", "public"],
  ]) {
    await db
      .prepare(
        "INSERT INTO repos (name, visibility, remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(name, visibility, `https://git.example/${name}.git`, now, now)
      .run();
  }
});
afterEach(() => dispose());

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${BASE}${path}`, { headers }, env);

describe("app", () => {
  test("health and the SPA fallback", async () => {
    expect(await (await get("/health")).json()).toEqual({ status: "ok" });
    expect(await (await get("/some/page")).text()).toBe("spa");
    expect((await get("/api/nope")).status).toBe(404);
  });

  test("everyone sees public repos; the owner sees all", async () => {
    const names = async (headers?: Record<string, string>) =>
      ((await (await get("/api/repos", headers)).json()) as any).repos.map((r: any) => r.name);
    expect(await names()).toEqual(["open"]);
    expect((await names({ cookie })).sort()).toEqual(["open", "secret"]);
    const { token } = await createApiToken(db, "agent", 1);
    expect(token).toStartWith("myc_");
    expect((await names({ authorization: `Bearer ${token}` })).sort()).toEqual(["open", "secret"]);
  });

  test("private repos are 404 to everyone but the owner", async () => {
    expect((await get("/api/repos/secret/pulls")).status).toBe(404);
    expect((await get("/api/repos/secret/pulls", { cookie })).status).toBe(200);
    expect((await get("/api/repos/open/runs")).status).toBe(200);
    expect((await get("/api/repos/missing/runs", { cookie })).status).toBe(404);
  });

  test("tokens need the owner", async () => {
    expect((await get("/api/tokens")).status).toBe(401);
    expect((await get("/api/tokens", { cookie })).status).toBe(200);
  });

  test("auth status", async () => {
    const status = (await (await get("/api/auth/status", { cookie })).json()) as any;
    expect(status).toMatchObject({ claimed: true, owner: OWNER, signedIn: true });
  });
});

describe("push events", () => {
  test("are stored once per repo and after sha", async () => {
    const event = {
      type: "cf.artifacts.repo.pushed",
      source: { type: "artifacts.repo", repoName: "open" },
      payload: {
        ref: "refs/heads/main",
        before: "a".repeat(40),
        after: "b".repeat(40),
        commits: [
          {
            id: "b".repeat(40),
            message: "Second",
            timestamp: "2026-10-13T00:00:00Z",
            author: { name: "A", email: "a@example.com" },
          },
        ],
      },
      metadata: { eventTimestamp: "2026-10-13T00:00:01Z" },
    };
    const first = await handleEvent(env, event);
    expect(first).toMatchObject({ repo: "open", ref: "refs/heads/main", after: "b".repeat(40) });
    expect(await handleEvent(env, event)).toBeNull();
    const { results } = await db.prepare("SELECT * FROM pushes").all();
    expect(results).toHaveLength(1);
    expect(await handleEvent(env, { ...event, type: "cf.artifacts.repo.cloned" })).toBeNull();
  });
});
