import { getDb } from "../db/migrations.js";
import type { RepoRow } from "../shared/types.js";
import type { Bindings } from "../api/bindings.js";

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
