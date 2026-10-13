import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WorkflowJob,
  WorkflowResult,
  WorkflowStepResult,
} from "../../../instance/src/shared/jobs.ts";
import { setupRepo, sh } from "../git.ts";

/** Each step's log keeps at most this many characters (the tail). */
export const MAX_LOG_CHARS = 64 * 1024;
/** After SIGTERM, a timed-out step's process group gets this long before SIGKILL. */
const KILL_GRACE_MS = 3000;

/** One repo's fetches at a time: concurrent fetches into one clone collide on git's locks. */
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

/** A growing log that keeps only its tail. */
class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  private dropped = 0;
  constructor(private readonly max: number) {}
  push(text: string) {
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > this.max * 2 && this.chunks.length > 1) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
      this.dropped += first.length;
    }
  }
  toString(): string {
    let all = this.chunks.join("");
    let dropped = this.dropped;
    if (all.length > this.max) {
      dropped += all.length - this.max;
      all = all.slice(all.length - this.max);
    }
    return dropped ? `[mycelium: ${dropped} earlier characters not kept]\n${all}` : all;
  }
}

/**
 * Run one shell command in its own process group, with combined output and
 * a timeout that kills the whole group.
 */
export async function runStep(
  cwd: string,
  command: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<WorkflowStepResult> {
  const startedAt = new Date();
  const log = new TailBuffer(MAX_LOG_CHARS);
  // setsid makes bash the leader of a new process group (pid = pgid), so a
  // timeout can kill everything the step started.
  const proc = Bun.spawn(["setsid", "--wait", "bash", "-lc", command], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = () => new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const d = decoder();
    for await (const chunk of stream) log.push(d.decode(chunk, { stream: true }));
    log.push(d.decode());
  };
  let timedOut = false;
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill(signal);
      } catch {
        // already gone
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref?.();
  }, timeoutMs);
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) kill("SIGKILL"); // stragglers that ignored SIGTERM
  // Background children may hold the pipes open; don't wait on them forever.
  await Promise.race([pumps, Bun.sleep(timedOut ? 1000 : 5000)]);
  const durationMs = Date.now() - startedAt.getTime();
  return {
    exitCode: timedOut ? null : code,
    log: log.toString(),
    durationMs,
    startedAt: startedAt.toISOString(),
    ...(timedOut ? { timedOut: true } : {}),
  };
}

/**
 * Check out `sha` into a fresh directory (sharing objects with the cached
 * clone) and run the steps in order, stopping at the first failure.
 */
export async function workflow(job: WorkflowJob): Promise<WorkflowResult> {
  const t0 = Date.now();
  const deadline = t0 + job.timeoutSec * 1000;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "run-"));
    const checkout = dir;
    const err = await withLock(job.repo, async () => {
      const git = await setupRepo(job.repo, job.remotes);
      const clone = await sh("/", [
        "git",
        "clone",
        "-q",
        "--shared",
        "--no-checkout",
        git.dir,
        checkout,
      ]);
      if (clone.code !== 0) return `git clone failed: ${clone.err}`;
      const co = await sh(checkout, ["git", "checkout", "-q", "--detach", job.sha]);
      if (co.code !== 0) return `checkout of ${job.sha} failed: ${co.err}`;
      return null;
    });
    if (err) return { status: "error", steps: [], error: err };

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/root",
      LANG: "C.UTF-8",
      TERM: "dumb",
      CI: "true",
      MYCELIUM: "true",
      MYCELIUM_REPO: job.repo,
      MYCELIUM_SHA: job.sha,
    };
    const steps: WorkflowStepResult[] = [];
    for (const step of job.steps) {
      const left = deadline - Date.now();
      if (left <= 0) {
        steps.push({
          exitCode: null,
          log: `[mycelium: the run's ${job.timeoutSec} s limit was reached before this step]\n`,
          durationMs: 0,
          startedAt: new Date().toISOString(),
          timedOut: true,
        });
        return { status: "failure", steps };
      }
      const cap = step.timeoutSec ? Math.min(step.timeoutSec * 1000, left) : left;
      const result = await runStep(checkout, step.run, env, cap);
      steps.push(result);
      if (result.exitCode !== 0) return { status: "failure", steps };
    }
    return { status: "success", steps };
  } catch (error) {
    return {
      status: "error",
      steps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
