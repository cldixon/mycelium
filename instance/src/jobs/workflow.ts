import type { Bindings } from "../api/bindings.js";
import { loadWorkflows } from "../actions/load.js";
import { MAX_TIMEOUT_SEC } from "../actions/parse.js";
import { getDb } from "../db/migrations.js";
import { getRepoRow } from "../git/artifacts.js";
import type {
  JobStatus,
  WorkflowJob,
  WorkflowProgress,
  WorkflowResult,
  WorkflowStepResult,
} from "../shared/jobs.js";
import type { RunRow, RunStatus, RunStepRow, StepStatus } from "../shared/types.js";
import { publishRun } from "../live/publish.js";

/** Each step's stored log keeps at most this many characters (the tail). */
export const MAX_LOG_CHARS = 64 * 1024;
/**
 * A run still `running` this long after it started is presumed dead (its
 * queue invocation was killed): a redelivered message may take it over, and
 * readers show it as an error.
 */
export const STALE_AFTER_MS = (MAX_TIMEOUT_SEC + 300) * 1000;
/** Slack on top of the run's own timeout for container start and checkout. */
const RUNNER_SLACK_MS = 120_000;

/** The message the jobs queue carries. */
export type JobMessage = { runId: number };

/** Queue a workflow run (after inserting its `runs` and `run_steps` rows). */
export async function enqueueRun(env: Pick<Bindings, "JOBS">, runId: number): Promise<void> {
  await env.JOBS.send({ runId } satisfies JobMessage);
}

/** The tail of `log`, at most `max` characters, with a note when cut. */
export function tailLog(log: string, max = MAX_LOG_CHARS): string {
  if (log.length <= max) return log;
  const cut = log.length - max;
  const rest = log.slice(cut);
  const nl = rest.indexOf("\n");
  const body = nl >= 0 && nl < 200 ? rest.slice(nl + 1) : rest;
  return `[mycelium: ${log.length - body.length} earlier characters not kept]\n${body}`;
}

/** A run_steps row's changing fields. */
export type StepUpdate = {
  idx: number;
  status: StepStatus;
  exitCode: number | null;
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
};

/** The row for a step the runner finished; `fallbackStart` when it sent no start time. */
function finishedStep(idx: number, r: WorkflowStepResult, fallbackStart: number): StepUpdate {
  const start = r.startedAt ? Date.parse(r.startedAt) : fallbackStart;
  let log = r.log;
  if (r.timedOut)
    log += `${log && !log.endsWith("\n") ? "\n" : ""}[mycelium: step timed out after ${Math.round(r.durationMs / 1000)} s]\n`;
  return {
    idx,
    status: r.exitCode === 0 ? "success" : "failure",
    exitCode: r.exitCode,
    log: tailLog(log),
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date(start + r.durationMs).toISOString(),
  };
}

/**
 * Step rows from a running job's progress: the finished steps and the one
 * running now. Steps not reached yet are left out (they stay pending), and so
 * is the first step while the runner is still checking out.
 */
export function progressRows(
  steps: Pick<RunStepRow, "idx">[],
  progress: WorkflowProgress,
  startedAt: number,
): StepUpdate[] {
  const out: StepUpdate[] = [];
  let t = startedAt;
  for (const s of steps) {
    const r = progress.steps[s.idx];
    if (r) {
      const row = finishedStep(s.idx, r, t);
      t = Date.parse(row.finishedAt!);
      out.push(row);
    } else if (s.idx === progress.steps.length && progress.current) {
      out.push({
        idx: s.idx,
        status: "running",
        exitCode: null,
        log: tailLog(progress.current.log),
        startedAt: progress.current.startedAt,
        finishedAt: null,
      });
    }
  }
  return out;
}

/**
 * The rows in `rows` that differ from what was last written (`written`, by
 * idx), which is updated to match. Keeps polls from rewriting unchanged rows.
 */
export function changedRows(written: Map<number, string>, rows: StepUpdate[]): StepUpdate[] {
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (written.get(row.idx) === key) return false;
    written.set(row.idx, key);
    return true;
  });
}

