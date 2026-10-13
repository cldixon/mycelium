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
