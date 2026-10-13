import type {
  ApiTokenInfo,
  CreateApiTokenInput,
  CreatedApiToken,
  InstanceSettings,
} from "$shared/types";
import { get, request, seg } from "$lib/api";

/** Instance settings and API tokens (owner only). */
export const settings = {
  get: (fetcher?: typeof fetch) => get<InstanceSettings>("/api/settings", fetcher),
  tokens: (fetcher?: typeof fetch) =>
    get<{ tokens: ApiTokenInfo[] }>("/api/tokens", fetcher).then((r) => r.tokens),
  createToken: (input: CreateApiTokenInput) =>
    request<CreatedApiToken>("POST", "/api/tokens", input),
  revokeToken: (id: string) => request<{ ok: true }>("DELETE", `/api/tokens/${seg(id)}`),
};

/** Lifetimes offered when creating a token (the API accepts 1–365 days). */
export const TOKEN_LIFETIMES = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [365, "1 year"],
] as const;

/**
 * How an MCP client connects to this instance with a token (#17): the
 * server's URL, a JSON config for clients that take one, and the Claude Code
 * command.
 */
export function mcpSetup(origin: string, token: string, name = "mycelium") {
  const url = `${origin}/mcp`;
  const header = `Authorization: Bearer ${token}`;
  return {
    url,
    header,
    json: JSON.stringify(
      {
        mcpServers: {
          [name]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
        },
      },
      null,
      2,
    ),
    claudeCode: `claude mcp add --transport http ${name} ${url} --header "${header}"`,
  };
}
