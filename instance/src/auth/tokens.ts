import { generateToken, hashToken } from "@mycelium/platform";

/**
 * API tokens: let scripts and agents use the owner API (repos, pulls,
 * runs, git credentials) without a browser session. Each token is shown once, stored only
 * as its sha256, and always expires. Tokens can't create or revoke tokens.
 *
 * A token may name an agent: it then acts as that agent, and what it does
 * (pull requests, comments, manual runs, git credentials) is attributed to it.
 * A `read` token only reads.
 */

export type TokenScope = "read" | "write";

export type ApiToken = {
  id: string;
  name: string;
  /** The agent this token acts as; null for the owner's own scripts. */
  agent: string | null;
  /** `read` tokens only read (and mint read-only git credentials). */
  scope: TokenScope;
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
  agent: string | null;
  scope: TokenScope;
  prefix: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
};

const toToken = (r: Row): ApiToken => ({
  id: r.id,
  name: r.name,
  agent: r.agent,
  scope: r.scope,
  prefix: r.prefix,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
});

export class TokenError extends Error {}

/** Agent names: what pull requests, comments and runs show, like `claude-1` or `deploy-bot`. */
export const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,38}$/;

/** Why `name` can't be an agent name, or null when it can. */
export function agentNameError(name: string): string | null {
  if (!AGENT_NAME.test(name)) {
    return "Agent names are up to 39 lowercase letters, digits, '.', '-' or '_', starting with a letter or digit";
  }
  return null;
}

export async function createApiToken(
  db: D1Database,
  name: string,
  days: number,
  options: { agent?: string | null; scope?: TokenScope } = {},
): Promise<{ token: string; apiToken: ApiToken }> {
  const label = name.trim();
  if (!label || label.length > 100)
    throw new TokenError("Give the token a name (up to 100 characters)");
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) {
    throw new TokenError(`Tokens last 1–${MAX_TOKEN_DAYS} days`);
  }
  const agent = options.agent?.trim().toLowerCase() || null;
  if (agent) {
    const error = agentNameError(agent);
    if (error) throw new TokenError(error);
  }
  const scope = options.scope ?? "write";
  if (scope !== "read" && scope !== "write") throw new TokenError("scope must be read or write");
  const token = `${TOKEN_PREFIX}${generateToken(32)}`;
  const now = new Date();
  const row: Row = {
    id: crypto.randomUUID(),
    name: label,
    agent,
    scope,
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + days * 86_400_000).toISOString(),
    last_used_at: null,
  };
  await db
    .prepare(
      `INSERT INTO api_tokens (id, name, agent, scope, token_hash, prefix, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.name,
      row.agent,
      row.scope,
      await hashToken(token),
      row.prefix,
      row.created_at,
      row.expires_at,
    )
    .run();
  return { token, apiToken: toToken(row) };
}

export async function listApiTokens(db: D1Database): Promise<ApiToken[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, agent, scope, prefix, created_at, expires_at, last_used_at
       FROM api_tokens ORDER BY created_at DESC`,
    )
    .all<Row>();
  return results.map(toToken);
}

export async function revokeApiToken(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM api_tokens WHERE id = ?").bind(id).run();
  return result.meta.changes > 0;
}

/** What a live token is: who it acts as and what it may do. */
export type TokenIdentity = { id: string; name: string; agent: string | null; scope: TokenScope };

/** The live API token `token` is, or null; records its use. */
export async function verifyApiToken(
  db: D1Database,
  token: string | undefined,
): Promise<TokenIdentity | null> {
  if (!token?.startsWith(TOKEN_PREFIX)) return null;
  const now = new Date().toISOString();
  return db
    .prepare(
      `UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ? AND expires_at > ?
       RETURNING id, name, agent, scope`,
    )
    .bind(now, await hashToken(token), now)
    .first<TokenIdentity>();
}

/** The token from an `Authorization: Bearer …` header, if any. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match?.[1];
}
