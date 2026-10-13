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
