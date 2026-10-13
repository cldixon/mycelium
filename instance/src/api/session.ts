import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  WEB_SESSION_COOKIE,
  WEB_SESSION_TTL_MS,
  getSetting,
  getWebSession,
  isLoopback,
} from "@mycelium/platform";
import { getOwner } from "../auth/owner.js";
import {
  bearerToken,
  verifyApiToken,
  type TokenIdentity,
  type TokenScope,
} from "../auth/tokens.js";
import { getDb } from "../db/migrations.js";
import type { Actor, RepoRow } from "../shared/types.js";
import type { Bindings } from "./bindings.js";

/** Hono env for every route. */
export type AppEnv = { Bindings: Bindings };

/**
 * Who is acting on an owner route: the owner (browser session or an owner
 * token) or a named agent (an API token with an agent name). `scope` is what
 * the token allows; a browser session is `write`.
 */
export type RequestActor = Actor & { tokenId?: string; scope: TokenScope };

/** Hono env after requireOwner: the migrated db, the owner's DID and the actor are set. */
export type OwnerEnv = {
  Bindings: Bindings;
  Variables: { db: D1Database; ownerDid: string; viaToken: boolean; actor: RequestActor };
};

export function originOf(c: Context): string {
  return new URL(c.req.url).origin;
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, WEB_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: !isLoopback(originOf(c)),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(WEB_SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, WEB_SESSION_COOKIE, { path: "/" });
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, WEB_SESSION_COOKIE);
}

type Viewer = {
  owner: string | null;
  isOwner: boolean;
  viaToken: boolean;
  badToken: boolean;
  /** The API token used, when it is live. */
  token: TokenIdentity | null;
};

/** Who is asking: the owner (by cookie or API token) or anyone else. */
export async function viewer(c: Context<any>, db: D1Database): Promise<Viewer> {
  const owner = await getOwner(db);
  const bearer = bearerToken(c.req.header("authorization"));
  if (bearer) {
    const token = owner !== null ? await verifyApiToken(db, bearer) : null;
    return { owner, isOwner: token !== null, viaToken: true, badToken: !token, token };
  }
  const did = await getWebSession(db, sessionToken(c));
  return {
    owner,
    isOwner: did !== null && did === owner,
    viaToken: false,
    badToken: false,
    token: null,
  };
}

/**
 * The actor behind an owner request: a token's agent, or the owner, named by
 * the cached handle (never resolved here) or the DID.
 */
export async function actorOf(
  db: D1Database,
  owner: string,
  token: TokenIdentity | null,
): Promise<RequestActor> {
  if (token?.agent) {
    return { kind: "agent", name: token.agent, tokenId: token.id, scope: token.scope };
  }
  return {
    kind: "owner",
    name: (await getSetting(db, "owner_handle")) ?? owner,
    ...(token && { tokenId: token.id }),
    scope: token?.scope ?? "write",
  };
}

/** The one write a read-only token may make: read-only git credentials (the route checks). */
const READ_TOKEN_POSTS = /\/git-credentials$/;

/**
 * Owner API guard: the owner's browser session, or an API token.
 *
 * Browser requests that change anything must come from this origin, which
 * with SameSite cookies keeps other sites from making them on the owner's
 * behalf. Token requests carry no cookies, so they need no such check.
 */
export const requireOwner: MiddlewareHandler<OwnerEnv> = async (c, next) => {
  const db = await getDb(c.env.DB);
  const token = bearerToken(c.req.header("authorization"));
  if (!token && c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin !== originOf(c)) return c.json({ error: "Cross-origin request refused" }, 403);
  }
  const who = await viewer(c, db);
  if (who.badToken) return c.json({ error: "Invalid or expired API token" }, 401);
  if (!who.isOwner) return c.json({ error: "Sign in as the instance owner" }, 401);
  const actor = await actorOf(db, who.owner!, who.token);
  if (
    actor.scope === "read" &&
    c.req.method !== "GET" &&
    c.req.method !== "HEAD" &&
    !READ_TOKEN_POSTS.test(new URL(c.req.url).pathname)
  ) {
    return c.json({ error: "This API token is read-only" }, 403);
  }
  c.set("db", db);
  c.set("ownerDid", who.owner!);
  c.set("viaToken", who.viaToken);
  c.set("actor", actor);
  await next();
};

/**
 * Read guard for one repo: the owner can read every repo, anyone can read a
 * public one. Callers answer 404 (not 403) when this is false, so private
 * repo names don't leak.
 */
export async function canRead(
  c: Context<AppEnv & { Variables?: object }>,
  repo: Pick<RepoRow, "visibility"> | null,
): Promise<boolean> {
  if (!repo) return false;
  if (repo.visibility === "public") return true;
  const who = await viewer(c, await getDb(c.env.DB));
  return who.isOwner;
}

/** True when the request comes from the owner (cookie or API token). */
export async function isOwner(c: Context<AppEnv & { Variables?: object }>): Promise<boolean> {
  return (await viewer(c, await getDb(c.env.DB))).isOwner;
}
