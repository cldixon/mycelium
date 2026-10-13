import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowJob } from "../../../instance/src/shared/jobs.ts";

const ident = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

describe("workflow job", () => {
  const dirs: string[] = [];
  let origin: string;
  let sha: string;
  let workflow: (
    job: WorkflowJob,
  ) => Promise<import("../../../instance/src/shared/jobs.ts").WorkflowResult>;

  beforeAll(async () => {
    const work = await mkdtemp(join(tmpdir(), "work-"));
    origin = await mkdtemp(join(tmpdir(), "origin-"));
    dirs.push(work, origin);
    process.env.MYCELIUM_WORK_DIR = work;
    ({ workflow } = await import(`./workflow.ts?work=${Date.now()}`));
    const { sh } = await import("../git.ts");
    await sh(origin, ["git", "init", "-q", "-b", "main"]);
    await writeFile(join(origin, "hello.txt"), "hi from the repo\n");
    await sh(origin, ["git", "add", "."]);
    await sh(origin, ["git", "commit", "-q", "-m", "first"], ident);
    sha = (await sh(origin, ["git", "rev-parse", "HEAD"])).out;
  });
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  const job = (steps: WorkflowJob["steps"], timeoutSec = 30): WorkflowJob => ({
    type: "workflow",
    remotes: [{ name: "demo", url: origin, token: "t" }],
    repo: "demo",
    sha,
    steps,
    timeoutSec,
  });

  test("runs steps in the checkout with CI env and combined output", async () => {
    const r = await workflow(
      job([
        { name: "cat", run: "cat hello.txt; echo oops >&2; echo $CI $MYCELIUM" },
        { name: "pwd", run: "test -f hello.txt && git rev-parse HEAD" },
      ]),
    );
    expect(r.status).toBe("success");
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]!.exitCode).toBe(0);
    expect(r.steps[0]!.log).toContain("hi from the repo");
    expect(r.steps[0]!.log).toContain("oops");
    expect(r.steps[0]!.log).toContain("true true");
    expect(r.steps[1]!.log.trim()).toBe(sha);
  });

  test("stops at the first failure", async () => {
    const r = await workflow(
      job([
        { name: "fail", run: "echo before; exit 3" },
        { name: "never", run: "echo never" },
      ]),
    );
    expect(r.status).toBe("failure");
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.exitCode).toBe(3);
    expect(r.steps[0]!.log).toContain("before");
  });

  test("a step timeout kills the process group", async () => {
    const t0 = Date.now();
    const r = await workflow(
      job([{ name: "sleep", run: "sleep 30 & sleep 30; echo done", timeoutSec: 1 }]),
    );
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.status).toBe("failure");
    expect(r.steps[0]!.timedOut).toBe(true);
    expect(r.steps[0]!.exitCode).toBeNull();
  });

  test("a bad sha is an error, not a failure", async () => {
    const r = await workflow({ ...job([{ name: "x", run: "true" }]), sha: "0".repeat(40) });
    expect(r.status).toBe("error");
    expect(r.error).toContain("checkout");
  });

  test("long logs keep the tail", async () => {
    const r = await workflow(job([{ name: "loud", run: "seq 1 40000" }]));
    expect(r.status).toBe("success");
    expect(r.steps[0]!.log.length).toBeLessThan(70 * 1024);
    expect(r.steps[0]!.log).toContain("not kept");
    expect(r.steps[0]!.log.trimEnd().endsWith("40000")).toBe(true);
  });

  test("a re-run of a commit the clone has doesn't fetch", async () => {
    const { WORK_DIR, gitIn, hasCommits } = await import("../git.ts");
    const clone = gitIn(join(WORK_DIR, "demo"));
    expect(await hasCommits(clone, [sha])).toBe(true);
    expect(await hasCommits(clone, ["1".repeat(40)])).toBe(false);
    // An unreachable remote: works only because nothing is fetched.
    const r = await workflow({
      ...job([{ name: "x", run: "true" }]),
      remotes: [{ name: "demo", url: join(origin, "gone"), token: "t" }],
    });
    expect(r.status).toBe("success");
  });

  test("background jobs report progress while they run", async () => {
    const { startBackground, backgroundStatus } = await import("../background.ts");
    const id = `t-${Date.now()}`;
    const bg = {
      ...job([
        { name: "one", run: "echo first" },
        { name: "two", run: "echo tick; sleep 1.5; echo tock" },
      ]),
      id,
    };
    const first = startBackground(bg, workflow);
    expect(first.done).toBe(false);
    // the same id again is the same job
    expect(startBackground(bg, workflow).id).toBe(id);
    let seen = false;
    for (let i = 0; i < 100; i++) {
      const s = backgroundStatus(id)!;
      if (s.done) break;
      if (s.progress.current && s.progress.current.log.includes("tick")) {
        expect(s.progress.steps).toHaveLength(1);
        expect(s.progress.current.log).not.toContain("tock");
        seen = true;
      }
      await Bun.sleep(50);
    }
    expect(seen).toBe(true);
    for (let i = 0; i < 100 && !backgroundStatus(id)!.done; i++) await Bun.sleep(50);
    const end = backgroundStatus(id)!;
    expect(end.done && end.result.status).toBe("success");
    expect(end.progress.current).toBeNull();
    expect(end.progress.steps[1]!.log).toContain("tock");
    expect(backgroundStatus("nope")).toBeNull();
  });
});
