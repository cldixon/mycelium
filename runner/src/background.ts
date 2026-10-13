import type {
  JobStatus,
  WorkflowJob,
  WorkflowProgress,
  WorkflowResult,
} from "../../instance/src/shared/jobs.ts";

/**
 * Background workflow jobs, by id. The Worker posts a workflow job with an
 * `id`, gets its status, then long-polls `GET /jobs/:id?wait=<ms>` while it
 * runs, so step logs reach D1 (and the run page) as they grow. A finished job
 * is kept for a while so the last poll sees its result. All in memory: if the
 * container restarts, the job is gone and the Worker reports that.
 */

/** How long a finished job's result stays readable. */
export const KEEP_FINISHED_MS = 10 * 60 * 1000;

type Entry = {
  progress: WorkflowProgress;
  result: WorkflowResult | null;
  finishedAt: number | null;
  /** Settles when the job finishes. */
  done: Promise<void>;
};

const jobs = new Map<string, Entry>();

function status(id: string, entry: Entry): JobStatus {
  // Snapshot: the running step's log is a getter over its growing buffer.
  const progress = JSON.parse(JSON.stringify(entry.progress)) as WorkflowProgress;
  return entry.result
    ? { id, done: true, progress, result: entry.result }
    : { id, done: false, progress };
}

function sweep(now = Date.now()) {
  for (const [id, e] of jobs) {
    if (e.finishedAt !== null && now - e.finishedAt > KEEP_FINISHED_MS) jobs.delete(id);
  }
}

/**
 * Start `job` in the background with `run` (the workflow handler), or, when
 * a job with this id exists, leave it be. Answers the job's status either way.
 */
export function startBackground(
  job: WorkflowJob & { id: string },
  run: (job: WorkflowJob, progress: WorkflowProgress) => Promise<WorkflowResult>,
): JobStatus {
  sweep();
  const existing = jobs.get(job.id);
  if (existing) return status(job.id, existing);
  const progress: WorkflowProgress = { steps: [], current: null };
  const t0 = Date.now();
  const entry: Entry = {
    progress,
    result: null,
    finishedAt: null,
    done: run(job, progress)
      .catch((error): WorkflowResult => ({
        status: "error",
        steps: progress.steps,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        entry.result = { ...result, timing: { ...result.timing, totalMs: Date.now() - t0 } };
        entry.finishedAt = Date.now();
        console.log(`job ${job.type} ${job.id} ${result.status} in ${Date.now() - t0} ms`);
      }),
  };
  jobs.set(job.id, entry);
  return status(job.id, entry);
}

/** A background job's status, or null when the runner doesn't know the id. */
export function backgroundStatus(id: string): JobStatus | null {
  const entry = jobs.get(id);
  return entry ? status(id, entry) : null;
}

/**
 * The job's status once it finishes or `ms` passes, whichever is first: a
 * long poll, so a quick job answers at once and a long one about every `ms`.
 */
export async function waitForStatus(id: string, ms: number): Promise<JobStatus | null> {
  const entry = jobs.get(id);
  if (!entry) return null;
  if (ms > 0 && !entry.result) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([entry.done, new Promise((r) => (timer = setTimeout(r, ms)))]);
    clearTimeout(timer);
  }
  return status(id, entry);
}
