import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate } from "./migrate.ts";
import { createTestD1 } from "./testing.ts";
import {
  WEB_SESSION_MIGRATION,
  createWebSession,
  deleteWebSession,
  getWebSession,
} from "./web-sessions.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestD1());
  await migrate(db, [WEB_SESSION_MIGRATION]);
});
afterEach(() => dispose());

test("a session token maps to its DID until deleted", async () => {
  const token = await createWebSession(db, "did:plc:x");
  expect(await getWebSession(db, token)).toBe("did:plc:x");
  expect(await getWebSession(db, "wrong")).toBeNull();
  expect(await getWebSession(db, undefined)).toBeNull();
  await deleteWebSession(db, token);
  expect(await getWebSession(db, token)).toBeNull();
});

test("the token itself is never stored", async () => {
  const token = await createWebSession(db, "did:plc:x");
  const { results } = await db.prepare("SELECT * FROM web_sessions").all();
  expect(JSON.stringify(results)).not.toContain(token);
});

test("expired sessions are rejected", async () => {
  const token = await createWebSession(db, "did:plc:x");
  await db.prepare("UPDATE web_sessions SET expires_at = 0").run();
  expect(await getWebSession(db, token)).toBeNull();
});
