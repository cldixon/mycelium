import { getDb } from "../db/migrations.js";
import type { CheckStatus, ChecksEvaluation, PullRow, RunStatus } from "../shared/types.js";

/**
 * Required checks: workflows that must succeed on a pull request's head
 * commit before it merges into a branch. Stored per repo and base branch in
 * `required_checks` (migration 0004). A required workflow counts by its
 * latest run (highest number) on the head sha, whatever started it (push,
 * pull_request or manual).
 */

type Env = { DB: D1Database };

/** The required workflows for `branch`, sorted. */
export async function getRequired(env: Env, repo: string, branch: string): Promise<string[]> {
  const db = await getDb(env.DB);
  const { results } = await db
    .prepare("SELECT workflow FROM required_checks WHERE repo = ? AND branch = ? ORDER BY workflow")
    .bind(repo, branch)
    .all<{ workflow: string }>();
  return results.map((r) => r.workflow);
}

/** Replace the required workflows for `branch` (an empty list clears them). */
export async function setRequired(
  env: Env,
  repo: string,
  branch: string,
  workflows: string[],
): Promise<string[]> {
  const db = await getDb(env.DB);
  const unique = [...new Set(workflows)].sort();
  await db.batch([
    db.prepare("DELETE FROM required_checks WHERE repo = ? AND branch = ?").bind(repo, branch),
    ...unique.map((w) =>
      db
        .prepare("INSERT INTO required_checks (repo, branch, workflow) VALUES (?, ?, ?)")
        .bind(repo, branch, w),
    ),
  ]);
  return unique;
}

/** A run's status as a check. */
export function checkStatus(status: RunStatus | undefined): CheckStatus {
  if (!status) return "missing";
  if (status === "success") return "success";
  if (status === "queued" || status === "running") return "pending";
  return "failure"; // failure, error, cancelled
}

/** The pull request's required checks at its current head sha. */
export async function evaluate(
  env: Env,
  repo: string,
  pull: Pick<PullRow, "base" | "head_sha">,
): Promise<ChecksEvaluation> {
  const workflows = await getRequired(env, repo, pull.base);
  const sha = pull.head_sha;
  if (workflows.length === 0) return { sha, required: [], satisfied: true };
  const latest = new Map<string, { number: number; status: RunStatus }>();
  if (sha) {
    const db = await getDb(env.DB);
    const { results } = await db
      .prepare(
        `SELECT workflow, number, status FROM runs
       WHERE repo = ? AND sha = ? ORDER BY number DESC`,
      )
      .bind(repo, sha)
      .all<{ workflow: string; number: number; status: RunStatus }>();
    for (const r of results) if (!latest.has(r.workflow)) latest.set(r.workflow, r);
  }
  const required = workflows.map((workflow) => {
    const run = latest.get(workflow);
    return run
      ? { workflow, status: checkStatus(run.status), runNumber: run.number }
      : { workflow, status: "missing" as const };
  });
  return { sha, required, satisfied: required.every((c) => c.status === "success") };
}

/** Why a pull request can't merge yet, in one line (the 409's error). */
export function unsatisfiedReason(evaluation: ChecksEvaluation): string {
  const by = (s: CheckStatus) =>
    evaluation.required.filter((c) => c.status === s).map((c) => c.workflow);
  const parts: string[] = [];
  const failed = by("failure");
  const pending = by("pending");
  const missing = by("missing");
  if (failed.length) parts.push(`failing: ${failed.join(", ")}`);
  if (pending.length) parts.push(`pending: ${pending.join(", ")}`);
  if (missing.length) parts.push(`not run: ${missing.join(", ")}`);
  return `Required checks haven't passed (${parts.join("; ")})`;
}
