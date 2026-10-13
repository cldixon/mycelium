import { Hono, type Context } from "hono";
import { getOwnerHandle } from "../../auth/owner.js";
import { evaluate, unsatisfiedReason } from "../../checks/index.js";
import { getDb } from "../../db/migrations.js";
import { getRepoRow } from "../../git/artifacts.js";
import { diffJob, mergeJob, repoRefs } from "../../pulls/git.js";
import { startPullRuns } from "../../pulls/push.js";
import {
  defaultMergeMessage,
  isBranchName,
  isMergeMethod,
  ownerIdentity,
  pullPatch,
  statesFor,
} from "../../pulls/logic.js";
import {
  addComment,
  countPulls,
  getPullRow,
  insertPull,
  listComments,
  listPullRows,
  updatePull,
} from "../../pulls/store.js";
import { toPull, type PullRow, type RepoRow } from "../../shared/types.js";
import { publish } from "../../live/publish.js";
import { canRead, requireOwner, type AppEnv, type OwnerEnv } from "../session.js";

/**
 * Pull requests: list, open, read, update, diff, merge, comments.
 * Mounted at /api/repos/:repo. Owned by the Pulls feature.
 *
 * A pull request merges a head branch into a base branch of the same repo.
 * Diffs and merges run in the runner container (see src/pulls/git.ts).
 */
export const pullsRoute = new Hono<OwnerEnv>();

type C = Context<OwnerEnv>;

/** The repo if the viewer may read it. */
async function readable(c: C): Promise<RepoRow | null> {
  const row = await getRepoRow(c.env, c.req.param("repo")!);
  // canRead takes any route's context; it reads only the env and headers.
  return (await canRead(c as unknown as Context<AppEnv>, row)) ? row : null;
}

/** The repo and pull request :n if the viewer may read them. */
async function readablePull(c: C): Promise<{ row: RepoRow; pull: PullRow } | null> {
  const row = await readable(c);
  const n = Number(c.req.param("n"));
  if (!row || !Number.isInteger(n) || n < 1) return null;
  const pull = await getPullRow(await getDb(c.env.DB), row.name, n);
  return pull ? { row, pull } : null;
}

const notFound = (c: C) => c.json({ error: "Not found" }, 404);

/** Runner and git failures, as a JSON answer. */
function failed(c: C, error: unknown) {
  // RunnerError (src/runner.ts), matched by name: runner.ts is only loaded lazily.
  if (error instanceof Error && error.name === "RunnerError") {
    return c.json({ error: error.message }, 502);
  }
  throw error;
}

async function readJson(c: C): Promise<Record<string, unknown> | null> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

/** Run `work` after the response (waitUntil), or just let it run where there is no context (tests). */
function background(c: C, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work;
  }
}

/** `on: pull_request` workflows for the PR's head (Actions feature; fails soft). */
const pullRuns = (c: C, repo: string, number: number, headSha: string) =>
  background(c, startPullRuns(c.env, repo, number, headSha));

/** Who the owner is in pull requests and comments: the handle, or the DID. */
async function ownerName(c: C): Promise<string> {
  return (await getOwnerHandle(c.get("db"))) ?? c.get("ownerDid");
}

/** Who is writing: an agent by its name, or the owner (#17). */
async function authorOf(c: C): Promise<{ name: string; kind: "owner" | "agent" }> {
  const actor = c.get("actor");
  return actor.kind === "agent" ? actor : { name: await ownerName(c), kind: "owner" };
}

/** Preview a pull request before opening it: ?base=&head= */
pullsRoute.get("/pulls/compare", async (c) => {
  const row = await readable(c);
  if (!row) return notFound(c);
  const base = c.req.query("base");
  const head = c.req.query("head");
  if (!isBranchName(base) || !isBranchName(head)) {
    return c.json({ error: "Pick a base and a head branch" }, 400);
  }
  try {
    return c.json(await diffJob(c.env, row, base, head));
  } catch (error) {
    return failed(c, error);
  }
});

