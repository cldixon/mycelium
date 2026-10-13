import type { Migration } from "./migrate.ts";

/**
 * Browser sessions: an opaque random token in a cookie, stored only as its
 * sha256 so a database leak doesn't leak live sessions. Separate from the
 * OAuth session, which holds the tokens for talking to the user's PDS.
 */

export const WEB_SESSION_MIGRATION: Migration = {
  name: "platform_0002_web_sessions",
  statements: [
    `CREATE TABLE web_sessions (
      token_hash TEXT PRIMARY KEY,
      did TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE INDEX web_sessions_by_did ON web_sessions (did)`,
  ],
};

export const WEB_SESSION_COOKIE = "mycelium_session";
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64url(new Uint8Array(digest));
}

export async function createWebSession(db: D1Database, did: string): Promise<string> {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").bind(now),
    db
      .prepare(
        "INSERT INTO web_sessions (token_hash, did, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .bind(await hashToken(token), did, now, now + WEB_SESSION_TTL_MS),
  ]);
  return token;
}

/** The DID a session token belongs to, or null if it is unknown or expired. */
export async function getWebSession(
  db: D1Database,
  token: string | undefined,
): Promise<string | null> {
  if (!token) return null;
  const row = await db
    .prepare("SELECT did FROM web_sessions WHERE token_hash = ? AND expires_at >= ?")
    .bind(await hashToken(token), Date.now())
    .first<{ did: string }>();
  return row?.did ?? null;
}

export async function deleteWebSession(db: D1Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db
    .prepare("DELETE FROM web_sessions WHERE token_hash = ?")
    .bind(await hashToken(token))
    .run();
}

export async function deleteWebSessionsFor(db: D1Database, did: string): Promise<void> {
  await db.prepare("DELETE FROM web_sessions WHERE did = ?").bind(did).run();
}

export function generateToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export { hashToken };
