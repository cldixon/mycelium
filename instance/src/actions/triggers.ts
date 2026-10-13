import type { Bindings } from "../api/bindings.js";
import { getDb, nextNumber } from "../db/migrations.js";
import { getRepoRow, mintToken } from "../git/artifacts.js";
import { listRefs } from "../git/refs.js";
import type { Push } from "../hooks/push.js";
import { enqueueRun } from "../jobs/workflow.js";
import type { Actor, RunEvent, Workflow } from "../shared/types.js";
import { loadWorkflows } from "./load.js";
import { runsOn } from "./parse.js";

/**
 * What starts workflow runs: pushes (from src/hooks/push.ts), pull requests
 * (triggerPullRequestRuns, called by the Pulls feature) and the Run button
 * (POST /api/repos/:repo/runs).
 */

export type Trigger = {
  event: RunEvent;
  /** Branch name, tag or `pull/<n>`, for display and filtering. */
  ref: string;
  sha: string;
  pullNumber?: number | null;
  /** Who started it by hand (manual runs and reruns). */
  actor?: Actor | null;
};

export type CreatedRun = { id: number; number: number; workflow: string };

type Env = Pick<Bindings, "DB" | "JOBS">;

const ZERO_SHA = /^0{40}$/;
const SHA = /^[0-9a-f]{40}$/;

/** The workflows `event` starts, in file order. */
export function workflowsFor(workflows: Workflow[], event: RunEvent): Workflow[] {
  return workflows.filter((w) => runsOn(w, event));
}

/** The branch a push moved, or null for tags, deletions and anything else. */
export function pushedBranch(push: Pick<Push, "ref" | "after">): string | null {
  if (!push.ref.startsWith("refs/heads/")) return null;
  if (!push.after || ZERO_SHA.test(push.after)) return null;
  return push.ref.slice("refs/heads/".length);
}

/**
 * Insert a queued run (and its steps) for each workflow, then queue them.
 * Run numbers come from `counters`, like GitHub's.
 */
export async function createRuns(
  env: Env,
  repo: string,
  workflows: Workflow[],
  trigger: Trigger,
): Promise<CreatedRun[]> {
  const db = await getDb(env.DB);
  const created: CreatedRun[] = [];
  for (const wf of workflows) {
    const number = await nextNumber(db, repo, "run");
    const now = new Date().toISOString();
    const row = await db
      .prepare(
        `INSERT INTO runs (repo, number, workflow, event, ref, sha, pull_number, status, actor,
                           actor_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?) RETURNING id`,
      )
      .bind(
        repo,
        number,
        wf.name,
        trigger.event,
        trigger.ref,
        trigger.sha,
        trigger.pullNumber ?? null,
        trigger.actor?.name ?? null,
        trigger.actor?.kind ?? null,
        now,
      )
      .first<{ id: number }>();
    const id = row!.id;
    await db.batch(
      wf.steps.map((s, idx) =>
        db
          .prepare("INSERT INTO run_steps (run_id, idx, name, command) VALUES (?, ?, ?, ?)")
          .bind(id, idx, s.name, s.run),
      ),
    );
    created.push({ id, number, workflow: wf.name });
  }
  for (const run of created) {
    try {
      await enqueueRun(env, run.id);
    } catch (error) {
      console.error(`mycelium: couldn't queue run ${run.id}`, error);
      await db
        .prepare(
          "UPDATE runs SET status = 'error', finished_at = ? WHERE id = ? AND status = 'queued'",
        )
        .bind(new Date().toISOString(), run.id)
        .run();
    }
  }
  return created;
}

/**
 * Push-triggered runs: workflows with `on: push` at the pushed branch head.
 * Never throws (a failure here must not stop other push handlers).
 */
export async function triggerPushRuns(
  env: Bindings,
  repo: string,
  push: Push,
): Promise<CreatedRun[]> {
  const branch = pushedBranch(push);
  if (!branch) return [];
  try {
    const { workflows, errors } = await loadWorkflows(env, repo, push.after!);
    for (const e of errors) console.warn(`mycelium: ${repo} ${e.path}: ${e.error}`);
    return await createRuns(env, repo, workflowsFor(workflows, "push"), {
      event: "push",
      ref: branch,
      sha: push.after!,
    });
  } catch (error) {
    console.error(`mycelium: push runs for ${repo} ${push.ref} failed`, error);
    return [];
  }
}

/**
 * Pull request runs (for the Pulls feature to call when a PR opens or its
 * head moves): workflows with `on: pull_request` at `headSha`. Idempotent:
 * a workflow that already has a run for this PR and sha is not run again.
 */
export async function triggerPullRequestRuns(
  env: Bindings,
  repo: string,
  pullNumber: number,
  headSha: string,
): Promise<CreatedRun[]> {
  const db = await getDb(env.DB);
  const { workflows } = await loadWorkflows(env, repo, headSha);
  const { results } = await db
    .prepare(
      `SELECT DISTINCT workflow FROM runs
       WHERE repo = ? AND sha = ? AND event = 'pull_request' AND pull_number = ?`,
    )
    .bind(repo, headSha, pullNumber)
    .all<{ workflow: string }>();
  const done = new Set(results.map((r) => r.workflow));
  const todo = workflowsFor(workflows, "pull_request").filter((w) => !done.has(w.name));
  return createRuns(env, repo, todo, {
    event: "pull_request",
    ref: `pull/${pullNumber}`,
    sha: headSha,
    pullNumber,
  });
}

/**
 * A branch, tag or full commit sha → the commit sha, or null. Without `ref`,
 * the default branch.
 */
export async function resolveRef(
  env: Pick<Bindings, "DB" | "ARTIFACTS">,
  repo: string,
  ref: string | undefined,
): Promise<{ ref: string; sha: string } | null> {
  const row = await getRepoRow(env, repo);
  if (!row) return null;
  const name = ref?.trim() || row.default_branch;
  const { token } = await mintToken(env, repo, "read", 120);
  const refs = await listRefs(row.remote, token);
  const short = name.replace(/^refs\/(heads|tags)\//, "");
  const hit =
    refs.branches.find((b) => b.name === short) ?? refs.tags.find((t) => t.name === short);
  if (hit) return { ref: hit.name, sha: hit.sha };
  if (SHA.test(name)) return { ref: name, sha: name };
  return null;
}
