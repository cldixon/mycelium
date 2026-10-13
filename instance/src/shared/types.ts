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

export type RunRow = {
  id: number;
  repo: string;
  number: number;
  workflow: string;
  event: RunEvent;
  ref: string;
  sha: string;
  pull_number: number | null;
  status: RunStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type RunStepRow = {
  run_id: number;
  idx: number;
  name: string;
  command: string;
  status: StepStatus;
  exit_code: number | null;
  log: string;
  started_at: string | null;
  finished_at: string | null;
};

/** One step of a workflow file. */
export type WorkflowStep = {
  name: string;
  run: string;
  /** Per-step cap in seconds (from `timeout-minutes`), if the file sets one. */
  timeoutSec?: number;
};

/** A parsed `.mycelium/workflows/*.yml` file. */
export type Workflow = {
  /** Path in the repo, e.g. ".mycelium/workflows/test.yml". */
  path: string;
  /** `name:`, or the file name without its extension. Runs are keyed by it. */
  name: string;
  /** Events that start it. `manual` is always allowed and not listed unless the file says so. */
  on: RunEvent[];
  steps: WorkflowStep[];
  /** Whole-run cap in seconds (from `timeout-minutes`). */
  timeoutSec: number;
};

/** A workflow file that didn't parse or validate. */
export type WorkflowError = { path: string; error: string };

/** GET /api/repos/:repo/workflows?ref= */
export type WorkflowList = {
  ref: string;
  sha: string;
  workflows: Workflow[];
  errors: WorkflowError[];
};

/** A run as the API returns it. */
export type Run = {
  number: number;
  workflow: string;
  event: RunEvent;
  /** Branch name (or "refs/..." for anything else), as triggered. */
  ref: string;
  sha: string;
  pullNumber: number | null;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunStep = {
  idx: number;
  name: string;
  command: string;
  status: StepStatus;
  exitCode: number | null;
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
};

/** GET /api/repos/:repo/runs/:n */
export type RunDetail = Run & { steps: RunStep[] };

export function toRun(row: RunRow): Run {
  return {
    number: row.number,
    workflow: row.workflow,
    event: row.event,
    ref: row.ref,
    sha: row.sha,
    pullNumber: row.pull_number,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function toRunStep(row: RunStepRow): RunStep {
  return {
    idx: row.idx,
    name: row.name,
    command: row.command,
    status: row.status,
    exitCode: row.exit_code,
    log: row.log,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

// --- Settings (/api/tokens) --------------------------------------------------

export type ApiTokenInfo = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};
