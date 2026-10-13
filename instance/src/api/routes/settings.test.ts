import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebSession, setSetting } from "@mycelium/platform";
import { createTestD1 } from "@mycelium/platform/testing";
import { app } from "../app.js";
import { getDb } from "../../db/migrations.js";
import type { Bindings } from "../bindings.js";

const OWNER = "did:plc:ownerabcdefghijklmnopqrs";
const BASE = "http://mycelium.test";

let env: Bindings;
let cookie: string;
let dispose: () => Promise<void>;

beforeEach(async () => {
  const t = await createTestD1();
  dispose = t.dispose;
  const db = await getDb(t.db);
  env = { DB: t.db, INSTANCE_TITLE: "my forge" } as unknown as Bindings;
  await setSetting(db, "owner_did", OWNER);
  // A cached handle, so the test doesn't resolve the DID over the network.
  await setSetting(db, "owner_handle", "alice.test");
  await setSetting(db, "owner_handle_checked_at", new Date().toISOString());
  cookie = `mycelium_session=${await createWebSession(db, OWNER)}`;
});
afterEach(() => dispose());

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: string; anonymous?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
  else if (!opts.anonymous) Object.assign(headers, { cookie, origin: BASE });
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(
    `${BASE}${path}`,
    { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    env,
  );
  return { status: res.status, body: (await res.json()) as any };
}

describe("settings", () => {
  test("owner and instance facts, without the CF token itself", async () => {
    const { status, body } = await call("GET", "/api/settings");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      title: "my forge",
      owner: { did: OWNER },
      pushEvents: false,
    });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);

    env.CF_API_TOKEN = "cf-secret-value";
    const again = await call("GET", "/api/settings");
    expect(again.body.pushEvents).toBe(true);
    expect(JSON.stringify(again.body)).not.toContain("cf-secret-value");
  });

  test("visitors are turned away", async () => {
    expect((await call("GET", "/api/settings", { anonymous: true })).status).toBe(401);
    expect((await call("GET", "/api/tokens", { anonymous: true })).status).toBe(401);
    // Without a session (or from another origin) a change is refused before anything else.
    expect(
      (await call("POST", "/api/tokens", { anonymous: true, body: { name: "x", days: 1 } })).status,
    ).toBe(403);
  });
});

describe("API tokens", () => {
  test("create, list, use and revoke", async () => {
    const created = await call("POST", "/api/tokens", { body: { name: "laptop", days: 30 } });
    expect(created.status).toBe(201);
    const { token, apiToken } = created.body;
    expect(token).toStartWith("myc_");
    expect(apiToken).toMatchObject({ name: "laptop", lastUsedAt: null });

    const listed = await call("GET", "/api/tokens");
    expect(listed.body.tokens).toHaveLength(1);
    expect(listed.body.tokens[0].prefix).toBe(token.slice(0, 10));
    expect(JSON.stringify(listed.body)).not.toContain(token);

    // The token works for the owner API, and its use is recorded.
    expect((await call("GET", "/api/settings", { auth: token })).status).toBe(200);
    expect((await call("GET", "/api/tokens")).body.tokens[0].lastUsedAt).not.toBeNull();

    expect((await call("DELETE", `/api/tokens/${apiToken.id}`)).status).toBe(200);
    expect((await call("GET", "/api/tokens")).body.tokens).toHaveLength(0);
    expect((await call("GET", "/api/settings", { auth: token })).status).toBe(401);
    expect((await call("DELETE", `/api/tokens/${apiToken.id}`)).status).toBe(404);
  });

  test("bad names and lifetimes are refused", async () => {
    expect((await call("POST", "/api/tokens", { body: { name: " ", days: 30 } })).status).toBe(400);
    expect((await call("POST", "/api/tokens", { body: { name: "x", days: 0 } })).status).toBe(400);
    expect((await call("POST", "/api/tokens", { body: { name: "x", days: 9999 } })).status).toBe(
      400,
    );
  });

  test("a token can't create or revoke tokens", async () => {
    const { token, apiToken } = (
      await call("POST", "/api/tokens", { body: { name: "agent", days: 1 } })
    ).body;
    const auth = token as string;
    expect((await call("GET", "/api/tokens", { auth })).status).toBe(200);
    expect(
      (await call("POST", "/api/tokens", { auth, body: { name: "more", days: 365 } })).status,
    ).toBe(403);
    expect((await call("DELETE", `/api/tokens/${apiToken.id}`, { auth })).status).toBe(403);
  });

  test("browser changes must come from this origin", async () => {
    const res = await app.request(
      `${BASE}/api/tokens`,
      {
        method: "POST",
        headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ name: "x", days: 1 }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });
});
