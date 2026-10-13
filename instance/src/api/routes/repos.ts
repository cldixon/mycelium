import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getDb } from "../../db/migrations.js";
import {
  branchNameError,
  repoNameError,
  toRepo,
  type CreateRepoInput,
  type GitCredentials,
  type RepoRow,
  type RepoRowWithPush,
  type UpdateRepoInput,
  type Visibility,
} from "../../shared/types.js";
import {
  artifactsErrorStatus,
  deleteRepoRows,
  detectDefaultBranch,
  getRepoRow,
  isArtifactsError,
  mintToken,
} from "../../git/artifacts.js";
import { subscribeRepo, unsubscribeRepo } from "../../git/subscriptions.js";
import { canRead, isOwner, requireOwner, type AppEnv } from "../session.js";

/**
 * Repos: list, create/import, read, update, delete, git credentials.
 * Mounted at /api/repos. Owned by the Repos feature.
 */
export const reposRoute = new Hono<AppEnv>();

const DESCRIPTION_MAX = 350;
/** Git credential lifetimes, in seconds. */
export const GIT_TTL = { default: 3600, min: 60, max: 7 * 86_400 };

/** requireOwner on this route's env (owner routes migrate the db themselves). */
const ownerOnly = requireOwner as unknown as MiddlewareHandler<AppEnv>;

/** With the latest push time, for "Updated …". */
const SELECT_REPOS = `SELECT r.*, (SELECT MAX(p.at) FROM pushes p WHERE p.repo = r.name) AS pushed_at
  FROM repos r`;

const isVisibility = (v: unknown): v is Visibility => v === "private" || v === "public";

async function body<T>(c: Context): Promise<Partial<T> | null> {
  const data = await c.req.json().catch(() => null);
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Partial<T>) : null;
}

/** A trimmed description (null when empty), or an error message. */
function cleanDescription(v: unknown): { value: string | null } | { error: string } {
  if (v === undefined || v === null) return { value: null };
  if (typeof v !== "string") return { error: "description must be a string" };
  const value = v.trim();
  if (value.length > DESCRIPTION_MAX)
    return { error: `description is over ${DESCRIPTION_MAX} characters` };
  return { value: value || null };
}

/** A public https git URL without credentials, or an error message. */
export function importUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "importUrl is not a URL";
  }
  if (parsed.protocol !== "https:") return "importUrl must be an https:// URL";
  if (parsed.username || parsed.password) return "importUrl can't contain credentials";
  return null;
}

async function withPush(db: D1Database, name: string): Promise<RepoRowWithPush | null> {
  return db.prepare(`${SELECT_REPOS} WHERE r.name = ?`).bind(name).first<RepoRowWithPush>();
}

/** The owner sees every repo; everyone else sees public ones. */
reposRoute.get("/", async (c) => {
  const db = await getDb(c.env.DB);
  const owner = await isOwner(c);
  const { results } = await db
    .prepare(
      `${SELECT_REPOS} ${owner ? "" : "WHERE r.visibility = 'public'"}
       ORDER BY MAX(r.updated_at, COALESCE(pushed_at, '')) DESC`,
    )
    .all<RepoRowWithPush>();
  return c.json({ repos: results.map(toRepo) });
});

/** Create an empty repo, or import one from a public git URL. Owner only. */
reposRoute.post("/", ownerOnly, async (c) => {
  const input = await body<CreateRepoInput>(c);
  if (!input) return c.json({ error: "Expected a JSON object" }, 400);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const nameError = repoNameError(name);
  if (nameError) return c.json({ error: nameError }, 400);
  const description = cleanDescription(input.description);
  if ("error" in description) return c.json({ error: description.error }, 400);
  const visibility = input.visibility ?? "private";
  if (!isVisibility(visibility))
    return c.json({ error: "visibility must be private or public" }, 400);
  const importUrl = typeof input.importUrl === "string" ? input.importUrl.trim() : "";
  if (input.importUrl != null && typeof input.importUrl !== "string") {
    return c.json({ error: "importUrl must be a string" }, 400);
  }
  if (importUrl) {
    const urlError = importUrlError(importUrl);
    if (urlError) return c.json({ error: urlError }, 400);
  }
  const branch =
    typeof input.branch === "string" && input.branch.trim() ? input.branch.trim() : null;
  if (branch) {
    if (!importUrl) return c.json({ error: "branch only applies to imports" }, 400);
    const branchError = branchNameError(branch);
    if (branchError) return c.json({ error: `branch: ${branchError}` }, 400);
  }

  const db = await getDb(c.env.DB);
  if (await getRepoRow(c.env, name)) return c.json({ error: `${name} already exists` }, 409);

  let created: ArtifactsCreateRepoResult;
  try {
    created = importUrl
      ? await c.env.ARTIFACTS.import({
          source: { url: importUrl, ...(branch && { branch }) },
          target: { name, opts: { ...(description.value && { description: description.value }) } },
        })
      : await c.env.ARTIFACTS.create(name, {
          ...(description.value && { description: description.value }),
          setDefaultBranch: "main",
        });
  } catch (error) {
    const status = artifactsErrorStatus(error);
    if (status === 500) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 404) return c.json({ error: `Nothing to import at ${importUrl}` }, 400);
    return c.json({ error: message }, status);
  }

  // Imports: the metadata's default branch is not the source's; read HEAD.
  const defaultBranch = importUrl
    ? await detectDefaultBranch(created.remote, created.token, branch, created.defaultBranch)
    : created.defaultBranch || "main";
  const subscription = await subscribeRepo(
    c.env.CF_API_TOKEN,
    created.remote,
    new URL(c.req.url).hostname,
  );
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO repos (name, description, visibility, default_branch, remote, source_url,
         subscription_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      name,
      description.value,
      visibility,
      defaultBranch,
      created.remote,
      importUrl || null,
      subscription,
      now,
      now,
    )
    .run();
  return c.json(toRepo((await withPush(db, name))!), 201);
});

