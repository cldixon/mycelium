import type { DiffJob, DiffResult } from "../../../instance/src/shared/jobs.ts";
import { setupRepo } from "../git.ts";
import {
  LOG_FORMAT,
  MAX_COMMITS,
  parseLog,
  parseMergeTree,
  parseUnifiedDiff,
  resolveRev,
} from "./compare.ts";

/**
 * Compare head with base (a pull request): merge base, ahead/behind, a
 * trial merge for mergeability (`git merge-tree`, which writes objects but
 * no refs or worktree), the changed files and head's commits.
 */
export async function diff(job: DiffJob): Promise<DiffResult> {
  const remote = job.remotes[0]?.name;
  if (!remote) throw new Error("diff needs a remote");
  const git = await setupRepo(job.repo, job.remotes);
  const [baseSha, headSha] = await Promise.all([
    resolveRev(git, remote, job.base),
    resolveRev(git, remote, job.head),
  ]);
  const mb = await git("merge-base", baseSha, headSha);
  if (mb.code !== 0 || !mb.out) throw new Error(`${job.head} and ${job.base} share no history`);
  const mergeBase = mb.out;

  const [counts, trial, patch, log] = await Promise.all([
    git("rev-list", "--left-right", "--count", `${baseSha}...${headSha}`),
    git("merge-tree", "--write-tree", "--name-only", "--no-messages", baseSha, headSha),
    git(
      "-c",
      "core.quotePath=false",
      "diff",
      "-M",
      "--no-color",
      "--no-ext-diff",
      mergeBase,
      headSha,
    ),
    git("log", "--reverse", `--max-count=${MAX_COMMITS}`, LOG_FORMAT, `${baseSha}..${headSha}`),
  ]);
  if (counts.code !== 0) throw new Error(`rev-list failed: ${counts.err}`);
  if (trial.code !== 0 && trial.code !== 1) throw new Error(`trial merge failed: ${trial.err}`);
  if (patch.code !== 0) throw new Error(`diff failed: ${patch.err}`);
  const [behind, ahead] = counts.out.split(/\s+/).map(Number) as [number, number];
  const { conflicts } = parseMergeTree(trial.out);
  const { files, truncated } = parseUnifiedDiff(patch.out);
  return {
    mergeBase,
    ahead,
    behind,
    mergeable: trial.code === 0,
    conflicts: trial.code === 0 ? [] : conflicts,
    baseSha,
    headSha,
    files,
    truncated,
    commits: parseLog(log.out),
  };
}
