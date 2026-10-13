import { nextNumber } from "../db/migrations.js";
import type { PullComment, PullRow, PullState } from "../shared/types.js";

/** D1 access for pull requests and their comments. `db` is already migrated. */

export async function getPullRow(
  db: D1Database,
  repo: string,
  number: number,
): Promise<PullRow | null> {
  return db
    .prepare("SELECT * FROM pulls WHERE repo = ? AND number = ?")
    .bind(repo, number)
    .first<PullRow>();
}

export async function listPullRows(
  db: D1Database,
  repo: string,
  states: PullState[],
): Promise<PullRow[]> {
  const marks = states.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM pulls WHERE repo = ? AND state IN (${marks}) ORDER BY number DESC`)
    .bind(repo, ...states)
    .all<PullRow>();
  return results;
}

export async function countPulls(
  db: D1Database,
  repo: string,
): Promise<{ open: number; closed: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(state = 'open'), 0) AS open, COALESCE(SUM(state != 'open'), 0) AS closed
       FROM pulls WHERE repo = ?`,
    )
    .bind(repo)
    .first<{ open: number; closed: number }>();
  return { open: row?.open ?? 0, closed: row?.closed ?? 0 };
}

export async function insertPull(
  db: D1Database,
  p: {
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    author: string;
    headSha: string;
    baseSha: string;
  },
): Promise<PullRow> {
  const number = await nextNumber(db, p.repo, "pull");
  const now = new Date().toISOString();
  return (await db
    .prepare(
      `INSERT INTO pulls (repo, number, title, body, head, base, state, author, head_sha, base_sha,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(p.repo, number, p.title, p.body, p.head, p.base, p.author, p.headSha, p.baseSha, now, now)
    .first<PullRow>())!;
}

/** Apply column changes (snake_case keys) and bump updated_at. */
export async function updatePull(
  db: D1Database,
  id: number,
  changes: Partial<Omit<PullRow, "id" | "repo" | "number" | "created_at">>,
): Promise<PullRow> {
  const entries = Object.entries({ ...changes, updated_at: new Date().toISOString() });
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  return (await db
    .prepare(`UPDATE pulls SET ${sets} WHERE id = ? RETURNING *`)
    .bind(...entries.map(([, v]) => v ?? null), id)
    .first<PullRow>())!;
}

type CommentRow = { id: number; pull_id: number; author: string; body: string; created_at: string };

const toComment = (r: CommentRow): PullComment => ({
  id: r.id,
  author: r.author,
  body: r.body,
  createdAt: r.created_at,
});

export async function listComments(db: D1Database, pullId: number): Promise<PullComment[]> {
  const { results } = await db
    .prepare("SELECT * FROM pull_comments WHERE pull_id = ? ORDER BY id")
    .bind(pullId)
    .all<CommentRow>();
  return results.map(toComment);
}

export async function addComment(
  db: D1Database,
  pullId: number,
  author: string,
  body: string,
): Promise<PullComment> {
  const row = await db
    .prepare(
      "INSERT INTO pull_comments (pull_id, author, body, created_at) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .bind(pullId, author, body, new Date().toISOString())
    .first<CommentRow>();
  return toComment(row!);
}
