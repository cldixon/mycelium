import { Hono } from "hono";
import {
  createWebSession,
  deleteWebSession,
  deleteWebSessionsFor,
  getWebSession,
} from "@mycelium/platform";
import { getOAuthClient } from "../../auth/client.js";
import {
  checkSetupCode,
  claimOwnership,
  getOwner,
  getOwnerHandle,
  logSetupCodeIfUnclaimed,
} from "../../auth/owner.js";
import { getDb } from "../../db/migrations.js";
import type { AuthStatus } from "../../shared/types.js";
import type { Bindings } from "../bindings.js";
import {
  clearSessionCookie,
  originOf,
  sessionToken,
  setSessionCookie,
  type AppEnv,
} from "../session.js";

type AppState = { claim?: boolean };

/** An error and its causes, one per line: OAuth failures wrap the real reason. */
function describeError(error: unknown): string {
  const lines: string[] = [];
  for (let e: unknown = error, depth = 0; e && depth < 6; depth++) {
    lines.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return lines.join("\n  caused by ");
}

function client(c: { env: Bindings; req: { url: string } }, db: D1Database) {
  return getOAuthClient(db, new URL(c.req.url).origin, {
    title: c.env.INSTANCE_TITLE || "mycelium",
    signingKeySecret: c.env.OAUTH_SIGNING_KEY,
  });
}

/** OAuth client documents and callback, served from the instance's own domain. */
export const oauthRoute = new Hono<AppEnv>();

oauthRoute.get("/client-metadata.json", async (c) => {
  const oauth = await client(c, await getDb(c.env.DB));
  return c.json(oauth.clientMetadata);
});

oauthRoute.get("/jwks.json", async (c) => {
  const oauth = await client(c, await getDb(c.env.DB));
  return c.json(oauth.jwks);
});

/** The authorization server sends the browser back here. */
oauthRoute.get("/callback", async (c) => {
  const db = await getDb(c.env.DB);
  const oauth = await client(c, db);
  const params = new URL(c.req.url).searchParams;
  const fail = (reason: string) => c.redirect(`/signin?error=${encodeURIComponent(reason)}`);

  let did: string;
  let appState: AppState = {};
  try {
    const { session, state } = await oauth.callback(params);
    did = session.did;
    appState = state ? (JSON.parse(state) as AppState) : {};
  } catch (error) {
    console.error("OAuth callback failed", describeError(error));
    return fail("sign_in_failed");
  }

  let owner = await getOwner(db);
  if (!owner && appState.claim) owner = await claimOwnership(db, did);
  if (did !== owner) {
    // Don't keep tokens for accounts that can't use them.
    await oauth.revoke(did).catch(() => {});
    return fail(owner ? "not_owner" : "unclaimed");
  }

  setSessionCookie(c, await createWebSession(db, did));
  return c.redirect("/");
});

/** Sign-in state for the web app. */
export const authRoute = new Hono<AppEnv>();

authRoute.get("/status", async (c) => {
  const db = await getDb(c.env.DB);
  await logSetupCodeIfUnclaimed(db, c.env.SETUP_CODE);
  const [owner, did] = await Promise.all([getOwner(db), getWebSession(db, sessionToken(c))]);
  const status: AuthStatus = {
    claimed: owner !== null,
    owner,
    handle: owner ? await getOwnerHandle(db) : null,
    signedIn: did !== null && did === owner,
    title: c.env.INSTANCE_TITLE || "mycelium",
  };
  return c.json(status);
});

authRoute.post("/login", async (c) => {
  if (c.req.header("origin") !== originOf(c)) {
    return c.json({ error: "Cross-origin request refused" }, 403);
  }
  const body = await c.req
    .json<{ handle?: string; setupCode?: string }>()
    .catch(() => ({}) as { handle?: string; setupCode?: string });
  const handle = body.handle?.trim().replace(/^@/, "");
  if (!handle) return c.json({ error: "Enter your handle" }, 400);

  const db = await getDb(c.env.DB);
  const appState: AppState = {};
  if (!(await getOwner(db))) {
    if (!(await checkSetupCode(db, c.env.SETUP_CODE, body.setupCode ?? ""))) {
      return c.json({ error: "That setup code is not right" }, 403);
    }
    appState.claim = true;
  }

  try {
    const oauth = await client(c, db);
    const url = await oauth.authorize(handle, { state: JSON.stringify(appState) });
    return c.json({ url: url.toString() });
  } catch (error) {
    console.error("OAuth authorize failed", describeError(error));
    return c.json({ error: `Couldn't start sign-in for ${handle}` }, 400);
  }
});

authRoute.post("/logout", async (c) => {
  if (c.req.header("origin") !== originOf(c)) {
    return c.json({ error: "Cross-origin request refused" }, 403);
  }
  const db = await getDb(c.env.DB);
  const token = sessionToken(c);
  const did = await getWebSession(db, token);
  await deleteWebSession(db, token);
  if (did) {
    await deleteWebSessionsFor(db, did);
    const oauth = await client(c, db);
    await oauth.revoke(did).catch(() => {});
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});
