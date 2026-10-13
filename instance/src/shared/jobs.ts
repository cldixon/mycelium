/**
 * The runner container protocol (ARCHITECTURE.md "Runner container
 * protocol"). The Worker sends a Job to `POST http://runner/jobs` and gets
 * the matching result back as JSON. Pure types: the runner (runner/) imports
 * this file with `import type`.
 */

/** A git remote the job may use, with a short-lived repo-scoped token. */
export type Remote = { name: string; url: string; token: string };

export type FileDiff = {
  path: string;
  /** For renames. */
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  /** Unified diff text for this file (empty when binary or too large). */
  patch: string;
};

export type CommitInfo = {
  sha: string;
  parents: string[];
  author: { name: string; email: string; date: string };
  message: string;
};

export type PingJob = { type: "ping" };
export type PingResult = { ok: true; git: string; bun: string };

/**
 * Compare `head` with `base` in the first remote. Each is a branch name of
 * that remote or a commit sha (merged pull requests are diffed by sha).
 */
export type DiffJob = {
  type: "diff";
  remotes: Remote[];
  repo: string;
  base: string;
  head: string;
};
export type DiffResult = {
  mergeBase: string;
  /** Commits on head that base doesn't have. */
  ahead: number;
  /** Commits on base that head doesn't have. */
  behind: number;
  /** A trial merge of head into base has no conflicts. */
  mergeable: boolean;
  /** Paths that conflict in the trial merge (empty when mergeable). */
  conflicts: string[];
  /** The commits base and head resolved to. */
  baseSha: string;
  headSha: string;
  /** Files from the merge base to head, capped (see `truncated`). */
  files: FileDiff[];
  /** True when files or patches were dropped to stay under the caps. */
  truncated: boolean;
  /** Head-only commits, oldest first (capped). */
  commits: CommitInfo[];
};

/**
 * Merge branch `head` into branch `base` of the first remote and push base.
 * "merge" makes a merge commit, "squash" one commit with head's changes,
 * "rebase" replays head's commits onto base and fast-forwards base to them
 * (`message` is unused then). On conflict nothing is pushed.
 */
export type MergeJob = {
  type: "merge";
  remotes: Remote[];
  repo: string;
  base: string;
  head: string;
  method: "merge" | "squash" | "rebase";
  message: string;
  /** Author and committer of the commits the merge creates. */
  author: { name: string; email: string };
  /** Refuse to merge if head no longer points here (it moved since it was reviewed). */
  headSha?: string;
};
export type MergeResult =
  | { status: "merged"; sha: string; baseSha: string; headSha: string }
  | { status: "conflict"; files: string[]; diff: string };

export type WorkflowJob = {
  type: "workflow";
  remotes: Remote[];
  repo: string;
  sha: string;
  steps: { name: string; run: string }[];
  timeoutSec: number;
};
export type WorkflowResult = {
  status: "success" | "failure" | "error";
  steps: { exitCode: number | null; log: string; durationMs: number }[];
};

export type Job = PingJob | DiffJob | MergeJob | WorkflowJob;

/** The result type for each job type. */
export type JobResult<J extends Job> = J extends PingJob
  ? PingResult
  : J extends DiffJob
    ? DiffResult
    : J extends MergeJob
      ? MergeResult
      : J extends WorkflowJob
        ? WorkflowResult
        : never;

/** What the runner answers when a job throws or its type is unknown (HTTP 4xx/5xx). */
export type JobError = { error: string };
