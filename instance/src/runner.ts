import { getContainer } from "@cloudflare/containers";
import type { Bindings } from "./api/bindings.js";
import type { Job, JobError, JobResult, JobStatus, Remote, WorkflowJob } from "./shared/jobs.js";
import { PROTOCOL_HEADER, RUNNER_PROTOCOL } from "./shared/jobs.js";
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
 * Fetch from the runner instance for `key`. Instances are keyed by the protocol
 * version as well: a deploy doesn't replace warm instances, so after a protocol
 * change jobs go to new instances (which start on the new image) and the old
 * ones go idle. A version mismatch left over is reported, never guessed at.
 */
async function runnerFetch(
  env: Pick<Bindings, "RUNNER">,
  key: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const container = getContainer(env.RUNNER, `${key}@p${RUNNER_PROTOCOL}`);
  const res = await container.fetch(`http://runner${path}`, init);
  const version = res.headers.get(PROTOCOL_HEADER);
  if (version !== String(RUNNER_PROTOCOL)) {
    await res.body?.cancel().catch(() => {});
    throw new RunnerError(
      502,
      `runner image is out of date (protocol ${version ?? "1"}, expected ${RUNNER_PROTOCOL}); redeploy`,
    );
  }
  return res;
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
  const res = await runnerFetch(env, key, "/jobs", {
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
  const res = await runnerFetch(env, key, `/jobs?wait=${waitMs}`, {
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
  const res = await runnerFetch(env, key, `/jobs/${encodeURIComponent(id)}?wait=${waitMs}`);
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
