import { Hono, type Context } from "hono";
import { createRuns, loadWorkflows } from "../../actions/index.js";
import { evaluate, getRequired, setRequired } from "../../checks/index.js";
import { getDb } from "../../db/migrations.js";
import { getRepoRow } from "../../git/artifacts.js";
import { expireStaleRuns } from "../../jobs/workflow.js";
import { isBranchName } from "../../pulls/logic.js";
import { getPullRow } from "../../pulls/store.js";
import type { PullRow, RepoRow, RequiredChecks } from "../../shared/types.js";
import { canRead, requireOwner, type AppEnv, type OwnerEnv } from "../session.js";

/**
 * Required checks before merge. Mounted at /api/repos/:repo. The merge gate
 * itself is in routes/pulls.ts (one call to `evaluate`).
 *
 *   GET  /checks/required?branch=           required workflows for a base branch (default branch)
 *   PUT  /checks/required {branch, workflows} replace them (owner)
 *   GET  /pulls/:n/checks                   the PR's required checks at its head sha
 *   POST /pulls/:n/checks/run               start the required workflows that haven't run (owner)
 */
export const checksRoute = new Hono<AppEnv>();

const MAX_WORKFLOWS = 50;

async function readable(c: Context<any>): Promise<RepoRow | null> {
  const row = await getRepoRow(c.env, c.req.param("repo")!);
  return (await canRead(c, row)) ? row : null;
}

async function readablePull(c: Context<any>): Promise<{ row: RepoRow; pull: PullRow } | null> {
  const row = await readable(c);
  const n = Number(c.req.param("n"));
  if (!row || !Number.isInteger(n) || n < 1) return null;
  const db = await getDb(c.env.DB);
  const pull = await getPullRow(db, row.name, n);
  if (!pull) return null;
  await expireStaleRuns(db, row.name);
  return { row, pull };
}

const notFound = (c: Context<any>) => c.json({ error: "Not found" }, 404);

checksRoute.get("/checks/required", async (c) => {
  const row = await readable(c);
  if (!row) return notFound(c);
  const branch = c.req.query("branch") || row.default_branch;
  if (!isBranchName(branch)) return c.json({ error: "branch must be a branch name" }, 400);
  return c.json({
    branch,
    workflows: await getRequired(c.env, row.name, branch),
  } satisfies RequiredChecks);
});

checksRoute.put("/checks/required", requireOwner, async (c: Context<OwnerEnv>) => {
  const row = await getRepoRow(c.env, c.req.param("repo")!);
  if (!row) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as {
    branch?: unknown;
    workflows?: unknown;
  } | null;
  const branch = body?.branch ?? row.default_branch;
  if (!isBranchName(branch)) return c.json({ error: "branch must be a branch name" }, 400);
  const workflows = body?.workflows;
  if (
    !Array.isArray(workflows) ||
    workflows.length > MAX_WORKFLOWS ||
    !workflows.every((w) => typeof w === "string" && w.trim() && w.length <= 200)
  ) {
    return c.json(
      { error: `workflows must be a list of up to ${MAX_WORKFLOWS} workflow names` },
      400,
    );
  }
  const saved = await setRequired(
    c.env,
    row.name,
    branch,
    workflows.map((w: string) => w.trim()),
  );
  return c.json({ branch, workflows: saved } satisfies RequiredChecks);
});

checksRoute.get("/pulls/:n{[0-9]+}/checks", async (c) => {
  const found = await readablePull(c);
  if (!found) return notFound(c);
  return c.json(await evaluate(c.env, found.row.name, found.pull));
});

/**
 * Start the required workflows with no run on the PR's head, as
 * pull_request runs. Workflows not found at the head are listed as
 * `unavailable`.
 */
checksRoute.post("/pulls/:n{[0-9]+}/checks/run", requireOwner, async (c: Context<OwnerEnv>) => {
  const found = await readablePull(c);
  if (!found) return notFound(c);
  const { row, pull } = found;
  if (pull.state !== "open") return c.json({ error: `Pull request is ${pull.state}` }, 409);
  if (!pull.head_sha) return c.json({ error: "The pull request has no head commit yet" }, 409);
  const before = await evaluate(c.env, row.name, pull);
  const missing = before.required.filter((r) => r.status === "missing").map((r) => r.workflow);
  let started: { number: number; workflow: string }[] = [];
  let unavailable = missing;
  if (missing.length > 0) {
    const { workflows } = await loadWorkflows(c.env, row.name, pull.head_sha);
    const todo = workflows.filter((w) => missing.includes(w.name));
    unavailable = missing.filter((m) => !todo.some((w) => w.name === m));
    const created = await createRuns(c.env, row.name, todo, {
      event: "pull_request",
      ref: `pull/${pull.number}`,
      sha: pull.head_sha,
      pullNumber: pull.number,
    });
    started = created.map(({ number, workflow }) => ({ number, workflow }));
  }
  return c.json({ started, unavailable, checks: await evaluate(c.env, row.name, pull) });
});
