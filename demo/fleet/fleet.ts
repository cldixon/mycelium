/**
 * `bun run fleet`: scripted agents (no model behind them) working on one Mycelium repository at
 * the same time, through the instance's MCP server and plain git, exactly as a real agent would:
 * clone, branch, change code, test, push, open a pull request, wait for the required check,
 * merge. In the realistic scenario one agent breaks a test and fixes it from the run's log, two
 * agents collide on the same lines and the second rebases, and one reviews another's work.
 *
 *   bun run fleet --url https://<instance> --tokens fleet.tokens.json
 *        [--repo tinyroute] [--agents 5] [--scenario realistic|clean] [--pace 1500]
 *        [--setup] [--reset] [--owner-token myc_…] [--plan] [--no-color]
 *
 * See demo/fleet/README.md.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  bold,
  bunTest,
  Clone,
  dim,
  FleetAgent,
  line,
  parseCredentials,
  sleep,
  type Stats,
  testCounts,
  timelineOptions,
  ToolError,
} from "./agent";
import { dirFiles, type Feature, type Role } from "./features";
import { type Assignment, plan, preflight, reset, setup, WORKFLOW } from "./plan";

type PullView = {
  number: number;
  state: "open" | "closed" | "merged";
  headSha: string | null;
  mergeSha: string | null;
  author: string;
  comments: { id: number; author: string; authorKind: string; body: string }[];
  checks: { workflow: string; number: number; status: string }[];
  requiredChecks: {
    sha: string | null;
    satisfied: boolean;
    required: { workflow: string; status: string; runNumber?: number }[];
  } | null;
  diff: { mergeable?: boolean; conflicts?: string[]; headSha?: string; error?: string };
};

type RunView = {
  number: number;
  status: string;
  sha: string;
  steps: { name: string; status: string; exitCode: number | null; log?: string }[];
};

const SCENARIOS: Record<string, { description: string; slots: (n: number) => Role[] }> = {
  realistic: {
    description:
      "mostly clean pull requests; one breaks a test and fixes it, two collide and the second rebases, one agent reviews another",
    slots: (n) =>
      n >= 4
        ? ["clean", "breaker", "pair", "pair", ...Array<Role>(n - 4).fill("clean")]
        : (["clean", "breaker", "clean"] as Role[]).slice(0, n),
  },
  clean: {
    description: "every agent ships one independent change",
    slots: (n) => Array<Role>(n).fill("clean"),
  },
};

/** Shared between agents: who opened which pull request (the reviewer waits for its target). */
class Board {
  private opened = new Map<string, number>();
  private waiters = new Map<string, ((n: number) => void)[]>();
  open(feature: string, number: number) {
    this.opened.set(feature, number);
    for (const w of this.waiters.get(feature) ?? []) w(number);
  }
  wait(feature: string, ms: number): Promise<number | null> {
    const known = this.opened.get(feature);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const list = this.waiters.get(feature) ?? [];
      list.push(resolve);
      this.waiters.set(feature, list);
      setTimeout(() => resolve(null), ms);
    });
  }
}

type Job = Assignment & { review?: Feature; reviewAuthor?: string };

type Ctx = {
  url: string;
  repo: string;
  main: string;
  work: string;
  board: Board;
  deadline: number;
};

const short = (sha: string | null | undefined) => (sha ?? "").slice(0, 7);

