import type { AuthStatus, Repo } from "$shared/types";

/**
 * Client for the instance API (/api). Every feature adds its calls in its
 * own module under $lib (e.g. $lib/pulls.ts) using `request`, so this file
 * stays small.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON request with the session cookie. Throws ApiError on a non-2xx answer. */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetcher(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const get = <T>(path: string, fetcher?: typeof fetch) =>
  request<T>("GET", path, undefined, fetcher);

/** A path segment, encoded. */
export const seg = (s: string) => encodeURIComponent(s);

export const auth = {
  status: (fetcher?: typeof fetch) => get<AuthStatus>("/api/auth/status", fetcher),
  login: (handle: string, setupCode?: string) =>
    request<{ url: string }>("POST", "/api/auth/login", { handle, setupCode }),
  logout: () => request("POST", "/api/auth/logout"),
};

export const repos = {
  list: (fetcher?: typeof fetch) =>
    get<{ repos: Repo[] }>("/api/repos", fetcher).then((r) => r.repos),
  get: (name: string, fetcher?: typeof fetch) => get<Repo>(`/api/repos/${seg(name)}`, fetcher),
};
