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

export type DiffJob = {
  type: "diff";
  remotes: Remote[];
  repo: string;
  base: string;
  head: string;
};
export type DiffResult = {
  mergeBase: string;
  ahead: number;
  behind: number;
  mergeable: boolean;
  files: FileDiff[];
  commits: CommitInfo[];
};

export type MergeJob = {
  type: "merge";
  remotes: Remote[];
  repo: string;
  base: string;
  head: string;
  method: "merge" | "squash" | "rebase";
  message: string;
  author: { name: string; email: string };
};
export type MergeResult =
  { status: "merged"; sha: string } | { status: "conflict"; files: string[]; diff: string };

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
