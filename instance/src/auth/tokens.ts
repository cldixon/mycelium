import { generateToken, hashToken } from "@mycelium/platform";

/**
 * API tokens: let scripts and agents use the owner API (repos, pulls,
 * runs, git credentials) without a browser session. Each token is shown once, stored only
 * as its sha256, and always expires. Tokens can't create or revoke tokens.
 */

export type ApiToken = {
  id: string;
  name: string;
  /** The first characters, to tell tokens apart in a list. */
  prefix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

export const TOKEN_PREFIX = "myc_";
export const MAX_TOKEN_DAYS = 365;

type Row = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
};

const toToken = (r: Row): ApiToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
});

export class TokenError extends Error {}

export async function createApiToken(
  db: D1Database,
  name: string,
  days: number,
): Promise<{ token: string; apiToken: ApiToken }> {
  const label = name.trim();
  if (!label || label.length > 100)
    throw new TokenError("Give the token a name (up to 100 characters)");
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) {
    throw new TokenError(`Tokens last 1–${MAX_TOKEN_DAYS} days`);
  }
  const token = `${TOKEN_PREFIX}${generateToken(32)}`;
  const now = new Date();
  const row: Row = {
    id: crypto.randomUUID(),
    name: label,
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
    last_used_at: null,
  };
  await db
    .prepare(
      `INSERT INTO api_tokens (id, name, token_hash, prefix, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.name, await hashToken(token), row.prefix, row.created_at, row.expires_at)
    .run();
  return { token, apiToken: toToken(row) };
}

export async function listApiTokens(db: D1Database): Promise<ApiToken[]> {
  const { results } = await db
    .prepare(
      "SELECT id, name, prefix, created_at, expires_at, last_used_at FROM api_tokens ORDER BY created_at DESC",
    )
    .all<Row>();
  return results.map(toToken);
}

export async function revokeApiToken(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM api_tokens WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

/** True when `token` is a live API token; records its use. */
export async function verifyApiToken(db: D1Database, token: string | undefined): Promise<boolean> {
  if (!token?.startsWith(TOKEN_PREFIX)) return false;
  const now = new Date().toISOString();
  const result = await db
    .prepare("UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ? AND expires_at > ?")
    .bind(now, await hashToken(token), now)
    .run();
  return result.meta.changes > 0;
}

/** The token from an `Authorization: Bearer …` header, if any. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
}
