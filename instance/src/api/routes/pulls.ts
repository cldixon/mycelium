import { Hono } from "hono";
import { getDb } from "../../db/migrations.js";
import { getRepoRow } from "../../git/artifacts.js";
import { canRead, type AppEnv } from "../session.js";

/**
 * Pull requests: list, open, read, update, diff, merge, comments.
 * Mounted at /api/repos/:repo. Owned by the Pulls feature.
 */
export const pullsRoute = new Hono<AppEnv>();

pullsRoute.get("/pulls", async (c) => {
  const name = c.req.param("repo")!;
  const row = await getRepoRow(c.env, name);
  if (!(await canRead(c, row))) return c.json({ error: "Not found" }, 404);
  const state = c.req.query("state") ?? "open";
  const db = await getDb(c.env.DB);
  const { results } = await db
    .prepare("SELECT * FROM pulls WHERE repo = ? AND state = ? ORDER BY number DESC")
    .bind(name, state)
    .all();
  return c.json({ pulls: results });
});
