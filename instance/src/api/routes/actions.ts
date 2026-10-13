import { Hono } from "hono";
import { getDb } from "../../db/migrations.js";
import { getRepoRow } from "../../git/artifacts.js";
import { canRead, type AppEnv } from "../session.js";

/**
 * Actions: runs, run detail, workflows, manual runs.
 * Mounted at /api/repos/:repo. Owned by the Actions feature.
 */
export const actionsRoute = new Hono<AppEnv>();

actionsRoute.get("/runs", async (c) => {
  const name = c.req.param("repo")!;
  const row = await getRepoRow(c.env, name);
  if (!(await canRead(c, row))) return c.json({ error: "Not found" }, 404);
  const db = await getDb(c.env.DB);
  const { results } = await db
    .prepare("SELECT * FROM runs WHERE repo = ? ORDER BY number DESC LIMIT 50")
    .bind(name)
    .all();
  return c.json({ runs: results });
});
