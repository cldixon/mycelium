import type { Bindings } from "../api/bindings.js";

/**
 * EXTENSION POINT (owned by the Actions feature).
 *
 * The jobs queue consumer (src/queue.ts) calls this for every `{ runId }`
 * message sent to `env.JOBS`. It should mark the run `running`, mint tokens,
 * call the runner's `workflow` job (src/runner.ts), and write step results and
 * the final status. Throwing retries the message (max 2 retries), so make it
 * safe to run twice (e.g. skip runs that are no longer `queued`).
 */
export async function runWorkflow(_env: Bindings, runId: number): Promise<void> {
  console.log(`mycelium: workflow run ${runId} queued, but runs aren't built yet`);
}

/** The message the jobs queue carries. */
export type JobMessage = { runId: number };

/** Queue a workflow run (after inserting its `runs` and `run_steps` rows). */
export async function enqueueRun(env: Pick<Bindings, "JOBS">, runId: number): Promise<void> {
  await env.JOBS.send({ runId } satisfies JobMessage);
}
