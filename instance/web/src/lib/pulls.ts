import type {
  DiffResult,
  MergeMethod,
  Pull,
  PullBranches,
  PullComment,
  PullList,
} from "$shared/types";
import { timeAgo } from "@mycelium/ui";
import { get, request, seg } from "$lib/api";

/** "3h ago", "just now", or the date when it's long past. */
export function ago(iso: string): string {
  const t = timeAgo(iso);
  return t === "now" ? "just now" : /^\d{4}-/.test(t) ? `on ${t}` : `${t} ago`;
}

/** Client for /api/repos/:repo/pulls (the Pulls feature). */

const base = (repo: string) => `/api/repos/${seg(repo)}/pulls`;

export const pulls = {
  list: (repo: string, state: "open" | "closed" | "all" = "open", fetcher?: typeof fetch) =>
    get<PullList>(`${base(repo)}?state=${state}`, fetcher),
  get: (repo: string, n: number, fetcher?: typeof fetch) =>
    get<Pull>(`${base(repo)}/${n}`, fetcher),
  branches: (repo: string, fetcher?: typeof fetch) =>
    get<PullBranches>(`${base(repo)}/branches`, fetcher),
  compare: (repo: string, baseBranch: string, head: string) =>
    get<DiffResult>(
      `${base(repo)}/compare?base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(head)}`,
    ),
  create: (repo: string, body: { title: string; body: string; head: string; base: string }) =>
    request<Pull>("POST", base(repo), body),
  update: (
    repo: string,
    n: number,
    body: { title?: string; body?: string; state?: "open" | "closed" },
  ) => request<Pull>("PATCH", `${base(repo)}/${n}`, body),
  diff: (repo: string, n: number) => get<DiffResult>(`${base(repo)}/${n}/diff`),
  comments: (repo: string, n: number, fetcher?: typeof fetch) =>
    get<{ comments: PullComment[] }>(`${base(repo)}/${n}/comments`, fetcher).then(
      (r) => r.comments,
    ),
  comment: (repo: string, n: number, body: string) =>
    request<PullComment>("POST", `${base(repo)}/${n}/comments`, { body }),
};

/** A workflow run as the Actions feature lists it (only the fields the merge box shows). */
export type RunSummary = { number: number; workflow: string; status: string };

/**
 * Workflow runs for a commit, from the Actions feature's `GET /runs?sha=`.
 * Null when that endpoint isn't there (or fails), so the slot hides.
 */
export async function runsFor(repo: string, sha: string): Promise<RunSummary[] | null> {
  try {
    const res = await fetch(`/api/repos/${seg(repo)}/runs?sha=${encodeURIComponent(sha)}`, {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { runs?: unknown };
    if (!Array.isArray(data.runs)) return null;
    // Newest first: keep the latest run of each workflow.
    const latest = new Map<string, RunSummary>();
    for (const r of data.runs as RunSummary[]) {
      if (r && typeof r === "object" && !latest.has(r.workflow)) latest.set(r.workflow, r);
    }
    return [...latest.values()];
  } catch {
    return null;
  }
}

/** The merge conflict body of a 409 from merge (ApiError keeps only the message). */
export async function mergeOrConflict(
  repo: string,
  n: number,
  body: { method: MergeMethod; message?: string; headSha?: string },
): Promise<{ pull: Pull } | { conflict: { files: string[]; diff: string } } | { error: string }> {
  const res = await fetch(`${base(repo)}/${n}/merge`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { pull: data as Pull };
  if (res.status === 409 && data.status === "conflict") {
    return { conflict: { files: data.files ?? [], diff: data.diff ?? "" } };
  }
  return { error: data.error ?? `Merge failed (${res.status})` };
}
