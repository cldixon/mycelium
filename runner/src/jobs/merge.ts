import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MergeJob, MergeResult } from "../../../instance/src/shared/jobs.ts";
import { gitIn, setupRepo, type Git } from "../git.ts";
import { clip, resolveRev } from "./compare.ts";

/**
 * Merge a pull request: in a scratch worktree of the cached clone, merge,
 * squash or rebase head onto base, then push base. On a conflict, report the
 * conflicted files and the diff with conflict markers, and push nothing.
 */
export async function merge(job: MergeJob): Promise<MergeResult> {
  const remote = job.remotes[0]?.name;
  if (!remote) throw new Error("merge needs a remote");
  if (!["merge", "squash", "rebase"].includes(job.method)) {
    throw new Error(`unknown merge method: ${job.method}`);
  }
  const repo = await setupRepo(job.repo, job.remotes);
  const [baseSha, headSha] = await Promise.all([
    resolveRev(repo, remote, job.base),
    resolveRev(repo, remote, job.head),
  ]);
  if (job.headSha && job.headSha !== headSha) {
    throw new Error(`${job.head} moved to ${headSha.slice(0, 7)}; review the new commits first`);
  }
  const ahead = await repo("rev-list", "--count", `${baseSha}..${headSha}`);
  if (ahead.out === "0") throw new Error(`${job.head} has nothing that ${job.base} doesn't have`);

  const ident = {
    GIT_AUTHOR_NAME: job.author.name,
    GIT_AUTHOR_EMAIL: job.author.email,
    GIT_COMMITTER_NAME: job.author.name,
    GIT_COMMITTER_EMAIL: job.author.email,
  };
  const tmp = await mkdtemp(join(tmpdir(), "merge-"));
  const dir = join(tmp, "wt");
  const start = job.method === "rebase" ? headSha : baseSha;
  const add = await repo("worktree", "add", "--detach", "-q", dir, start);
  if (add.code !== 0) throw new Error(`worktree add failed: ${add.err}`);
  // This job's credentials (repo.env) plus the merge identity, for the push.
  const git = gitIn(dir, { ...repo.env, ...ident });
  try {
    let r;
    if (job.method === "merge") {
      r = await git("merge", "--no-ff", "--no-edit", "-m", job.message, headSha);
    } else if (job.method === "squash") {
      r = await git("merge", "--squash", headSha);
      if (r.code === 0) {
        if ((await git("diff", "--cached", "--quiet")).code === 0) {
          throw new Error(`${job.head} makes no changes to ${job.base}`);
        }
        r = await git("commit", "-q", "-m", job.message);
      }
    } else {
      r = await git("rebase", baseSha);
    }
    if (r.code !== 0) {
      const conflict = await conflicts(git);
      if (conflict) return conflict;
      throw new Error(`${job.method} failed: ${r.err || r.out}`);
    }
    const sha = (await git("rev-parse", "HEAD")).out;
    const push = await git("push", "-q", remote, `HEAD:refs/heads/${job.base}`);
    if (push.code !== 0) {
      throw new Error(`push to ${job.base} failed (did it move? try again): ${push.err}`);
    }
    if (job.method === "rebase") {
      // Point head at the rebased commits too, unless it moved meanwhile. The
      // merge has landed either way, so a failure here is only logged.
      const lease = `--force-with-lease=refs/heads/${job.head}:${headSha}`;
      const moved = await git("push", "-q", lease, remote, `HEAD:refs/heads/${job.head}`);
      if (moved.code !== 0) console.warn(`rebase: ${job.head} not updated: ${moved.err}`);
    }
    return { status: "merged", sha, baseSha, headSha };
  } finally {
    await repo("worktree", "remove", "--force", dir);
    await rm(tmp, { recursive: true, force: true });
    await repo("worktree", "prune");
  }
}

/** The conflict report, or null when nothing is unmerged (some other failure). */
async function conflicts(git: Git): Promise<MergeResult | null> {
  const files = (
    await git("-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=U")
  ).out
    .split("\n")
    .filter(Boolean);
  if (files.length === 0) return null;
  const diff = (await git("-c", "core.quotePath=false", "diff", "--no-color")).out;
  return { status: "conflict", files: [...new Set(files)], diff: clip(diff) };
}
