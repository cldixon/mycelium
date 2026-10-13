import type { ActivityItem } from "$shared/live";
import { get } from "$lib/api";

/** Client for the instance's activity (GET /api/activity). */
export const activity = {
  list: (limit = 50, fetcher?: typeof fetch) =>
    get<{ items: ActivityItem[] }>(`/api/activity?limit=${limit}`, fetcher).then((r) => r.items),
};

/** "refs/heads/main" → "main", "refs/tags/v1" → "v1". */
export const shortRef = (ref: string) => ref.replace(/^refs\/(heads|tags)\//, "");