/** Step rows and the run status from a runner result. */
export function applyResult(
  steps: Pick<RunStepRow, "idx">[],
  result: WorkflowResult,
  startedAt: number,
): { status: RunStatus; steps: StepUpdate[] } {
  let t = startedAt;
  const out = steps.map((s): StepUpdate => {
    const r = result.steps[s.idx];
    if (!r) {
      return {
        idx: s.idx,
        status: "skipped",
        exitCode: null,
        log: "",
        startedAt: null,
        finishedAt: null,
      };
    }
    const row = finishedStep(s.idx, r, t);
    t = Date.parse(row.finishedAt!);
    return row;
  });
  if (result.status === "error" && result.error) {
    // Infrastructure failure (e.g. checkout): say so on the first step that didn't succeed.
    const at = out.find((s) => s.status !== "success") ?? out[0];
    if (at) {
      at.status = "error";
      at.log = tailLog(`${at.log}[mycelium: ${result.error}]\n`);
    }
  }
  return { status: result.status, steps: out };
}

/**
 * The jobs queue consumer (src/queue.ts) calls this for every `{ runId }`
 * message. It claims the run (queued, or running but stale), runs its steps
 * in the runner container and writes step results and the final status.
 * Safe to run twice: a run someone else holds, or that has finished, is
 * skipped. Runner failures end the run as `error` instead of throwing.
 */
