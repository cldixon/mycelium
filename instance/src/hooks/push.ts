import type { Bindings } from "../api/bindings.js";
import { triggerPushRuns } from "../actions/triggers.js";
import type { PushCommit } from "../shared/types.js";
import { onPullsPush } from "../pulls/push.js";
import { publishPush } from "../live/publish.js";

/**
 * EXTENSION POINT (owned by the Actions / Pulls features).
 *
 * Called by the queue consumer (src/queue.ts) once per new push, after the
 * push is stored in `pushes`. Redelivered events with the same repo and
 * `after` sha are not passed here twice.
 *
 * Feature work goes here: start workflow runs for `on: push`, update open
 * pull requests whose head branch moved (head_sha, `pull_request` runs).
 * Keep queue.ts unchanged; split work into modules and call them from here.
 */
export type Push = {
  /** Row id in `pushes`. */
  id: number;
  repo: string;
  /** Full ref name, e.g. "refs/heads/main". */
  ref: string;
  before: string | null;
  after: string | null;
  /** Newest first, as Artifacts sends them. */
  commits: PushCommit[];
  at: string;
};

export async function onPush(env: Bindings, repo: string, push: Push): Promise<void> {
  await publishPush(env, repo, push); // Live updates (never throws)
  await triggerPushRuns(env, repo, push); // Actions: `on: push` workflows (never throws)
  await onPullsPush(env, repo, push); // Pulls: head/base shas, PR runs, closes on head deletion
}