pullsRoute.get("/pulls", async (c) => {
  const row = await readable(c);
  if (!row) return notFound(c);
  const states = statesFor(c.req.query("state"));
  if (!states) return c.json({ error: "state must be open, closed or all" }, 400);
  const db = await getDb(c.env.DB);
  const [rows, counts] = await Promise.all([
    listPullRows(db, row.name, states),
    countPulls(db, row.name),
  ]);
  return c.json({ pulls: rows.map(toPull), counts });
});

pullsRoute.post("/pulls", requireOwner, async (c) => {
  const row = await getRepoRow(c.env, c.req.param("repo")!);
  if (!row) return notFound(c);
  const body = await readJson(c);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const text = typeof body?.body === "string" ? body.body : "";
  const { head, base } = body ?? {};
  if (!title) return c.json({ error: "A pull request needs a title" }, 400);
  if (!isBranchName(head) || !isBranchName(base)) {
    return c.json({ error: "head and base must be branch names" }, 400);
  }
  if (head === base) return c.json({ error: "head and base must be different branches" }, 400);
  const refs = await repoRefs(c.env, row);
  const sha = (name: string) => refs.branches.find((b) => b.name === name)?.sha;
  const headSha = sha(head);
  const baseSha = sha(base);
  if (!headSha) return c.json({ error: `No branch ${head}` }, 400);
  if (!baseSha) return c.json({ error: `No branch ${base}` }, 400);
  const db = c.get("db");
  const existing = await db
    .prepare("SELECT number FROM pulls WHERE repo = ? AND head = ? AND base = ? AND state = 'open'")
    .bind(row.name, head, base)
    .first<{ number: number }>();
  if (existing) {
    return c.json(
      { error: `Pull request #${existing.number} already merges ${head} into ${base}` },
      409,
    );
  }
  const pull = await insertPull(db, {
    repo: row.name,
    title: title.slice(0, 256),
    body: text.slice(0, 65536),
    head,
    base,
    ...(await authorOf(c).then((a) => ({ author: a.name, authorKind: a.kind }))),
    headSha,
    baseSha,
  });
  pullRuns(c, row.name, pull.number, headSha);
  await publish(c.env, row.name, { type: "pull", number: pull.number, action: "opened" });
  return c.json(toPull(pull), 201);
});

pullsRoute.get("/pulls/:n{[0-9]+}", async (c) => {
  const found = await readablePull(c);
  return found ? c.json(toPull(found.pull)) : notFound(c);
});

pullsRoute.patch("/pulls/:n{[0-9]+}", requireOwner, async (c) => {
  const found = await readablePull(c);
  if (!found) return notFound(c);
  const { row, pull } = found;
  const changes = pullPatch(await readJson(c), pull);
  if ("error" in changes) return c.json({ error: changes.error }, 400);
  const update: Partial<PullRow> = {};
  if (changes.title !== undefined) update.title = changes.title;
  if (changes.body !== undefined) update.body = changes.body;
  if (changes.state && changes.state !== pull.state) {
    update.state = changes.state;
    if (changes.state === "closed") update.closed_at = new Date().toISOString();
    else {
      // Reopen: both branches must still exist, and no other open PR may cover them.
      const refs = await repoRefs(c.env, row);
      const sha = (name: string) => refs.branches.find((b) => b.name === name)?.sha;
      if (!sha(pull.head) || !sha(pull.base)) {
        return c.json({ error: `Can't reopen: ${pull.head} or ${pull.base} is gone` }, 409);
      }
      update.closed_at = null;
      update.head_sha = sha(pull.head)!;
      update.base_sha = sha(pull.base)!;
    }
  }
  if (Object.keys(update).length === 0) return c.json(toPull(pull));
  const updated = await updatePull(c.get("db"), pull.id, update);
  const action = update.state ? (update.state === "open" ? "reopened" : "closed") : "updated";
  await publish(c.env, row.name, { type: "pull", number: pull.number, action });
  if (update.state === "open" && updated.head_sha) {
    pullRuns(c, row.name, updated.number, updated.head_sha);
  }
  return c.json(toPull(updated));
});

