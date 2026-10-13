import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Remote } from "../../instance/src/shared/jobs.ts";

/** Where clones live while the container is warm: /work/<repo>. */
export const WORK_DIR = process.env.MYCELIUM_WORK_DIR ?? "/work";

export type ShResult = { code: number; out: string; err: string };

/** Run a command; never throws on a non-zero exit. */
export async function sh(
  cwd: string,
  cmd: string[],
  env: Record<string, string> = {},
  stdin?: string,
): Promise<ShResult> {
  const p = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return {
    code,
    out: out.trim(),
    err: err
      .split("\n")
      .filter((l) => !l.startsWith("warning: "))
      .join("\n")
      .trim(),
  };
}

export type Git = ((...args: string[]) => Promise<ShResult>) & {
  dir: string;
  /** The environment every command gets (credentials included); pass it on to worktrees. */
  env: Record<string, string>;
};

/** A git runner bound to `dir`, with `env` (e.g. `authEnv`) on every command. */
export function gitIn(dir: string, env: Record<string, string> = {}): Git {
  const git = ((...args: string[]) => sh(dir, ["git", ...args], env)) as Git;
  git.dir = dir;
  git.env = env;
  return git;
}

/**
 * Per-command credentials: each remote's token as an `http.<url>.extraHeader`
 * through git's GIT_CONFIG_* environment, never written into the cached
 * clone's config. Jobs on one repo share that clone, so a credential stored
 * there would leak into a concurrent job (a workflow's read token under a
 * merge's push).
 */
export function authEnv(remotes: Remote[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(remotes.length) };
  remotes.forEach((r, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `http.${r.url}.extraHeader`;
    env[`GIT_CONFIG_VALUE_${i}`] = `Authorization: Bearer ${r.token}`;
  });
  return env;
}

/** One repo's clone setup and fetches at a time: concurrent fetches collide on git's locks. */
const locks = new Map<string, Promise<unknown>>();
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

/** Clones whose config was checked for credentials stored by older runners. */
const cleaned = new Set<string>();

/** Repo names become directory names; keep them to a safe alphabet. */
function safeName(repo: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo.startsWith(".")) {
    throw new Error(`bad repo name: ${repo}`);
  }
  return repo;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * A scratch repo for `repo` with one git remote per entry, fetched. The
 * clone is cached under /work/<repo> and reused while the container stays
 * warm, so a job fetches only what changed since the last one; when every
 * commit in `want` is already there, nothing is fetched at all. The returned
 * runner carries this job's tokens in its environment (`authEnv`), so
 * concurrent jobs on one repo never see each other's credentials. Setup and
 * fetch run under the repo's lock.
 */
export async function setupRepo(
  repo: string,
  remotes: Remote[],
  { want = [] }: { want?: string[] } = {},
): Promise<Git> {
  const dir = join(WORK_DIR, safeName(repo));
  const git = gitIn(dir, authEnv(remotes));
  await withRepoLock(dir, async () => {
    if (!(await exists(join(dir, ".git")))) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const init = await sh(dir, ["git", "init", "-q"]);
      if (init.code !== 0) throw new Error(`git init failed: ${init.err}`);
      cleaned.add(dir);
    }
    if (!cleaned.has(dir)) {
      // Older runners stored tokens in the clone's config; drop them.
      const stored = (
        await git("config", "--name-only", "--get-regexp", "^http\\..*\\.extraheader$")
      ).out
        .split("\n")
        .filter(Boolean);
      for (const key of new Set(stored)) await git("config", "--unset-all", key);
      cleaned.add(dir);
    }
    const existing = new Set((await git("remote", "-v")).out.split("\n").filter(Boolean));
    for (const r of remotes) {
      if (existing.has(`${r.name}\t${r.url} (fetch)`)) continue;
      const add = await git("remote", "add", r.name, r.url);
      if (add.code !== 0) await git("remote", "set-url", r.name, r.url);
    }
    if (want.length > 0 && (await hasCommits(git, want))) return;
    for (const r of remotes) {
      const f = await git("fetch", "-q", "--prune", "--tags", "--force", r.name);
      if (f.code !== 0) throw new Error(`git fetch ${r.name} failed: ${f.err}`);
    }
  });
  return git;
}

/** True when every one of `shas` is a commit the clone already has. */
export async function hasCommits(git: Git, shas: string[]): Promise<boolean> {
  if (!shas.every((s) => /^[0-9a-f]{40}$/.test(s))) return false;
  const r = await sh(git.dir, ["git", "cat-file", "--batch-check"], {}, `${shas.join("\n")}\n`);
  return r.code === 0 && r.out.split("\n").every((l) => / commit \d+$/.test(l));
}
