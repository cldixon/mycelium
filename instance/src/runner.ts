import { getContainer } from "@cloudflare/containers";
import type { Bindings } from "./api/bindings.js";
import type { Job, JobError, JobResult, JobStatus, Remote, WorkflowJob } from "./shared/jobs.js";
import { mintToken, repoToken } from "./git/artifacts.js";

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
 * Start a background workflow job (`job.id` set) or read its status if the
 * container already has it. Poll it with `jobStatus`.
 */
export async function startJob(
  env: Pick<Bindings, "RUNNER">,
  key: string,
  job: WorkflowJob & { id: string },
  waitMs = 1000,
): Promise<JobStatus> {
  const container = getContainer(env.RUNNER, key);
  const res = await container.fetch(`http://runner/jobs?wait=${waitMs}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(job),
  });
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as
    JobStatus | JobError;
  if (!res.ok || "error" in body) {
    throw new RunnerError(res.status, (body as JobError).error ?? `HTTP ${res.status}`);
  }
  return body;
}

/**
 * A background job's status, from the container instance `key` that runs it.
 * Null when the container doesn't know the id (it restarted).
 */
export async function jobStatus(
  env: Pick<Bindings, "RUNNER">,
  key: string,
  id: string,
  waitMs = 1000,
): Promise<JobStatus | null> {
  const container = getContainer(env.RUNNER, key);
  const res = await container.fetch(`http://runner/jobs/${encodeURIComponent(id)}?wait=${waitMs}`);
  if (res.status === 404) return null;
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as
    JobStatus | JobError;
  if (!res.ok || "error" in body) {
    throw new RunnerError(res.status, (body as JobError).error ?? `HTTP ${res.status}`);
  }
  return body;
}

/**
 * Remotes for a job, so the container never sees an account credential.
 * `name` is the git remote name inside the container. Read tokens are reused
 * while they have `ttl` seconds left (see `repoToken`); write tokens are
 * minted for each job.
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
      token:
        r.scope === "read"
          ? await repoToken(env, r.name, ttl)
          : (await mintToken(env, r.name, r.scope, ttl)).token,
    })),
  );
}
