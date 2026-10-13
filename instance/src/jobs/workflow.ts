import type { Bindings } from "../api/bindings.js";
import { loadWorkflows } from "../actions/load.js";
import { MAX_TIMEOUT_SEC } from "../actions/parse.js";
import { getDb } from "../db/migrations.js";
import { getRepoRow } from "../git/artifacts.js";
import type { WorkflowJob, WorkflowResult } from "../shared/jobs.js";
import type { RunRow, RunStatus, RunStepRow, StepStatus } from "../shared/types.js";

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

/** Step rows and the run status from a runner result. */
export function applyResult(
  steps: Pick<RunStepRow, "idx">[],
  result: WorkflowResult,
  startedAt: number,
): {
  status: RunStatus;
  steps: {
    idx: number;
    status: StepStatus;
    exitCode: number | null;
    log: string;
    startedAt: string | null;
    finishedAt: string | null;
  }[];
} {
  let t = startedAt;
  const out = steps.map((s) => {
    const r = result.steps[s.idx];
    if (!r) {
      return {
        idx: s.idx,
        status: "skipped" as StepStatus,
        exitCode: null,
        log: "",
        startedAt: null,
        finishedAt: null,
      };
    }
    const start = r.startedAt ? Date.parse(r.startedAt) : t;
    t = start + r.durationMs;
    let log = r.log;
    if (r.timedOut)
      log += `${log && !log.endsWith("\n") ? "\n" : ""}[mycelium: step timed out after ${Math.round(r.durationMs / 1000)} s]\n`;
    return {
      idx: s.idx,
      status: (r.exitCode === 0 ? "success" : "failure") as StepStatus,
      exitCode: r.exitCode,
      log: tailLog(log),
      startedAt: new Date(start).toISOString(),
      finishedAt: new Date(t).toISOString(),
    };
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

  let result: WorkflowResult;
  try {
    result = await execute(env, run, steps);
  } catch (error) {
    console.error(`mycelium: run ${runId} failed`, error);
    result = {
      status: "error",
      steps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const applied = applyResult(steps, result, started);
  const finished = new Date().toISOString();
  await db.batch([
    ...applied.steps.map((s) =>
      db
        .prepare(
          `UPDATE run_steps SET status = ?, exit_code = ?, log = ?, started_at = ?, finished_at = ?
           WHERE run_id = ? AND idx = ?`,
        )
        .bind(s.status, s.exitCode, s.log, s.startedAt, s.finishedAt, runId, s.idx),
    ),
    db
      .prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .bind(applied.status, finished, runId),
  ]);
  console.log(
    `mycelium: run ${run.repo}#${run.number} ${applied.status} in ${Date.now() - started} ms`,
  );
}

async function execute(
  env: Bindings,
  run: RunRow,
  steps: Pick<RunStepRow, "idx" | "name" | "command">[],
): Promise<WorkflowResult> {
  const repo = await getRepoRow(env, run.repo);
  if (!repo) throw new Error(`repository ${run.repo} no longer exists`);
  // Timeouts live in the workflow file (run_steps keeps only name and command).
  let timeoutSec = MAX_TIMEOUT_SEC;
  const stepTimeouts = new Map<number, number>();
  try {
    const { workflows } = await loadWorkflows(env, run.repo, run.sha);
    const wf = workflows.find((w) => w.name === run.workflow);
    if (wf) {
      timeoutSec = wf.timeoutSec;
      wf.steps.forEach((s, i) => s.timeoutSec && stepTimeouts.set(i, s.timeoutSec));
    }
  } catch (error) {
    console.warn(`mycelium: couldn't re-read workflow for run ${run.id}; default timeouts`, error);
  }
  // Loaded lazily: src/runner.ts pulls in @cloudflare/containers, which only
  // exists in the Workers runtime (this module is also imported by tests).
  const { remotesFor, runJob } = await import("../runner.js");
  const remotes = await remotesFor(
    env,
    [{ name: run.repo, remote: repo.remote, scope: "read" }],
    timeoutSec + 600,
  );
  const job: WorkflowJob = {
    type: "workflow",
    remotes,
    repo: run.repo,
    sha: run.sha,
    steps: steps.map((s) => {
      const t = stepTimeouts.get(s.idx);
      return t ? { name: s.name, run: s.command, timeoutSec: t } : { name: s.name, run: s.command };
    }),
    timeoutSec,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the runner didn't answer within ${timeoutSec} s (+ slack)`)),
      timeoutSec * 1000 + RUNNER_SLACK_MS,
    );
  });
  try {
    return await Promise.race([runJob(env, run.repo, job), deadline]);
  } finally {
    clearTimeout(timer);
  }
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
