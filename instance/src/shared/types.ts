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
  /** When the latest push event arrived, or null (no pushes, or no subscription). */
  pushedAt: string | null;
};

/** A repos row, optionally with the latest push time (`MAX(pushes.at)`). */
export type RepoRowWithPush = RepoRow & { pushed_at?: string | null };

export function toRepo(row: RepoRowWithPush): Repo {
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
    pushedAt: row.pushed_at ?? null,
  };
}

/** The later of updatedAt and pushedAt: what "Updated …" in the repo list means. */
export function lastActivity(repo: Pick<Repo, "updatedAt" | "pushedAt">): string {
  return repo.pushedAt && repo.pushedAt > repo.updatedAt ? repo.pushedAt : repo.updatedAt;
}

/**
 * Repo names are one URL path segment. Static web routes win over `[repo]`,
 * so their names are reserved.
 */
export const RESERVED_REPO_NAMES = ["signin", "settings", "api", "oauth", "health", "new"];
export const REPO_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

/** Why `name` can't be a repo name, or null when it can. */
export function repoNameError(name: string): string | null {
  if (!name) return "Name is required";
  if (!REPO_NAME_PATTERN.test(name)) {
    return "Use up to 100 letters, digits, '.', '-' or '_', starting with a letter or digit";
  }
  if (name.includes("--")) return "Name can't contain '--'";
  if (name.toLowerCase().endsWith(".git")) return "Name can't end in '.git'";
  if (RESERVED_REPO_NAMES.includes(name.toLowerCase())) return `'${name}' is reserved`;
  return null;
}

/** Why `name` can't be a branch name, or null (a light subset of git check-ref-format). */
export function branchNameError(name: string): string | null {
  if (!name) return "Branch is required";
  if (
    name.length > 255 ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.startsWith("-") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name === "@"
  ) {
    return "Not a valid branch name";
  }
  return null;
}

/** POST /api/repos */
export type CreateRepoInput = {
  name: string;
  description?: string | null;
  visibility?: Visibility;
  /** A public https git URL to import instead of creating an empty repo. */
  importUrl?: string | null;
  /** The branch to import (defaults to the source's HEAD). */
  branch?: string | null;
};

/** PATCH /api/repos/:repo */
export type UpdateRepoInput = {
  description?: string | null;
  visibility?: Visibility;
  defaultBranch?: string;
};

export type GitScope = "read" | "write";

/** POST /api/repos/:repo/git-credentials {scope, ttl?} */
export type GitCredentials = {
  remote: string;
  token: string;
  scope: GitScope;
  expiresAt: string;
};

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
//
// Refs in these routes: the API takes the ref as the rest of the URL path
// (`/tree/feature/x?path=src`), so branch names with `/` need no escaping; the
// path is always in `?path=`. A ref is a branch, a tag or a full commit sha.
// Web URLs (`/:repo/tree/feature/x/src`) are split with `splitRefPath`
// (`shared/refpath.ts`): the longest known branch/tag prefix wins.

export type Person = { name: string; email: string };

export type CommitSummary = {
  sha: string;
  treeSha: string;
  /** The full message. */
  message: string;
  /** The message's first line. */
  title: string;
  author: Person;
  committer: Person;
  /** ISO timestamps. */
  authoredAt: string;
  committedAt: string;
  parents: string[];
};

/** A branch with its tip commit (GET /refs?commits=1 only). */
export type BranchInfo = RefInfo & { commit?: CommitSummary | null };

/** GET /api/repos/:repo/refs[?commits=1] */
export type RepoRefs = {
  defaultBranch: string;
  /** The branch HEAD points at, when the remote says. */
  head: string | null;
  branches: BranchInfo[];
  tags: RefInfo[];
  /** No branches yet: nothing has been pushed. */
  empty: boolean;
};

export type TreeEntryType = "tree" | "blob" | "symlink" | "gitlink" | "exec";

export type TreeEntry = {
  name: string;
  /** Repository-relative path. */
  path: string;
  type: TreeEntryType;
  mode: string;
  sha: string;
};

/** GET /api/repos/:repo/tree/:ref?path= */
export type TreeListing = {
  ref: string;
  /** The commit `ref` resolved to. */
  commit: CommitSummary;
  /** "" for the root. */
  path: string;
  /** Directories first, then by name. */
  entries: TreeEntry[];
  /** Name of a README entry in this directory, if any. */
  readme: string | null;
};

/** GET /api/repos/:repo/blob/:ref?path= (JSON; ?raw=1 answers the bytes) */
export type BlobView = {
  ref: string;
  path: string;
  name: string;
  size: number;
  /** Contains NUL bytes in its first 8 KB. */
  binary: boolean;
  /** Bigger than the text limit (1 MB); text is null. */
  tooLarge: boolean;
  /** UTF-8 text; null when binary or too large. */
  text: string | null;
  contentType: string;
};

/** GET /api/repos/:repo/readme/:ref?path= */
export type Readme = { path: string; name: string; text: string; markdown: boolean };

/** GET /api/repos/:repo/commits/:ref?limit&offset (first-parent history, newest first) */
export type CommitList = {
  ref: string;
  commits: CommitSummary[];
  limit: number;
  offset: number;
  hasMore: boolean;
};

/** One hunk of a unified diff; lines start with " ", "+", "-" or "\\". */
export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type FileChangeStatus = "added" | "deleted" | "modified";

export type CommitFileDiff = {
  path: string;
  status: FileChangeStatus;
  oldMode: string | null;
  newMode: string | null;
  oldSha: string | null;
  newSha: string | null;
  binary: boolean;
  /** Over the per-file or per-commit size budget, or the diff gave up: no hunks. */
  tooLarge: boolean;
  additions: number;
  deletions: number;
  /** Null when binary or too large. */
  hunks: DiffHunk[] | null;
};

/** GET /api/repos/:repo/commit/:sha: the commit and its diff against its first parent. */
export type CommitDetail = {
  commit: CommitSummary;
  /** The first parent diffed against; null for a root commit. */
  parent: string | null;
  files: CommitFileDiff[];
  /** Number of changed files (may exceed files.length when capped). */
  totalFiles: number;
  /** More than 300 changed files: only the first 300 are listed. */
  truncated: boolean;
  additions: number;
  deletions: number;
};

export type Contributor = {
  name: string;
  email: string;
  commits: number;
  firstAt: string;
  lastAt: string;
  /** Distinct values of `Agent:` trailers on their commits. */
  agents: string[];
};

/** GET /api/repos/:repo/contributors (up to 1000 commits of the default branch) */
export type ContributorList = {
  ref: string;
  /** Commits looked at. */
  scanned: number;
  /** The history is longer than what was scanned. */
  truncated: boolean;
  /** Most commits first. */
  contributors: Contributor[];
};

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

/** POST /api/tokens: the secret appears in this response only. */
export type CreatedApiToken = { token: string; apiToken: ApiTokenInfo };

/** GET /api/settings (owner only). */
export type InstanceSettings = {
  /** INSTANCE_TITLE. */
  title: string;
  /** The @mycelium/instance version this Worker was built from. */
  version: string;
  owner: { did: string; handle: string | null };
  /** True when CF_API_TOKEN is set, so new repos get push event subscriptions. */
  pushEvents: boolean;
};
