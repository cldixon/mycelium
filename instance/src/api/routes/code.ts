import { Hono } from "hono";
import { getRepoRow } from "../../git/artifacts.js";
import { canRead, type AppEnv } from "../session.js";

/**
 * Code browsing: tree, blob, commits, commit (with diff), contributors.
 * Mounted at /api/repos/:repo. Owned by the Code feature.
 */
export const codeRoute = new Hono<AppEnv>();

/** Placeholder: answers once the repo is readable. Replace with the real routes. */
codeRoute.get("/code", async (c) => {
  const name = c.req.param("repo")!;
  const row = await getRepoRow(c.env, name);
  if (!(await canRead(c, row))) return c.json({ error: "Not found" }, 404);
  return c.json({ repo: name, defaultBranch: row!.default_branch });
});
