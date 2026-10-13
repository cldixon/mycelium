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
