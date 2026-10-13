import type { Context, Hono } from "hono";
import { bearerToken } from "../auth/tokens.js";
import { getDb } from "../db/migrations.js";
import { actorOf, originOf, viewer, type AppEnv } from "../api/session.js";
import { ApiError, handleMcp, type ApiCall } from "./server.js";

/**
 * /mcp: authenticate the bearer API token, then serve the request with tools
 * that call `app` (the instance's REST API) as the same token. Mounted from
 * app.ts, which passes itself in (no import cycle).
 */
export function mcpEndpoint(app: Hono<AppEnv>) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const origin = originOf(c);
    const authorization = c.req.header("authorization");
    const unauthorized = (why: string) =>
      c.json({ error: why }, 401, {
        "WWW-Authenticate": `Bearer realm="mycelium", error="invalid_token", error_description="${why}"`,
      });
    if (!bearerToken(authorization)) {
      return unauthorized("Send an API token: Authorization: Bearer myc_...");
    }
    const db = await getDb(c.env.DB);
    const who = await viewer(c, db);
    if (!who.isOwner || !who.token) return unauthorized("Invalid or expired API token");
    const actor = await actorOf(db, who.owner!, who.token);

    let executionCtx: Context["executionCtx"] | undefined;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = undefined; // tests: no execution context
    }
    const api: ApiCall = async <T>(method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { authorization: authorization! };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await app.fetch(
        new Request(`${origin}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        c.env,
        executionCtx,
      );
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        throw new ApiError(res.status, data?.error ?? `${method} ${path} failed`, data);
      }
      return data as T;
    };
    return handleMcp(c.req.raw, { actor, api, origin });
  };
}
