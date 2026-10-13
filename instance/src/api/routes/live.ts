import { Hono, type Context } from "hono";
import { getDb } from "../../db/migrations.js";
import { getRepoRow } from "../../git/artifacts.js";
import { activityLimit, recentActivity } from "../../live/activity.js";
import { hubFor, OWNER_HEADER } from "../../live/publish.js";
import { bearerToken } from "../../auth/tokens.js";
import { canRead, isOwner, originOf, type AppEnv } from "../session.js";

/**
 * Live updates (issue #18). Mounted at /api.
 *
 *   GET /api/live                 WebSocket: every repo's events the viewer may see
 *   GET /api/repos/:repo/live     WebSocket: one repo's events (404 unless readable)
 *   GET /api/activity?limit=&repo= recent pushes, pull requests and runs, newest first
 *
 * Sockets carry LiveMessage JSON (src/shared/live.ts) after a `hello`; send
 * "ping" to get "pong". Private repos' events reach only the owner's sockets.
 */
export const liveRoute = new Hono<AppEnv>();

/**
 * The owner, for a socket. A browser's cookie counts only from this origin:
 * WebSockets aren't covered by CORS, so another site could open one with the
 * owner's cookies.
 */
async function ownerSocket(c: Context<AppEnv>): Promise<boolean> {
  const viaCookie = !bearerToken(c.req.header("authorization"));
  const origin = c.req.header("origin");
  if (viaCookie && origin && origin !== originOf(c)) return false;
  return isOwner(c);
}

function upgrade(c: Context<AppEnv>, repo: string | null, owner: boolean) {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected a WebSocket upgrade" }, 426);
  }
  if (!c.env.LIVE) return c.json({ error: "Live updates aren't configured" }, 503);
  const url = new URL(c.req.url);
  url.search = `?scope=${encodeURIComponent(repo ?? "*")}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete(OWNER_HEADER);
  if (owner) headers.set(OWNER_HEADER, "1");
  return hubFor(c.env.LIVE, repo).fetch(new Request(url, { headers }));
}

liveRoute.get("/live", async (c) => upgrade(c, null, await ownerSocket(c)));

liveRoute.get("/repos/:repo/live", async (c) => {
  const row = await getRepoRow(c.env, c.req.param("repo"));
  const owner = await ownerSocket(c);
  if (!row || !(row.visibility === "public" || owner)) return c.json({ error: "Not found" }, 404);
  return upgrade(c, row.name, owner);
});

liveRoute.get("/activity", async (c) => {
  const db = await getDb(c.env.DB);
  const repo = c.req.query("repo") || undefined;
  if (repo && !(await canRead(c, await getRepoRow(c.env, repo)))) {
    return c.json({ error: "Not found" }, 404);
  }
  const items = await recentActivity(db, {
    owner: await isOwner(c),
    limit: activityLimit(c.req.query("limit")),
    repo,
  });
  return c.json({ items });
});
