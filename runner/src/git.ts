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
): Promise<ShResult> {
  const p = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
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

export type Git = ((...args: string[]) => Promise<ShResult>) & { dir: string };

/** A git runner bound to `dir`. Throws when `check` is set and git fails. */
export function gitIn(dir: string, env: Record<string, string> = {}): Git {
  const git = ((...args: string[]) => sh(dir, ["git", ...args], env)) as Git;
  git.dir = dir;
  return git;
}

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
 * A scratch repo for `repo` with one git remote per entry, fetched. Each
 * remote authenticates with its own token through `http.<url>.extraHeader`
 * (tokens are short-lived, so they're rewritten on every job). The clone is
 * cached under /work/<repo> and reused while the container stays warm.
 */
export async function setupRepo(repo: string, remotes: Remote[]): Promise<Git> {
  const dir = join(WORK_DIR, safeName(repo));
  if (!(await exists(join(dir, ".git")))) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const init = await sh(dir, ["git", "init", "-q"]);
    if (init.code !== 0) throw new Error(`git init failed: ${init.err}`);
  }
  const git = gitIn(dir);
  const existing = new Set((await git("remote")).out.split("\n").filter(Boolean));
  for (const r of remotes) {
    await git("config", "--unset-all", `http.${r.url}.extraHeader`);
    await git("config", "--add", `http.${r.url}.extraHeader`, `Authorization: Bearer ${r.token}`);
    if (existing.has(r.name)) await git("remote", "set-url", r.name, r.url);
    else await git("remote", "add", r.name, r.url);
  }
  for (const r of remotes) {
    const f = await git("fetch", "-q", "--prune", "--tags", "--force", r.name);
    if (f.code !== 0) throw new Error(`git fetch ${r.name} failed: ${f.err}`);
  }
  return git;
}
