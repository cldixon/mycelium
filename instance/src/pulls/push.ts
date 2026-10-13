import { triggerPullRequestRuns } from "../actions/index.js";
import type { Bindings } from "../api/bindings.js";
import { getDb } from "../db/migrations.js";
import type { Push } from "../hooks/push.js";
import { branchUpdate } from "./logic.js";
import { publish } from "../live/publish.js";

/**
 * Keep open pull requests in step with pushes (called from hooks/push.ts):
 * a push to a PR's head or base branch updates its head_sha / base_sha (and
 * starts `on: pull_request` workflows for a new head), and deleting a PR's
 * head branch closes it.
 */
export async function onPullsPush(env: Bindings, repo: string, push: Push) {
  const update = branchUpdate(push);
  if (!update) return;
  const db = await getDb(env.DB);
  const now = new Date().toISOString();
  if (update.sha === null) {
    const { results: closed } = await db
      .prepare(
        `UPDATE pulls SET state = 'closed', closed_at = ?1, updated_at = ?1
         WHERE repo = ?2 AND head = ?3 AND state = 'open' RETURNING number`,
      )
      .bind(now, repo, update.branch)
      .all<{ number: number }>();
    for (const { number } of closed) {
      await publish(env, repo, { type: "pull", number, action: "closed" });
    }
    return;
  }
  const [moved] = await db.batch<{ number: number }>([
    db
      .prepare(
        `UPDATE pulls SET head_sha = ?1, updated_at = ?2
         WHERE repo = ?3 AND head = ?4 AND state = 'open' AND head_sha IS NOT ?1
         RETURNING number`,
      )
      .bind(update.sha, now, repo, update.branch),
    db
      .prepare(
        `UPDATE pulls SET base_sha = ?1
         WHERE repo = ?2 AND base = ?3 AND state = 'open' AND base_sha IS NOT ?1`,
      )
      .bind(update.sha, repo, update.branch),
  ]);
  for (const { number } of moved?.results ?? []) {
    await publish(env, repo, { type: "pull", number, action: "updated" });
    await startPullRuns(env, repo, number, update.sha);
  }
}

/**
 * Start `on: pull_request` workflows for a PR at `headSha` (the Actions
 * feature dedupes per PR and sha). Fails soft: a PR works without Actions.
 */
export async function startPullRuns(
  env: Bindings,
  repo: string,
  number: number,
  headSha: string,
): Promise<void> {
  try {
    await triggerPullRequestRuns(env, repo, number, headSha);
  } catch (error) {
    console.warn(`mycelium: pull_request runs for ${repo}#${number} failed`, error);
  }
}
