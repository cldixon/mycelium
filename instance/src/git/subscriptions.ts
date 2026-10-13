/**
 * Per-repo Artifacts event subscriptions (`artifacts.repo`, event `pushed`)
 * that deliver push events to the instance's `<worker>-events` queue.
 *
 * Creating one needs the Cloudflare REST API and the optional `CF_API_TOKEN`
 * secret. Everything here fails soft: without a token, or when the API
 * refuses, it logs and returns null, and the instance works without push
 * events.
 *
 * Nothing is configured: the account id and namespace come from the repo's
 * git remote (`https://<account>.artifacts.cloudflare.net/git/<ns>/<repo>.git`)
 * and the queue is found by listing the account's queues (see pickEventsQueue).
 */

const API = "https://api.cloudflare.com/client/v4";

export type CfApi = { token: string; fetcher?: typeof fetch };

type Envelope<T> = { success: boolean; result: T; errors?: { code: number; message: string }[] };

async function cfFetch<T>(api: CfApi, method: string, path: string, body?: unknown): Promise<T> {
  const res = await (api.fetcher ?? fetch)(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${api.token}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !data?.success) {
    const why = data?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || res.statusText;
    throw new Error(`${method} ${path}: HTTP ${res.status} ${why}`);
  }
  return data.result;
}

export type RemoteParts = { accountId: string; namespace: string; repo: string };

/** Account id, namespace and repo name from an Artifacts git remote, or null. */
export function parseRemote(remote: string): RemoteParts | null {
  const m =
    /^https:\/\/([0-9a-f]{32})\.artifacts\.cloudflare\.net\/git\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      remote,
    );
  return m ? { accountId: m[1], namespace: m[2], repo: m[3] } : null;
}

export type QueueInfo = {
  queue_id: string;
  queue_name: string;
  consumers?: { script?: string; script_name?: string; service?: string }[];
};

/**
 * The instance's events queue among the account's queues. The queue is
 * `<worker>-events` and is consumed by `<worker>`, which we don't know by
 * name, so in order of preference:
 *
 * 1. `<namespace>-events` (the namespace defaults to the Worker name),
 * 2. `<label>-events` for the first label of a workers.dev host,
 * 3. the only `<x>-events` queue consumed by a Worker named `<x>`.
 */
export function pickEventsQueue(
  queues: QueueInfo[],
  hints: { namespace?: string; host?: string },
): QueueInfo | null {
  const consumedBySelf = (q: QueueInfo) => {
    const worker = q.queue_name.replace(/-events$/, "");
    return (
      q.queue_name.endsWith("-events") &&
      (q.consumers ?? []).some((c) => (c.script ?? c.script_name ?? c.service) === worker)
    );
  };
  const named = (worker: string | undefined) =>
    worker ? queues.find((q) => q.queue_name === `${worker}-events`) : undefined;
  const label = hints.host?.endsWith(".workers.dev") ? hints.host.split(".")[0] : undefined;
  const byNamespace = named(hints.namespace);
  if (byNamespace && consumedBySelf(byNamespace)) return byNamespace;
  const byHost = named(label);
  if (byHost) return byHost;
  if (byNamespace) return byNamespace;
  const candidates = queues.filter(consumedBySelf);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Queue lookups are stable for the isolate's life. */
const queueCache = new Map<string, string>();

async function eventsQueueId(api: CfApi, accountId: string, namespace: string, host?: string) {
  const key = `${accountId}/${namespace}/${host ?? ""}`;
  const cached = queueCache.get(key);
  if (cached) return cached;
  const queues = await cfFetch<QueueInfo[]>(
    api,
    "GET",
    `/accounts/${accountId}/queues?per_page=1000`,
  );
  const queue = pickEventsQueue(queues, { namespace, host });
  if (!queue) throw new Error("couldn't find this instance's <worker>-events queue");
  queueCache.set(key, queue.queue_id);
  return queue.queue_id;
}

/** Stored as `repos.subscription_id`: `<account id>:<subscription id>`. */
export function subscriptionKey(accountId: string, id: string): string {
  return `${accountId}:${id}`;
}

/**
 * Subscribe `remote`'s repo to push events. Returns the value to store in
 * `repos.subscription_id`, or null (no token, or the API refused; logged).
 */
export async function subscribeRepo(
  token: string | undefined,
  remote: string,
  host?: string,
  fetcher?: typeof fetch,
): Promise<string | null> {
  if (!token) return null;
  const parts = parseRemote(remote);
  if (!parts) {
    console.warn(`mycelium: can't subscribe to push events: unexpected remote ${remote}`);
    return null;
  }
  const api: CfApi = { token, fetcher };
  try {
    const queueId = await eventsQueueId(api, parts.accountId, parts.namespace, host);
    const sub = await cfFetch<{ id: string }>(
      api,
      "POST",
      `/accounts/${parts.accountId}/event_subscriptions/subscriptions`,
      {
        name: `${parts.namespace}-${parts.repo}`.slice(0, 64),
        enabled: true,
        source: { type: "artifacts.repo", namespace: parts.namespace, repo_name: parts.repo },
        destination: { type: "queues.queue", queue_id: queueId },
        events: ["pushed"],
      },
    );
    return subscriptionKey(parts.accountId, sub.id);
  } catch (error) {
    console.warn(`mycelium: push events for ${parts.repo} not subscribed:`, error);
    return null;
  }
}

/** Delete a subscription made by subscribeRepo. Fails soft (logs). */
export async function unsubscribeRepo(
  token: string | undefined,
  subscription: string | null,
  fetcher?: typeof fetch,
): Promise<boolean> {
  if (!token || !subscription) return false;
  const [accountId, id] = subscription.split(":", 2);
  if (!accountId || !id) return false;
  try {
    await cfFetch(
      { token, fetcher },
      "DELETE",
      `/accounts/${accountId}/event_subscriptions/subscriptions/${id}`,
    );
    return true;
  } catch (error) {
    console.warn(`mycelium: couldn't delete event subscription ${id}:`, error);
    return false;
  }
}
