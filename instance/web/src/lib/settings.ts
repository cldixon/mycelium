import type { ApiTokenInfo, CreatedApiToken, InstanceSettings } from "$shared/types";
import { get, request, seg } from "$lib/api";

/** Instance settings and API tokens (owner only). */
export const settings = {
  get: (fetcher?: typeof fetch) => get<InstanceSettings>("/api/settings", fetcher),
  tokens: (fetcher?: typeof fetch) =>
    get<{ tokens: ApiTokenInfo[] }>("/api/tokens", fetcher).then((r) => r.tokens),
  createToken: (name: string, days: number) =>
    request<CreatedApiToken>("POST", "/api/tokens", { name, days }),
  revokeToken: (id: string) => request<{ ok: true }>("DELETE", `/api/tokens/${seg(id)}`),
};

/** Lifetimes offered when creating a token (the API accepts 1–365 days). */
export const TOKEN_LIFETIMES = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [365, "1 year"],
] as const;
