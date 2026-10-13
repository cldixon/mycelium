import { Hono } from "hono";
import { getDb } from "../../db/migrations.js";
import { toRepo, type RepoRow } from "../../shared/types.js";
import { getRepoRow } from "../../git/artifacts.js";
import { canRead, isOwner, type AppEnv } from "../session.js";

/**
 * Repos: list, create/import, read, update, delete, git credentials, refs.
 * Mounted at /api/repos. Owned by the Repos feature.
 */
export const reposRoute = new Hono<AppEnv>();

/** The owner sees every repo; everyone else sees public ones. */
reposRoute.get("/", async (c) => {
  const db = await getDb(c.env.DB);
  const owner = await isOwner(c);
  const { results } = await db
    .prepare(
      owner
        ? "SELECT * FROM repos ORDER BY updated_at DESC"
        : "SELECT * FROM repos WHERE visibility = 'public' ORDER BY updated_at DESC",
    )
    .all<RepoRow>();
  return c.json({ repos: results.map(toRepo) });
});

/** One repo. 404 when it doesn't exist or the viewer can't read it. */
reposRoute.get("/:repo", async (c) => {
  const row = await getRepoRow(c.env, c.req.param("repo"));
  if (!(await canRead(c, row))) return c.json({ error: "Not found" }, 404);
  return c.json(toRepo(row!));
});
