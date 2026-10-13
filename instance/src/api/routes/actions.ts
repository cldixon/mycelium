import { Hono, type Context } from "hono";
import { createRuns, loadWorkflows, resolveRef, workflowsFor } from "../../actions/index.js";
import { getDb } from "../../db/migrations.js";
import { getRepoRow } from "../../git/artifacts.js";
import { expireStaleRuns } from "../../jobs/workflow.js";
import {
  toRun,
  toRunStep,
  type RepoRow,
  type RunDetail,
  type RunEvent,
  type RunRow,
  type RunStepRow,
  type WorkflowList,
} from "../../shared/types.js";
import { canRead, requireOwner, type AppEnv, type OwnerEnv } from "../session.js";

/**
 * Actions: runs, run detail, workflows, manual runs.
 * Mounted at /api/repos/:repo. Owned by the Actions feature.
 *
 *   GET  /workflows?ref=                   workflow files at ref (default branch), with parse errors
 *   GET  /runs?sha=&workflow=&event=&limit= runs, newest first
 *   POST /runs {workflow, ref?}            run a workflow by hand (owner)
 *   GET  /runs/:n                          one run with its steps and logs
 *   POST /runs/:n/rerun                    run the same workflow at the same sha again (owner)
 */
export const actionsRoute = new Hono<AppEnv>();

const EVENTS: RunEvent[] = ["push", "pull_request", "manual"];

/** The repo row when the viewer may read it, else null (answer 404). */
async function readable(c: Context<any>): Promise<RepoRow | null> {
  const row = await getRepoRow(c.env, c.req.param("repo")!);
  return (await canRead(c, row)) ? row : null;
}

const notFound = (c: Context<any>, what = "Not found") => c.json({ error: what }, 404);

actionsRoute.get("/workflows", async (c) => {
  const row = await readable(c);
  if (!row) return notFound(c);
  const ref = c.req.query("ref");
  let resolved: { ref: string; sha: string } | null;
  try {
    resolved = await resolveRef(c.env, row.name, ref);
  } catch (error) {
    console.error("mycelium: resolving ref failed", error);
    return c.json({ error: "Couldn't read the repository's refs" }, 502);
  }
  if (!resolved) {
    if (!ref) {
      // An empty repository: no branches yet.
      return c.json({
        ref: row.default_branch,
        sha: "",
        workflows: [],
        errors: [],
      } satisfies WorkflowList);
    }
    return notFound(c, `No branch, tag or commit "${ref}"`);
  }
  const { workflows, errors } = await loadWorkflows(c.env, row.name, resolved.sha);
  return c.json({ ...resolved, workflows, errors } satisfies WorkflowList);
});

actionsRoute.get("/runs", async (c) => {
  const row = await readable(c);
  if (!row) return notFound(c);
  const db = await getDb(c.env.DB);
  await expireStaleRuns(db, row.name);
  const where = ["repo = ?"];
  const args: (string | number)[] = [row.name];
  const sha = c.req.query("sha");
  if (sha) {
    where.push("sha = ?");
    args.push(sha);
  }
  const workflow = c.req.query("workflow");
  if (workflow) {
    where.push("workflow = ?");
    args.push(workflow);
  }
  const event = c.req.query("event");
  if (event && EVENTS.includes(event as RunEvent)) {
    where.push("event = ?");
    args.push(event);
  }
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const { results } = await db
    .prepare(`SELECT * FROM runs WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT ?`)
    .bind(...args, limit)
    .all<RunRow>();
  return c.json({ runs: results.map(toRun) });
});

actionsRoute.post("/runs", requireOwner, async (c: Context<OwnerEnv>) => {
  const row = await getRepoRow(c.env, c.req.param("repo")!);
  if (!row) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as {
    workflow?: unknown;
    ref?: unknown;
  } | null;
  if (!body || typeof body.workflow !== "string" || !body.workflow) {
    return c.json({ error: "workflow is required" }, 400);
  }
  if (body.ref !== undefined && typeof body.ref !== "string") {
    return c.json({ error: "ref must be a string" }, 400);
  }
  const resolved = await resolveRef(c.env, row.name, body.ref);
  if (!resolved) return c.json({ error: `No branch, tag or commit "${body.ref ?? ""}"` }, 400);
  const { workflows, errors } = await loadWorkflows(c.env, row.name, resolved.sha);
  const name = body.workflow;
  const wf = workflows.find((w) => w.name === name || w.path.endsWith(`/${name}`));
  if (!wf) {
    const broken = errors.find((e) => e.path.endsWith(`/${name}`));
    return c.json(
      {
        error: broken
          ? `${broken.path}: ${broken.error}`
          : `No workflow "${name}" at ${resolved.ref}`,
      },
      400,
    );
  }
  const { kind, name: actor } = c.var.actor;
  const [run] = await createRuns(c.env, row.name, workflowsFor([wf], "manual"), {
    event: "manual",
    ...resolved,
    actor: { kind, name: actor },
  });
  return c.json(await runDetail(c.var.db, run!.id), 201);
});

actionsRoute.get("/runs/:number", async (c) => {
  const row = await readable(c);
  if (!row) return notFound(c);
  const db = await getDb(c.env.DB);
  await expireStaleRuns(db, row.name);
  const run = await db
    .prepare("SELECT id FROM runs WHERE repo = ? AND number = ?")
    .bind(row.name, Number(c.req.param("number")))
    .first<{ id: number }>();
  if (!run) return notFound(c, "No such run");
  return c.json(await runDetail(db, run.id));
});

actionsRoute.post("/runs/:number/rerun", requireOwner, async (c: Context<OwnerEnv>) => {
  const name = c.req.param("repo")!;
  const old = await c.var.db
    .prepare("SELECT * FROM runs WHERE repo = ? AND number = ?")
    .bind(name, Number(c.req.param("number")))
    .first<RunRow>();
  if (!old) return notFound(c, "No such run");
  const { workflows } = await loadWorkflows(c.env, name, old.sha);
  const wf = workflows.find((w) => w.name === old.workflow);
  if (!wf)
    return c.json({ error: `Workflow "${old.workflow}" no longer parses at this commit` }, 400);
  const [run] = await createRuns(c.env, name, [wf], {
    event: old.event,
    ref: old.ref,
    sha: old.sha,
    pullNumber: old.pull_number,
    actor: { kind: c.var.actor.kind, name: c.var.actor.name },
  });
  return c.json(await runDetail(c.var.db, run!.id), 201);
});

async function runDetail(db: D1Database, id: number): Promise<RunDetail> {
  const [run, steps] = await db.batch([
    db.prepare("SELECT * FROM runs WHERE id = ?").bind(id),
    db.prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx").bind(id),
  ]);
  return {
    ...toRun(run!.results[0] as RunRow),
    steps: (steps!.results as RunStepRow[]).map(toRunStep),
  };
}
