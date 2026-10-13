import type { Bindings } from "./api/bindings.js";
import { getDb } from "./db/migrations.js";
import { onPush, type Push } from "./hooks/push.js";
import { runWorkflow, type JobMessage } from "./jobs/workflow.js";
import type { PushCommit } from "./shared/types.js";

/**
 * The queue consumer. Two queues, told apart by name (see config.ts):
 *
 * - `<worker>-events`: Artifacts events from per-repo subscriptions. Pushes
 *   are stored in `pushes` (idempotent on repo + ref + after) and handed to
 *   `onPush` (src/hooks/push.ts).
 * - `<worker>-jobs`: `{ runId }` messages, handed to `runWorkflow`
 *   (src/jobs/workflow.ts).
 *
 * Feature code belongs in those two files, not here.
 */
export async function handleQueue(batch: MessageBatch<unknown>, env: Bindings): Promise<void> {
  if (batch.queue.endsWith("-jobs")) {
    for (const msg of batch.messages) {
      try {
        const { runId } = parseBody(msg.body) as JobMessage;
        if (typeof runId === "number") await runWorkflow(env, runId);
        msg.ack();
      } catch (error) {
        console.error("mycelium: job failed", error);
        msg.retry();
      }
    }
    return;
  }
  for (const msg of batch.messages) {
    try {
      await handleEvent(env, parseBody(msg.body) as ArtifactsEvent);
      msg.ack();
    } catch (error) {
      console.error("mycelium: event failed", error);
      msg.retry();
    }
  }
}

function parseBody(body: unknown): unknown {
  return typeof body === "string" ? JSON.parse(body) : body;
}

/** An Artifacts event as the subscription delivers it. */
export type ArtifactsEvent = {
  type: string;
  source: { type: string; namespace?: string; repoName?: string };
  payload: {
    ref?: string;
    before?: string;
    after?: string;
    commits?: PushCommit[];
    [key: string]: unknown;
  };
  metadata: { eventTimestamp: string };
};

/** Store a push event and call onPush, once per (repo, ref, after): a tag on a pushed commit is its own push. */
export async function handleEvent(env: Bindings, event: ArtifactsEvent): Promise<Push | null> {
  const repo = event.source?.repoName;
  if (event.type !== "cf.artifacts.repo.pushed" || !repo) return null;
  const db = await getDb(env.DB);
  const p = event.payload;
  const commits = p.commits ?? [];
  const at = event.metadata?.eventTimestamp ?? new Date().toISOString();
  const row = await db
    .prepare(
      `INSERT INTO pushes (repo, ref, before, after, commits, pusher, at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE NOT EXISTS (SELECT 1 FROM pushes WHERE repo = ?1 AND ref = ?2 AND after IS ?4)
       RETURNING id`,
    )
    .bind(
      repo,
      p.ref ?? "",
      p.before ?? null,
      p.after ?? null,
      JSON.stringify(commits),
      null, // events don't say who pushed

      at,
    )
    .first<{ id: number }>();
  if (!row) return null; // redelivered
  const push: Push = {
    id: row.id,
    repo,
    ref: p.ref ?? "",
    before: p.before ?? null,
    after: p.after ?? null,
    commits,
    at,
  };
  await onPush(env, repo, push);
  return push;
}
