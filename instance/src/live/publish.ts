import type { Bindings } from "../api/bindings.js";
import { getDb } from "../db/migrations.js";
import type { LiveEvent, LiveMessage } from "../shared/live.js";
import type { LiveHub } from "./hub.js";

/**
 * Live updates (issue #18). Features call `publish(env, repo, event)` after a
 * change has landed in D1; it reaches the repo's hub and the instance's hub
 * (src/live/hub.ts), which send it to the browsers that may see it.
 *
 * Fire-and-forget: it never throws and gives up after PUBLISH_TIMEOUT_MS, so
 * awaiting it costs a few milliseconds and a failure never fails the caller.
 * Without the LIVE binding (tests, older configs) it does nothing.
 */

/** Header the Worker sets (after its own checks) to mark the owner's socket. */
export const OWNER_HEADER = "x-mycelium-live-owner";
export const PUBLISH_TIMEOUT_MS = 3000;

export type LiveEnv = Pick<Bindings, "DB"> & { LIVE?: DurableObjectNamespace<LiveHub> };

/** The hub of one repo, or of the whole instance (`repo` null). */
export function hubFor(ns: DurableObjectNamespace<LiveHub>, repo: string | null) {
  return ns.get(ns.idFromName(repo === null ? "instance" : `repo:${repo}`));
}

/**
 * Tell the repo's watchers, and the instance's, that `event` happened.
 * `visibility` is looked up in D1 unless given (pass it when the repo row is
 * already gone, e.g. on delete).
 */
export async function publish(
  env: LiveEnv,
  repo: string,
  event: LiveEvent,
  visibility?: "public" | "private",
): Promise<void> {
  const ns = env.LIVE;
  if (!ns) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const vis = visibility ?? (await visibilityOf(env, repo));
      const message = {
        ...event,
        repo,
        at: new Date().toISOString(),
        private: vis !== "public",
      } as LiveMessage;
      await Promise.allSettled([
        hubFor(ns, repo).broadcast(message),
        hubFor(ns, null).broadcast(message),
      ]);
    })();
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PUBLISH_TIMEOUT_MS);
    });
    await Promise.race([
      work.catch((e) => console.warn("mycelium: live publish failed", e)),
      deadline,
    ]);
  } catch (error) {
    console.warn("mycelium: live publish failed", error);
  } finally {
    clearTimeout(timer);
  }
}

/** A repo's visibility; private when unknown (never leak). */
async function visibilityOf(env: Pick<Bindings, "DB">, repo: string): Promise<string> {
  const db = await getDb(env.DB);
  const row = await db
    .prepare("SELECT visibility FROM repos WHERE name = ?")
    .bind(repo)
    .first<{ visibility: string }>();
  return row?.visibility ?? "private";
}

/** A push landed (from src/hooks/push.ts). */
export function publishPush(
  env: LiveEnv,
  repo: string,
  push: { ref: string; before: string | null; after: string | null; commits: unknown[] },
  pusher?: string | null,
): Promise<void> {
  return publish(env, repo, {
    type: "push",
    ref: push.ref,
    before: push.before,
    after: push.after,
    count: push.commits.length,
    ...(pusher && { pusher }),
  });
}

/** A workflow run changed status (or one of its steps did). */
export function publishRun(
  env: LiveEnv,
  run: { repo: string; number: number; workflow: string },
  status: string,
  step?: { idx: number; status: string },
): Promise<void> {
  return publish(env, run.repo, {
    type: "run",
    number: run.number,
    workflow: run.workflow,
    status,
    ...(step && { step }),
  });
}