/**
 * The pull request's diff, commits and mergeability. Open ones compare the
 * live branches (and refresh head_sha / base_sha); merged ones compare the
 * shas recorded at merge time.
 */
pullsRoute.get("/pulls/:n{[0-9]+}/diff", async (c) => {
  const found = await readablePull(c);
  if (!found) return notFound(c);
  const { row, pull } = found;
  const settled = pull.state !== "open";
  const base = settled && pull.base_sha ? pull.base_sha : pull.base;
  const head = settled && pull.head_sha ? pull.head_sha : pull.head;
  try {
    const diff = await diffJob(c.env, row, base, head);
    if (!settled && (diff.headSha !== pull.head_sha || diff.baseSha !== pull.base_sha)) {
      await updatePull(await getDb(c.env.DB), pull.id, {
        head_sha: diff.headSha,
        base_sha: diff.baseSha,
      });
      // Head moved without a push event (no subscription): catch up on PR runs.
      if (diff.headSha !== pull.head_sha) pullRuns(c, row.name, pull.number, diff.headSha);
    }
    return c.json(diff);
  } catch (error) {
    return failed(c, error);
  }
});

pullsRoute.post("/pulls/:n{[0-9]+}/merge", requireOwner, async (c) => {
  const found = await readablePull(c);
  if (!found) return notFound(c);
  const { row, pull } = found;
  if (pull.state !== "open") return c.json({ error: `Pull request is ${pull.state}` }, 409);
  const body = (await readJson(c)) ?? {};
  const method = body.method ?? "merge";
  if (!isMergeMethod(method))
    return c.json({ error: "method must be merge, squash or rebase" }, 400);
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : defaultMergeMessage(pull, method);
  let headSha = typeof body.headSha === "string" ? body.headSha : undefined;
  // Required checks (src/checks): every required workflow must have passed on the head.
  const checks = await evaluate(c.env, row.name, pull);
  if (!checks.satisfied) return c.json({ error: unsatisfiedReason(checks), checks }, 409);
  if (checks.required.length > 0) {
    if (headSha && headSha !== pull.head_sha) {
      return c.json({ error: "The head moved since the checks ran; reload", checks }, 409);
    }
    headSha = pull.head_sha ?? undefined; // merge only the commit the checks passed on
  }
  const author = ownerIdentity(
    await getOwnerHandle(c.get("db")),
    c.get("ownerDid"),
    new URL(c.req.url).hostname,
  );
  try {
    const result = await mergeJob(c.env, row, {
      base: pull.base,
      head: pull.head,
      method,
      message,
      author,
      headSha,
    });
    if (result.status === "conflict") {
      return c.json({ error: "Merge conflict: nothing was pushed", ...result }, 409);
    }
    const now = new Date().toISOString();
    const merged = await updatePull(c.get("db"), pull.id, {
      state: "merged",
      merge_sha: result.sha,
      merge_method: method,
      merged_at: now,
      closed_at: now,
      head_sha: result.headSha,
      base_sha: result.baseSha,
    });
    await publish(c.env, row.name, { type: "pull", number: pull.number, action: "merged" });
    return c.json(toPull(merged));
  } catch (error) {
    return failed(c, error);
  }
});

pullsRoute.get("/pulls/:n{[0-9]+}/comments", async (c) => {
  const found = await readablePull(c);
  if (!found) return notFound(c);
  return c.json({ comments: await listComments(await getDb(c.env.DB), found.pull.id) });
});

pullsRoute.post("/pulls/:n{[0-9]+}/comments", requireOwner, async (c) => {
  const found = await readablePull(c);
  if (!found) return notFound(c);
  const body = await readJson(c);
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text) return c.json({ error: "A comment needs a body" }, 400);
  const author = await authorOf(c);
  const comment = await addComment(
    c.get("db"),
    found.pull.id,
    author.name,
    text.slice(0, 65536),
    author.kind,
  );
  const { row, pull } = found;
  await publish(c.env, row.name, { type: "pull", number: pull.number, action: "commented" });
  return c.json(comment, 201);
});
