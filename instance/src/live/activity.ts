import type { ActivityItem } from "../shared/live.js";

/**
 * The instance's recent activity (GET /api/activity): pushes, pull request
 * events and workflow runs across the repos the viewer can read, newest
 * first. Read from D1; the activity page refreshes it on live events.
 */

export const DEFAULT_ACTIVITY_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 200;

export function activityLimit(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(n, MAX_ACTIVITY_LIMIT);
}

/**
 * Up to `limit` items. `owner` sees every repo; anyone else only public ones.
 * `repo` narrows it to one repo (the caller checks it may be read).
 */
export async function recentActivity(
  db: D1Database,
  { owner, limit, repo }: { owner: boolean; limit: number; repo?: string },
): Promise<ActivityItem[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (!owner) where.push("r.visibility = 'public'");
  if (repo) {
    where.push("r.name = ?");
    args.push(repo);
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [pushes, pulls, runs] = await db.batch([
    db
      .prepare(
        `SELECT p.repo, p.at, p.ref, p.before, p.after, json_array_length(p.commits) AS count
         FROM pushes p JOIN repos r ON r.name = p.repo ${filter}
         ORDER BY p.at DESC LIMIT ?`,
      )
      .bind(...args, limit),
    db
      .prepare(
        `SELECT a.* FROM (
           SELECT repo, number, title, 'opened' AS action, created_at AS at FROM pulls
           UNION ALL
           SELECT repo, number, title, 'merged', merged_at FROM pulls WHERE merged_at IS NOT NULL
           UNION ALL
           SELECT repo, number, title, 'closed', closed_at FROM pulls
             WHERE closed_at IS NOT NULL AND merged_at IS NULL
           UNION ALL
           SELECT p.repo, p.number, p.title, 'commented', c.created_at
             FROM pull_comments c JOIN pulls p ON p.id = c.pull_id
         ) a JOIN repos r ON r.name = a.repo ${filter}
         ORDER BY a.at DESC LIMIT ?`,
      )
      .bind(...args, limit),
    db
      .prepare(
        `SELECT u.repo, u.number, u.workflow, u.status, u.event, u.ref,
                COALESCE(u.finished_at, u.started_at, u.created_at) AS at
         FROM runs u JOIN repos r ON r.name = u.repo ${filter}
         ORDER BY at DESC LIMIT ?`,
      )
      .bind(...args, limit),
  ]);
  const items: ActivityItem[] = [
    ...(pushes!.results as Omit<Extract<ActivityItem, { kind: "push" }>, "kind">[]).map(
      (p) => ({ kind: "push", ...p, count: Number(p.count) || 0 }) as ActivityItem,
    ),
    ...(pulls!.results as Omit<Extract<ActivityItem, { kind: "pull" }>, "kind">[]).map(
      (p) => ({ kind: "pull", ...p }) as ActivityItem,
    ),
    ...(runs!.results as Omit<Extract<ActivityItem, { kind: "run" }>, "kind">[]).map(
      (r) => ({ kind: "run", ...r }) as ActivityItem,
    ),
  ];
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
