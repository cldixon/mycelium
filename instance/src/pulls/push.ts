import type { Bindings } from "../api/bindings.js";
import { getDb } from "../db/migrations.js";
import type { Push } from "../hooks/push.js";
import { branchUpdate } from "./logic.js";

/**
 * Keep open pull requests in step with pushes (called from hooks/push.ts):
 * a push to a PR's head or base branch updates its head_sha / base_sha, and
 * deleting a PR's head branch closes it.
 */
export async function onPullsPush(env: Pick<Bindings, "DB">, repo: string, push: Push) {
  const update = branchUpdate(push);
  if (!update) return;
  const db = await getDb(env.DB);
  const now = new Date().toISOString();
  if (update.sha === null) {
    await db
      .prepare(
        `UPDATE pulls SET state = 'closed', closed_at = ?1, updated_at = ?1
         WHERE repo = ?2 AND head = ?3 AND state = 'open'`,
      )
      .bind(now, repo, update.branch)
      .run();
    return;
  }
  await db.batch([
    db
      .prepare(
        `UPDATE pulls SET head_sha = ?1, updated_at = ?2
         WHERE repo = ?3 AND head = ?4 AND state = 'open' AND head_sha IS NOT ?1`,
      )
      .bind(update.sha, now, repo, update.branch),
    db
      .prepare(
        `UPDATE pulls SET base_sha = ?1
         WHERE repo = ?2 AND base = ?3 AND state = 'open' AND base_sha IS NOT ?1`,
      )
      .bind(update.sha, repo, update.branch),
  ]);
}