export async function runWorkflow(env: Bindings, runId: number): Promise<void> {
  const db = await getDb(env.DB);
  const started = Date.now();
  const run = await db
    .prepare(
      `UPDATE runs SET status = 'running', started_at = ?1, finished_at = NULL
       WHERE id = ?2 AND (status = 'queued' OR (status = 'running' AND started_at < ?3))
       RETURNING *`,
    )
    .bind(new Date(started).toISOString(), runId, new Date(started - STALE_AFTER_MS).toISOString())
    .first<RunRow>();
  if (!run) return;
  const { results: steps } = await db
    .prepare("SELECT idx, name, command FROM run_steps WHERE run_id = ? ORDER BY idx")
    .bind(runId)
    .all<Pick<RunStepRow, "idx" | "name" | "command">>();
  await db.batch([
    db
      .prepare(
        `UPDATE run_steps SET status = 'pending', exit_code = NULL, log = '', started_at = NULL,
         finished_at = NULL WHERE run_id = ?`,
      )
      .bind(runId),
    db
      .prepare(
        "UPDATE run_steps SET status = 'running', started_at = ? WHERE run_id = ? AND idx = 0",
      )
      .bind(new Date(started).toISOString(), runId),
  ]);
  await publishRun(env, run, "running", { idx: 0, status: "running" }); // Live updates

  // Progress from the runner, written as it changes (a failed write only
  // delays what the run page shows; the final write below is what counts).
  const written = new Map<number, string>();
  let last: WorkflowProgress | null = null;
  const onProgress = async (progress: WorkflowProgress) => {
    last = progress;
    const rows = changedRows(written, progressRows(steps, progress, started));
    await writeSteps(db, runId, rows).catch((error) => {
      written.clear();
      console.warn(`mycelium: run ${runId} progress not written`, error);
    });
    // Live updates: the run page reloads on each (a step started, ended or logged more).
    const moved = rows.at(-1);
    if (moved) {
      await publishRun(env, run, "running", { idx: moved.idx, status: moved.status }).catch(
        () => {},
      );
    }
  };

  let result: WorkflowResult;
  try {
    result = await execute(env, run, steps, onProgress);
  } catch (error) {
    console.error(`mycelium: run ${runId} failed`, error);
    result = {
      status: "error",
      // Keep what finished before the runner went away.
      steps: (last as WorkflowProgress | null)?.steps ?? [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const applied = applyResult(steps, result, started);
  const finished = new Date().toISOString();
  await db.batch([
    ...applied.steps.map((s) =>
      db
        .prepare(UPDATE_STEP)
        .bind(s.status, s.exitCode, s.log, s.startedAt, s.finishedAt, runId, s.idx),
    ),
    db
      .prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .bind(applied.status, finished, runId),
  ]);
  await publishRun(env, run, applied.status);
  console.log(
    `mycelium: run ${run.repo}#${run.number} ${applied.status} in ${Date.now() - started} ms`,
  );
}

/** How often the queue consumer asks the runner for progress. */
export const POLL_MS = 1000;
/** Consecutive failed polls (the container briefly unreachable) before giving up. */
const MAX_POLL_FAILURES = 5;

const UPDATE_STEP = `UPDATE run_steps SET status = ?, exit_code = ?, log = ?, started_at = ?,
  finished_at = ? WHERE run_id = ? AND idx = ?`;

/** Write step rows in one batch. */
async function writeSteps(db: D1Database, runId: number, rows: StepUpdate[]): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(
    rows.map((s) =>
      db
        .prepare(UPDATE_STEP)
        .bind(s.status, s.exitCode, s.log, s.startedAt, s.finishedAt, runId, s.idx),
    ),
  );
}

/** The parts of src/runner.ts `execute` uses (tests pass fakes). */
export type RunnerClient = Pick<
  typeof import("../runner.js"),
  "remotesFor" | "startJob" | "jobStatus"
>;

/**
 * Run the workflow in the runner as a background job (keyed by the run, so
 * a redelivered message picks up the same job) and poll it every POLL_MS,
 * handing each answer's progress to `onProgress` until the result is in.
 */
export async function execute(
  env: Bindings,
  run: RunRow,
  steps: Pick<RunStepRow, "idx" | "name" | "command">[],
  onProgress: (progress: WorkflowProgress) => Promise<void>,
  runner?: RunnerClient,
): Promise<WorkflowResult> {
  // Loaded lazily: src/runner.ts pulls in @cloudflare/containers, which only
  // exists in the Workers runtime (this module is also imported by tests).
  const [repo, loaded, client] = await Promise.all([
    getRepoRow(env, run.repo),
    // Timeouts live in the workflow file (run_steps keeps only name and command).
    loadWorkflows(env, run.repo, run.sha).catch((error) => {
      console.warn(
        `mycelium: couldn't re-read workflow for run ${run.id}; default timeouts`,
        error,
      );
      return null;
    }),
    runner ?? import("../runner.js"),
  ]);
  if (!repo) throw new Error(`repository ${run.repo} no longer exists`);
  let timeoutSec = MAX_TIMEOUT_SEC;
  const stepTimeouts = new Map<number, number>();
  const wf = loaded?.workflows.find((w) => w.name === run.workflow);
  if (wf) {
    timeoutSec = wf.timeoutSec;
    wf.steps.forEach((s, i) => s.timeoutSec && stepTimeouts.set(i, s.timeoutSec));
  }
  const remotes = await client.remotesFor(
    env,
    [{ name: run.repo, remote: repo.remote, scope: "read" }],
    timeoutSec + 600,
  );
  const job: WorkflowJob & { id: string } = {
    type: "workflow",
    id: `run-${run.id}`,
    remotes,
    repo: run.repo,
    sha: run.sha,
    steps: steps.map((s) => {
      const t = stepTimeouts.get(s.idx);
      return t ? { name: s.name, run: s.command, timeoutSec: t } : { name: s.name, run: s.command };
    }),
    timeoutSec,
  };
  const deadline = Date.now() + timeoutSec * 1000 + RUNNER_SLACK_MS;
  // The runner holds each request up to POLL_MS waiting for the job to end
  // (a long poll), so a quick job answers at once and a long one every POLL_MS.
  let asked = Date.now();
  let status: JobStatus | null = await client.startJob(env, run.repo, job, POLL_MS);
  let failures = 0;
  while (!status.done) {
    await onProgress(status.progress);
    if (Date.now() > deadline) {
      throw new Error(`the runner didn't finish within ${timeoutSec} s (+ slack)`);
    }
    // An answer that came back early (no long poll, or an error) waits out the interval.
    const early = POLL_MS - (Date.now() - asked);
    if (early > 0) await new Promise((resolve) => setTimeout(resolve, early));
    let next: JobStatus | null;
    asked = Date.now();
    try {
      next = await client.jobStatus(env, run.repo, job.id, POLL_MS);
    } catch (error) {
      if (++failures >= MAX_POLL_FAILURES) throw error;
      continue;
    }
    if (!next) throw new Error("the runner lost the job (its container restarted)");
    failures = 0;
    status = next;
  }
  return status.result;
}

/**
 * Runs left `running` past STALE_AFTER_MS (their invocation died) become
 * `error`. Called by readers so the UI doesn't spin forever.
 */
export async function expireStaleRuns(db: D1Database, repo: string): Promise<void> {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const { results } = await db
    .prepare(
      `UPDATE runs SET status = 'error', finished_at = ?
       WHERE repo = ? AND status = 'running' AND started_at < ? RETURNING id`,
    )
    .bind(now, repo, staleBefore)
    .all<{ id: number }>();
  if (results.length === 0) return;
  await db.batch(
    results.map((r) =>
      db
        .prepare(
          `UPDATE run_steps SET status = CASE status WHEN 'running' THEN 'error' ELSE 'skipped' END,
           finished_at = CASE status WHEN 'running' THEN ?1 ELSE finished_at END,
           log = CASE status WHEN 'running' THEN log || '[mycelium: the run stopped answering]' ELSE log END
           WHERE run_id = ?2 AND status IN ('running', 'pending')`,
        )
        .bind(now, r.id),
    ),
  );
}
