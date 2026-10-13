import type { Refs, Run, RunDetail, RunStatus, WorkflowList } from "$shared/types";
import { get, request, seg } from "$lib/api";
import { personName } from "@mycelium/ui";

/** Who started a run: the owner by handle (else short DID), an agent by its name. */
export function actorName(
  actor: { name: string; kind: string },
  status?: { owner?: string | null; handle?: string | null } | null,
): string {
  return actor.kind === "agent"
    ? actor.name
    : personName(actor.name, { did: status?.owner, handle: status?.handle });
}

/** Client for Actions: workflows and runs (/api/repos/:repo/workflows, /runs). */

const base = (repo: string) => `/api/repos/${seg(repo)}`;

export const actions = {
  workflows: (repo: string, ref?: string, fetcher?: typeof fetch) =>
    get<WorkflowList>(
      `${base(repo)}/workflows${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
      fetcher,
    ),
  runs: (
    repo: string,
    q: { sha?: string; workflow?: string; limit?: number } = {},
    fetcher?: typeof fetch,
  ) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    const qs = params.size ? `?${params}` : "";
    return get<{ runs: Run[] }>(`${base(repo)}/runs${qs}`, fetcher).then((r) => r.runs);
  },
  run: (repo: string, number: number, fetcher?: typeof fetch) =>
    get<RunDetail>(`${base(repo)}/runs/${number}`, fetcher),
  start: (repo: string, workflow: string, ref?: string) =>
    request<RunDetail>("POST", `${base(repo)}/runs`, { workflow, ref }),
  rerun: (repo: string, number: number) =>
    request<RunDetail>("POST", `${base(repo)}/runs/${number}/rerun`),
  /** Branches and tags, for the ref picker (null when the repo can't list them). */
  refs: (repo: string) => get<Refs>(`${base(repo)}/refs`).catch(() => null),
};

/** True while a run may still change. */
export const isActive = (status: RunStatus) => status === "queued" || status === "running";

/** How long a run or step took (or has taken so far): 4s, 2m 05s, 1h 02m. */
export function duration(
  startedAt: string | null,
  finishedAt: string | null,
  now = Date.now(),
): string {
  if (!startedAt) return "-";
  const end = finishedAt ? Date.parse(finishedAt) : now;
  const s = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(s)) return "-";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Poll `fn` every `ms` while `active()` is true. Returns a stop function. */
export function poll(fn: () => Promise<unknown>, active: () => boolean, ms = 3000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    if (active()) await fn().catch(() => {});
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