/** One repo. 404 when it doesn't exist or the viewer can't read it. */
reposRoute.get("/:repo", async (c) => {
  const row = await withPush(await getDb(c.env.DB), c.req.param("repo"));
  if (!(await canRead(c, row))) return c.json({ error: "Not found" }, 404);
  return c.json(toRepo(row!));
});

/** Change description, visibility or default branch. Owner only. */
reposRoute.patch("/:repo", ownerOnly, async (c) => {
  const name = c.req.param("repo");
  const row = await getRepoRow(c.env, name);
  if (!row) return c.json({ error: "Not found" }, 404);
  const input = await body<UpdateRepoInput>(c);
  if (!input) return c.json({ error: "Expected a JSON object" }, 400);

  const next: Pick<RepoRow, "description" | "visibility" | "default_branch"> = {
    description: row.description,
    visibility: row.visibility,
    default_branch: row.default_branch,
  };
  if ("description" in input) {
    const d = cleanDescription(input.description);
    if ("error" in d) return c.json({ error: d.error }, 400);
    next.description = d.value;
  }
  if (input.visibility !== undefined) {
    if (!isVisibility(input.visibility)) {
      return c.json({ error: "visibility must be private or public" }, 400);
    }
    next.visibility = input.visibility;
  }
  if (input.defaultBranch !== undefined) {
    const branch = typeof input.defaultBranch === "string" ? input.defaultBranch.trim() : "";
    const err = branchNameError(branch);
    if (err) return c.json({ error: `defaultBranch: ${err}` }, 400);
    next.default_branch = branch;
  }
  const db = await getDb(c.env.DB);
  await db
    .prepare(
      `UPDATE repos SET description = ?, visibility = ?, default_branch = ?, updated_at = ?
       WHERE name = ?`,
    )
    .bind(next.description, next.visibility, next.default_branch, new Date().toISOString(), name)
    .run();
  return c.json(toRepo((await withPush(db, name))!));
});

/**
 * Delete the repo: the Artifacts repo, its push subscription and its rows in
 * every table. Owner only.
 */
reposRoute.delete("/:repo", ownerOnly, async (c) => {
  const name = c.req.param("repo");
  const row = await getRepoRow(c.env, name);
  if (!row) return c.json({ error: "Not found" }, 404);
  try {
    await c.env.ARTIFACTS.delete(name); // false when already gone: fine
  } catch (error) {
    if (!isArtifactsError(error, "NOT_FOUND")) throw error;
  }
  await unsubscribeRepo(c.env.CF_API_TOKEN, row.subscription_id);
  await deleteRepoRows(await getDb(c.env.DB), name);
  return c.json({ deleted: name });
});

/**
 * A short-lived Artifacts token for plain git against the repo's remote:
 * `git -c http.extraHeader="Authorization: Bearer <token>" clone <remote>`.
 * Owner only (browser session or API token).
 */
reposRoute.post("/:repo/git-credentials", ownerOnly, async (c) => {
  const name = c.req.param("repo");
  const row = await getRepoRow(c.env, name);
  if (!row) return c.json({ error: "Not found" }, 404);
  const input = (await body<{ scope: string; ttl: number }>(c)) ?? {};
  const scope = input.scope ?? "read";
  if (scope !== "read" && scope !== "write") {
    return c.json({ error: "scope must be read or write" }, 400);
  }
  const ttl = input.ttl ?? GIT_TTL.default;
  if (!Number.isInteger(ttl) || ttl < GIT_TTL.min || ttl > GIT_TTL.max) {
    return c.json(
      { error: `ttl must be whole seconds between ${GIT_TTL.min} and ${GIT_TTL.max}` },
      400,
    );
  }
  try {
    const minted = await mintToken(c.env, name, scope, ttl);
    const credentials: GitCredentials = {
      remote: row.remote,
      token: minted.token,
      scope: minted.scope,
      expiresAt: minted.expiresAt,
    };
    return c.json(credentials);
  } catch (error) {
    if (isArtifactsError(error, "INVALID_TTL")) return c.json({ error: "ttl out of range" }, 400);
    if (isArtifactsError(error, "IMPORT_IN_PROGRESS")) {
      return c.json({ error: "The import is still running; try again shortly" }, 409);
    }
    throw error;
  }
});
