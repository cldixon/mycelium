/**
 * Types shared by the Worker and the web app (instance/web imports this file
 * through the `$shared` alias). Pure types only: nothing here may import
 * Workers or browser APIs.
 *
 * Each feature adds its API shapes in its own section below.
 */

export type Visibility = "private" | "public";

// --- D1 rows (snake_case, as stored) ----------------------------------------

export type RepoRow = {
  name: string;
  description: string | null;
  visibility: Visibility;
  default_branch: string;
  remote: string;
  source_url: string | null;
  subscription_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PushRow = {
  id: number;
  repo: string;
  ref: string;
  before: string | null;
  after: string | null;
  /** JSON: PushCommit[], newest first (as Artifacts sends them). */
  commits: string;
  pusher: string | null;
  at: string;
};

export type PullState = "open" | "closed" | "merged";
export type MergeMethod = "merge" | "squash" | "rebase";
export type RunEvent = "push" | "pull_request" | "manual";
export type RunStatus = "queued" | "running" | "success" | "failure" | "error" | "cancelled";
export type StepStatus = "pending" | "running" | "success" | "failure" | "error" | "skipped";

// --- Auth (/api/auth) --------------------------------------------------------

export type AuthStatus = {
  claimed: boolean;
  owner: string | null;
  /** The owner's handle, for `handle / repo`. Null until resolved. */
  handle: string | null;
  signedIn: boolean;
  /** INSTANCE_TITLE. */
  title: string;
};

// --- Repos (/api/repos) ------------------------------------------------------

export type Repo = {
  name: string;
  description: string | null;
  visibility: Visibility;
  defaultBranch: string;
  remote: string;
  sourceUrl: string | null;
  /** True when push events are subscribed (needs CF_API_TOKEN). */
  pushEvents: boolean;
  createdAt: string;
  updatedAt: string;
};

export function toRepo(row: RepoRow): Repo {
  return {
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultBranch: row.default_branch,
    remote: row.remote,
    sourceUrl: row.source_url,
    pushEvents: row.subscription_id !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type RefInfo = { name: string; sha: string };

/** GET /api/repos/:repo/refs */
export type Refs = {
  /** The branch HEAD points at, e.g. "main". */
  head?: string;
  branches: RefInfo[];
  tags: RefInfo[];
};

/** A commit as Artifacts push events list it. */
export type PushCommit = {
  id: string;
  message: string;
  timestamp: string;
  author: { name: string; email: string };
  parents?: string[];
};

// --- Code (/api/repos/:repo/tree, blob, commits, commit, contributors) ------

// --- Pulls (/api/repos/:repo/pulls) ------------------------------------------

export type { CommitInfo, DiffResult, FileDiff } from "./jobs.js";

export type PullRow = {
  id: number;
  repo: string;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: PullState;
  author: string;
  head_sha: string | null;
  base_sha: string | null;
  merge_sha: string | null;
  merge_method: MergeMethod | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
};

export type Pull = {
  number: number;
  title: string;
  body: string;
  /** Branch names: head is merged into base. */
  head: string;
  base: string;
  state: PullState;
  /** The owner's handle (or DID) when it was opened. */
  author: string;
  headSha: string | null;
  /** While open, base's tip; once merged, base's tip just before the merge. */
  baseSha: string | null;
  mergeSha: string | null;
  mergeMethod: MergeMethod | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
};

export function toPull(row: PullRow): Pull {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    head: row.head,
    base: row.base,
    state: row.state,
    author: row.author,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    mergeSha: row.merge_sha,
    mergeMethod: row.merge_method,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    mergedAt: row.merged_at,
  };
}

/** GET /pulls?state=open|closed|all. `closed` includes merged. */
export type PullList = { pulls: Pull[]; counts: { open: number; closed: number } };

export type PullComment = { id: number; author: string; body: string; createdAt: string };

/** GET /pulls/branches: what a pull request can compare. */
export type PullBranches = { defaultBranch: string; branches: RefInfo[] };

/** POST /pulls/:n/merge, 409: nothing was pushed. */
export type MergeConflict = { error: string; status: "conflict"; files: string[]; diff: string };

// --- Actions (/api/repos/:repo/runs, workflows) ------------------------------

// --- Settings (/api/tokens) --------------------------------------------------

export type ApiTokenInfo = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};
