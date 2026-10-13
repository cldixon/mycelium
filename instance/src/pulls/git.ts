import type { Bindings } from "../api/bindings.js";
import { repoToken } from "../git/artifacts.js";
import { listRefs } from "../git/refs.js";
import type { DiffResult, MergeJob, MergeResult } from "../shared/jobs.js";
import type { Refs, RepoRow } from "../shared/types.js";

/**
 * Pull requests' git work: branch listing (smart HTTP) and runner jobs.
 *
 * runner.ts is imported lazily: it pulls in @cloudflare/containers, which
 * needs the Workers runtime, and the API app (and its tests) import this file.
 */
const runner = () => import("../runner.js");

export async function repoRefs(env: Pick<Bindings, "ARTIFACTS">, row: RepoRow): Promise<Refs> {
  const token = await repoToken(env, row.name);
  return listRefs(row.remote, token);
}

/** Compare head with base (branch names or shas) in the runner. */
export async function diffJob(
  env: Pick<Bindings, "ARTIFACTS" | "RUNNER">,
  row: RepoRow,
  base: string,
  head: string,
): Promise<DiffResult> {
  const { remotesFor, runJob } = await runner();
  const remotes = await remotesFor(env, [{ name: row.name, remote: row.remote, scope: "read" }]);
  return runJob(env, row.name, { type: "diff", remotes, repo: row.name, base, head });
}

/** Merge head into base in the runner, which pushes base on success. */
export async function mergeJob(
  env: Pick<Bindings, "ARTIFACTS" | "RUNNER">,
  row: RepoRow,
  job: Omit<MergeJob, "type" | "remotes" | "repo">,
): Promise<MergeResult> {
  const { remotesFor, runJob } = await runner();
  const remotes = await remotesFor(env, [{ name: row.name, remote: row.remote, scope: "write" }]);
  return runJob(env, row.name, { type: "merge", remotes, repo: row.name, ...job });
}
