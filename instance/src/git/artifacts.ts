import { getDb } from "../db/migrations.js";
import type { Refs, RepoRow } from "../shared/types.js";
import type { Bindings } from "../api/bindings.js";
import { listRefs } from "./refs.js";

/**
 * Helpers around the Artifacts binding. The binding reads (log, commits,
 * trees, blobs, files) and manages repos and tokens; every content write is a
 * git push, from a client or from the runner container.
 */

/** The repo's D1 row, or null if the instance doesn't know it. */
export async function getRepoRow(env: Pick<Bindings, "DB">, name: string): Promise<RepoRow | null> {
  const db = await getDb(env.DB);
  return db.prepare("SELECT * FROM repos WHERE name = ?").bind(name).first<RepoRow>();
}

/**
 * Run `fn` with a handle to the Artifacts repo `name`, disposing the handle
 * (an RPC stub) when done.
 */
export async function withRepo<T>(
  env: Pick<Bindings, "ARTIFACTS">,
  name: string,
  fn: (repo: ArtifactsRepo) => Promise<T>,
): Promise<T> {
  using repo = await env.ARTIFACTS.get(name);
  return await fn(repo);
}

export type MintedToken = { token: string; scope: "read" | "write"; expiresAt: string };

/**
 * A short-lived repo-scoped token, for git over smart HTTP with
 * `Authorization: Bearer <token>` (or `http.extraHeader`).
 */
export async function mintToken(
  env: Pick<Bindings, "ARTIFACTS">,
  repo: string,
  scope: "read" | "write",
  ttl: number,
): Promise<MintedToken> {
  return withRepo(env, repo, async (r) => {
    const t = await r.createToken(scope, ttl);
    return { token: t.plaintext, scope: t.scope, expiresAt: t.expiresAt };
  });
}

/** True for an ArtifactsError with this code (e.g. "NOT_FOUND", "ALREADY_EXISTS"). */
export function isArtifactsError(error: unknown, code?: ArtifactsErrorCode): boolean {
  return (
    error instanceof Error &&
    error.name === "ArtifactsError" &&
    (code === undefined || (error as ArtifactsError).code === code)
  );
}

/** HTTP status for an ArtifactsError from create/import/delete. */
export function artifactsErrorStatus(error: unknown): 400 | 404 | 409 | 502 | 500 {
  if (!isArtifactsError(error)) return 500;
  switch ((error as ArtifactsError).code) {
    case "ALREADY_EXISTS":
    case "CREATE_IN_PROGRESS":
    case "IMPORT_IN_PROGRESS":
    case "FORK_IN_PROGRESS":
      return 409;
    case "INVALID_INPUT":
    case "INVALID_REPO_NAME":
    case "INVALID_URL":
    case "REMOTE_AUTH_REQUIRED":
    case "MEMORY_LIMIT":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "UPSTREAM_UNAVAILABLE":
      return 502;
    default:
      return 500;
  }
}

/**
 * The branch a repo really defaults to, from its ref advertisement. After an
 * import the Artifacts metadata says "main" whatever the source used, so we
 * trust HEAD's symref, then the branch that was asked for, then `fallback`,
 * then the first branch.
 */
export function pickDefaultBranch(refs: Refs, requested: string | null, fallback: string): string {
  const names = refs.branches.map((b) => b.name);
  if (refs.head && names.includes(refs.head)) return refs.head;
  if (requested && names.includes(requested)) return requested;
  if (names.includes(fallback)) return fallback;
  return names[0] ?? requested ?? fallback;
}

/** Read the refs with `token` and pick the default branch (fallback on error). */
export async function detectDefaultBranch(
  remote: string,
  token: string,
  requested: string | null,
  fallback: string,
  fetcher?: typeof fetch,
): Promise<string> {
  try {
    return pickDefaultBranch(await listRefs(remote, token, fetcher), requested, fallback);
  } catch (error) {
    console.warn(`mycelium: couldn't read refs of ${remote}:`, error);
    return requested ?? fallback;
  }
}

/** Delete every row that belongs to repo `name`, in every table, atomically. */
export async function deleteRepoRows(db: D1Database, name: string): Promise<void> {
  await db.batch(
    [
      "DELETE FROM pull_comments WHERE pull_id IN (SELECT id FROM pulls WHERE repo = ?)",
      "DELETE FROM pulls WHERE repo = ?",
      "DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE repo = ?)",
      "DELETE FROM runs WHERE repo = ?",
      "DELETE FROM pushes WHERE repo = ?",
      "DELETE FROM counters WHERE repo = ?",
      "DELETE FROM repos WHERE name = ?",
    ].map((sql) => db.prepare(sql).bind(name)),
  );
}