/** One agent's whole task: from credentials to a merged pull request. */
async function runAgent(a: FleetAgent, job: Job, ctx: Ctx): Promise<void> {
  const { feature, role } = job;
  const { repo, main } = ctx;
  const branch = `${a.name}/${feature.id}`;
  const git = new Clone(
    join(ctx.work, a.name),
    async () => parseCredentials(await a.call("git_credentials", { repo, scope: "write" })),
    { name: a.name, email: `${a.name}@agents.mycelium.invalid` },
  );
  const files = dirFiles(git.dir);
  let fixed = role !== "breaker";
  const myComments = new Set<number>();
  const answered = new Set<number>();

  const commit = async (message: string) => {
    await git.ok(["add", "-A"]);
    await git.ok(["commit", "-q", "-m", `${message}\n\nAgent: ${a.name}`]);
    return git.head();
  };
  const push = async (force: boolean) => {
    const args = [
      "push",
      "-q",
      ...(force ? ["--force"] : []),
      "origin",
      `HEAD:refs/heads/${branch}`,
    ];
    await git.netOk(args);
  };
  const comment = async (number: number, body: string) => {
    const c = await a.json<{ id: number }>("comment_pull", { repo, number, body });
    myComments.add(c.id);
  };

  // 1. Look around and get git access.
  const info = await a.json<{ branches: unknown[] }>("get_repo", { repo });
  a.say(`read ${bold(repo)}: ${info.branches.length} branch(es), default ${main}`);
  await a.pace();
  await git.clone();
  const base = await git.head();
  a.say(`got write credentials and cloned ${repo} at ${short(base)}`);
  await a.pace();

  // 2. Make the change on a branch, test it locally.
  await git.ok(["checkout", "-q", "-b", branch]);
  if (role === "breaker") feature.buggy!(files);
  else feature.apply(files);
  a.say(`wrote "${feature.title}" on ${branch} (${await git.shortstat()})`);
  await a.pace();
  // The breaker runs only the test it wrote, and so misses what it broke.
  const local = await bunTest(git.dir, role === "breaker" ? [feature.test] : []);
  if (!local.ok) throw new Error(`local tests failed: ${local.failures.join("; ")}`);
  a.say(
    `ran bun test${role === "breaker" ? ` ${feature.test}` : ""} locally: ${local.pass} pass, ${local.fail} fail`,
  );
  await a.pace(0.5);
  const sha = await commit(feature.title);
  await push(true);
  let expectedHead = sha;
  a.say(`committed ${short(sha)} and pushed ${branch}`);
  await a.pace();

  // 3. Open the pull request and say something about it.
  const pull = await a.json<{ number: number; url: string }>("open_pull", {
    repo,
    title: feature.title,
    head: branch,
    base: main,
    body: `${feature.body}\n\nAgent: ${a.name}`,
  });
  a.stats.pr = pull.number;
  ctx.board.open(feature.id, pull.number);
  a.say(`opened ${bold(`PR #${pull.number}`)} "${feature.title}"  ${dim(pull.url)}`);
  await a.pace(0.5);
  await comment(pull.number, feature.note);
  a.say(`commented on #${pull.number}`);
  await a.pace();

  // 4. Review someone else's pull request.
  if (job.review) {
    const target = await ctx.board.wait(job.review.id, 120_000);
    if (target) {
      const other = await a.json<
        PullView & { diff: { files?: { path: string; additions: number; deletions: number }[] } }
      >("get_pull", { repo, number: target, patch: true });
      const touched = (other.diff.files ?? [])
        .map((f) => `\`${f.path}\` (+${f.additions}/−${f.deletions})`)
        .join(", ");
      await comment(
        target,
        `Review from ${a.name}: read ${touched || "the diff"}. ${job.review.review}`,
      );
      a.say(`reviewed ${bold(`PR #${target}`)} by ${other.author} and left a comment`);
      await a.pace();
    }
  }

  // 5. Rebase: re-apply the change on the newest main (the deterministic stand-in for resolving).
  const rebase = async (why: string) => {
    await git.netOk(["fetch", "-q", "origin", main]);
    const onto = await git.head(`origin/${main}`);
    a.say(`${why}: rebasing onto ${main} (${short(onto)}) by re-applying the change`);
    await git.ok(["checkout", "-q", "-B", branch, `origin/${main}`]);
    feature.apply(files);
    fixed = true;
    const t = await bunTest(git.dir);
    if (!t.ok) throw new Error(`tests fail after the rebase: ${t.failures.join("; ")}`);
    const sha = await commit(`${feature.title}\n\nRe-applied on ${main} at ${short(onto)}.`);
    await push(true);
    expectedHead = sha;
    a.stats.rebases++;
    a.say(`resolved, ran bun test (${t.pass} pass), force-pushed ${short(sha)}`);
    await a.pace();
  };

  // 6. Wait for the required check, fix what fails, merge.
  let waitingSince: number | null = Date.now();
  let missingSince: number | null = null;
  let lastStatus = "";
  let reruns = 0;
  let mergeAttempts = 0;
  while (Date.now() < ctx.deadline) {
    const pr = await a.json<PullView>("get_pull", { repo, number: pull.number });
    if (pr.state === "merged") break;
    if (pr.state === "closed") throw new Error(`PR #${pull.number} was closed`);

    // Answer reviews from other agents (once each).
    for (const c of pr.comments) {
      if (myComments.has(c.id) || answered.has(c.id) || c.authorKind !== "agent") continue;
      answered.add(c.id);
      await comment(
        pull.number,
        `Thanks @${c.author}, good points; keeping this PR focused and noting the rest for a follow-up.`,
      );
      a.say(`answered ${c.author}'s review on #${pull.number}`);
    }

    if (pr.diff.mergeable === false) {
      const conflicts = pr.diff.conflicts?.join(", ") || "the base";
      a.say(`PR #${pull.number} no longer merges cleanly (conflict in ${conflicts})`);
      await rebase("conflict");
      lastStatus = "";
      waitingSince ??= Date.now();
      continue;
    }

    // Until the instance has seen the latest push, its checks describe an older commit.
    if (pr.requiredChecks && pr.requiredChecks.sha !== expectedHead) {
      await sleep(2000);
      continue;
    }
    const check = pr.requiredChecks?.required.find((c) => c.workflow === WORKFLOW);
    const status = check?.status ?? (pr.requiredChecks?.satisfied ? "success" : "missing");
    if (status !== lastStatus) {
      if (status === "pending")
        a.say(`check ${WORKFLOW} is running on ${short(expectedHead)} (run #${check?.runNumber})`);
      lastStatus = status;
    }

    if (status === "missing") {
      // No run for the head yet: push events may be slow or off. After a while, start one.
      missingSince ??= Date.now();
      if (Date.now() - missingSince > 45_000) {
        const run = await a.json<{ number: number }>("run_workflow", {
          repo,
          workflow: WORKFLOW,
          ref: branch,
        });
        a.say(`no ${WORKFLOW} run for the head yet: started run #${run.number} by hand`);
        missingSince = null;
      }
    } else missingSince = null;

    if (status === "failure" && check?.runNumber) {
      if (waitingSince) a.stats.checkWaitMs += Date.now() - waitingSince;
      waitingSince = null;
      const run = await a.json<RunView>("get_run", {
        repo,
        number: check.runNumber,
        log_chars: 6000,
      });
      const step = run.steps.find((s) => s.status === "failure") ?? run.steps.at(-1);
      const counts = testCounts(step?.log ?? "");
      a.say(
        `${bold(`check ${WORKFLOW} failed`)} (run #${run.number}, step "${step?.name}": ${counts.fail} failing)`,
      );
      for (const f of counts.failures.slice(0, 3)) a.say(`  read the log: (fail) ${f}`);
      await a.pace();
      if (!fixed && feature.fix) {
        feature.fix(files);
        const t = await bunTest(git.dir);
        if (!t.ok) throw new Error(`the fix doesn't pass: ${t.failures.join("; ")}`);
        a.say(`fixed it and ran the whole suite this time: ${t.pass} pass, ${t.fail} fail`);
        const sha = await commit(feature.fixMessage ?? `Fix ${feature.title}`);
        await push(false);
        expectedHead = sha;
        fixed = true;
        a.stats.ciFixes++;
        await comment(
          pull.number,
          `CI caught a regression I missed locally (${counts.failures[0] ?? "router tests"}). Fixed in ${short(sha)}.`,
        );
        a.say(`pushed the fix ${short(sha)} and explained it on #${pull.number}`);
        waitingSince = Date.now();
        lastStatus = "";
        await a.pace();
        continue;
      }
      if (reruns++ < 1) {
        const r = await a.json<{ number: number }>("run_workflow", {
          repo,
          workflow: WORKFLOW,
          ref: branch,
        });
        a.say(`doesn't look like mine: re-running (run #${r.number})`);
        waitingSince = Date.now();
        continue;
      }
      throw new Error(`check ${WORKFLOW} keeps failing: ${counts.failures.join("; ")}`);
    }

    if (status === "success" || pr.requiredChecks?.satisfied) {
      if (waitingSince) {
        a.stats.checkWaitMs += Date.now() - waitingSince;
        a.say(`check ${WORKFLOW} ${bold("passed")} on ${short(expectedHead)}`);
      }
      waitingSince = null;
      await a.pace(0.5);
      try {
        const merged = await a.json<{ mergeSha: string }>("merge_pull", {
          repo,
          number: pull.number,
          method: "squash",
          head_sha: expectedHead,
        });
        a.say(`${bold(`merged PR #${pull.number}`)} (squash) as ${short(merged.mergeSha)}`);
        break;
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        const msg = error.text.split("\n")[0]!;
        if (/conflict/i.test(error.text)) {
          const files = /Conflicting files: (.+)/.exec(error.text)?.[1] ?? "";
          a.say(`merge refused: ${bold("conflict")} ${files}`);
          await rebase("someone merged first");
          lastStatus = "";
          waitingSince = Date.now();
        } else if (/Required checks|head moved/i.test(error.text)) {
          a.say(`merge refused: ${msg}`);
          waitingSince = Date.now();
        } else {
          if (++mergeAttempts > 5) throw error;
          a.stats.mergeRetries++;
          a.say(`merge failed (${msg}); retrying`);
          await sleep(2000 + Math.random() * 3000);
        }
        continue;
      }
    }
    await sleep(3000);
  }
  if (Date.now() >= ctx.deadline) throw new Error("timed out");
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) =>
      r
        .map((c, i) => c.padEnd(widths[i]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

function summary(stats: Stats[], startedAt: number): string {
  const rows = [
    [
      "agent",
      "feature",
      "role",
      "PR",
      "result",
      "time",
      "check wait",
      "CI fixes",
      "rebases",
      "merge retries",
      "tool calls",
    ],
    ...stats.map((s) => [
      s.agent,
      s.feature,
      s.role,
      s.pr ? `#${s.pr}` : "-",
      s.result,
      secs((s.endedAt ?? Date.now()) - s.startedAt),
      secs(s.checkWaitMs),
      String(s.ciFixes),
      String(s.rebases),
      String(s.mergeRetries),
      String(s.toolCalls),
    ]),
  ];
  const merged = stats.filter((s) => s.result === "merged").length;
  const failed = stats.filter((s) => s.result === "failed");
  return [
    table(rows),
    "",
    `${merged}/${stats.length} pull requests merged in ${secs(Date.now() - startedAt)}` +
      (failed.length ? `; failed: ${failed.map((s) => `${s.agent} (${s.error})`).join("; ")}` : ""),
  ].join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      tokens: { type: "string", default: "fleet.tokens.json" },
      repo: { type: "string", default: "tinyroute" },
      pace: { type: "string", default: "1500" },
      agents: { type: "string" },
      scenario: { type: "string", default: "realistic" },
      setup: { type: "boolean", default: false },
      reset: { type: "boolean", default: false },
      plan: { type: "boolean", default: false },
      "owner-token": { type: "string" },
      timeout: { type: "string", default: "900" },
      "no-color": { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
    },
  });
  if (!values.url) throw new Error("--url <instance> is required");
  const url = values.url.replace(/\/$/, "");
  const scenario = SCENARIOS[values.scenario!];
  if (!scenario)
    throw new Error(
      `No scenario ${values.scenario}; there are ${Object.keys(SCENARIOS).join(", ")}`,
    );
  const tokens = Object.entries(
    JSON.parse(readFileSync(values.tokens!, "utf8")) as Record<string, string>,
  );
  const n = Math.min(Number(values.agents ?? tokens.length), tokens.length);
  if (n < 1) throw new Error(`No agent tokens in ${values.tokens}`);
  const pace = Number(values.pace);
  const repo = values.repo!;
  timelineOptions({
    color: values["no-color"] ? false : undefined,
    nameWidth: Math.max(8, ...tokens.slice(0, n).map(([k]) => k.length)),
  });
  const ownerToken = values["owner-token"] ?? tokens[0]![1];
  const work = mkdtempSync(join(tmpdir(), "mycelium-fleet-"));
  const startedAt = Date.now();

  // The fleet's own voice (setup, plan) uses the first token.
  const fleet = new FleetAgent("fleet", tokens[0]![1], url, 9, 0);
  await fleet.connect();
  try {
    if (values.setup) await setup(fleet, url, repo, ownerToken, work);
    const ready = await preflight(fleet, url, repo, ownerToken);
    for (const note of ready.notes) fleet.say(dim(note));
    if (ready.problems.length) {
      for (const p of ready.problems) fleet.say(`not ready: ${p}`);
      if (!values.setup) fleet.say("Run again with --setup to fix these (it changes the repo).");
      process.exitCode = 1;
      return;
    }
    if (values.reset) await reset(fleet, url, repo, ownerToken, work);

    const slots = scenario.slots(n);
    const assignments = await plan(fleet, repo, slots, work);
    const agents = tokens
      .slice(0, n)
      .map(([name, token], i) => new FleetAgent(name, token, url, i, pace));
    const jobs: Job[] = assignments.map((x) => ({ ...x }));
    // The first clean agent reviews the first of the pair (or the breaker).
    const reviewer = jobs.findIndex((j) => j.role === "clean");
    const target = jobs.find((j) => j.role === "pair") ?? jobs.find((j) => j.role === "breaker");
    if (reviewer >= 0 && target) jobs[reviewer]!.review = target.feature;

    console.log(
      `\n${bold("Mycelium agent fleet")}: ${n} agents on ${bold(repo)} at ${url} (${values.scenario}: ${scenario.description})`,
    );
    console.log(`Watch: ${url}/activity   ${url}/${repo}/pulls   ${url}/${repo}/actions\n`);
    for (const [i, a] of agents.entries()) {
      const j = jobs[i]!;
      const extra =
        j.role === "breaker"
          ? " (will break a test)"
          : j.role === "pair"
            ? " (shares lines with another)"
            : "";
      line(
        a.name,
        a.color,
        `${dim("plan:")} ${j.feature.title}${dim(extra)}${j.review ? dim(` + reviews "${j.review.title}"`) : ""}`,
      );
    }
    if (values.plan) return;
    console.log("");

    await Promise.all(agents.map((a) => a.connect()));
    const ctx: Ctx = {
      url,
      repo,
      main: ready.defaultBranch,
      work,
      board: new Board(),
      deadline: Date.now() + Number(values.timeout) * 1000,
    };
    await Promise.all(
      agents.map(async (a, i) => {
        const job = jobs[i]!;
        a.stats.feature = job.feature.id;
        a.stats.role = job.role;
        a.stats.startedAt = Date.now();
        // Staggered starts read better than a wall of identical first lines.
        await sleep(i * Math.max(400, pace / 2));
        a.say(`connected to ${url}/mcp`);
        try {
          await runAgent(a, job, ctx);
          a.stats.result = "merged";
        } catch (error) {
          a.stats.result = "failed";
          a.stats.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
          a.say(`gave up: ${a.stats.error}`);
        } finally {
          a.stats.endedAt = Date.now();
        }
      }),
    );
    await Promise.all(agents.map((a) => a.close()));
    console.log(
      `\n${summary(
        agents.map((a) => a.stats),
        startedAt,
      )}`,
    );
    if (agents.some((a) => a.stats.result !== "merged")) process.exitCode = 1;
  } finally {
    await fleet.close();
    if (!values.keep) rmSync(work, { recursive: true, force: true });
    else console.log(dim(`clones kept in ${work}`));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
