import { getContainer } from "@cloudflare/containers";
import type { Bindings } from "./api/bindings.js";
import type { Job, JobError, JobResult, Remote } from "./shared/jobs.js";
import { mintToken } from "./git/artifacts.js";

export type * from "./shared/jobs.js";

export class RunnerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

/**
 * Run a job in the runner container. `key` picks the container instance: use
 * the repo name, so one repo's jobs share a warm container and its cached
 * clone. Cold starts take 17-30 s; warm jobs a few seconds.
 */
export async function runJob<J extends Job>(
  env: Pick<Bindings, "RUNNER">,
  key: string,
  job: J,
): Promise<JobResult<J>> {
  const container = getContainer(env.RUNNER, key);
  const res = await container.fetch("http://runner/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  });
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as
    JobResult<J> | JobError;
  if (!res.ok || (body && typeof body === "object" && "error" in body)) {
    throw new RunnerError(res.status, (body as JobError).error ?? `HTTP ${res.status}`);
  }
  return body as JobResult<J>;
}

/**
 * Remotes for a job: a fresh token per repo, so the container never sees an
 * account credential. `name` is the git remote name inside the container.
 */
export async function remotesFor(
  env: Pick<Bindings, "ARTIFACTS">,
  repos: { name: string; remote: string; scope: "read" | "write" }[],
  ttl = 600,
): Promise<Remote[]> {
  return Promise.all(
    repos.map(async (r) => ({
      name: r.name,
      url: r.remote,
      token: (await mintToken(env, r.name, r.scope, ttl)).token,
    })),
  );
}
