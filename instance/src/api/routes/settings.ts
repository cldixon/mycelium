import { Hono, type Context } from "hono";
import { getOwnerHandle } from "../../auth/owner.js";
import { TokenError, createApiToken, listApiTokens, revokeApiToken } from "../../auth/tokens.js";
import type { InstanceSettings } from "../../shared/types.js";
import { requireOwner, type OwnerEnv } from "../session.js";
import pkg from "../../../package.json";

/**
 * Instance settings: owner and instance facts, and API tokens.
 * Mounted at /api. Owned by the Settings feature.
 */
export const settingsRoute = new Hono<OwnerEnv>();

settingsRoute.use("/settings", requireOwner);
settingsRoute.use("/tokens", requireOwner);
settingsRoute.use("/tokens/*", requireOwner);

/** The instance's code version: the @mycelium/instance package version it was built from. */
export const VERSION: string = pkg.version;

settingsRoute.get("/settings", async (c) => {
  const settings: InstanceSettings = {
    title: c.env.INSTANCE_TITLE || "mycelium",
    version: VERSION,
    owner: { did: c.var.ownerDid, handle: await getOwnerHandle(c.var.db) },
    // Only whether it is set: the token itself never leaves the Worker.
    pushEvents: Boolean(c.env.CF_API_TOKEN),
  };
  return c.json(settings);
});

// Tokens manage tokens only from a browser session: a leaked token can't mint
// itself a longer-lived successor or revoke the owner's other tokens.
const browserOnly = (c: Context<OwnerEnv>) =>
  c.var.viaToken ? c.json({ error: "Manage API tokens from the settings page" }, 403) : null;

settingsRoute.get("/tokens", async (c) => {
  return c.json({ tokens: await listApiTokens(c.var.db) });
});

/** Create a token. The secret is in this response only. */
settingsRoute.post("/tokens", async (c) => {
  const refused = browserOnly(c);
  if (refused) return refused;
  const body = await c.req
    .json<{ name?: string; days?: number }>()
    .catch(() => ({}) as { name?: string; days?: number });
  try {
    return c.json(await createApiToken(c.var.db, body.name ?? "", Number(body.days ?? 90)), 201);
  } catch (error) {
    if (error instanceof TokenError) return c.json({ error: error.message }, 400);
    throw error;
  }
});

settingsRoute.delete("/tokens/:id", async (c) => {
  const refused = browserOnly(c);
  if (refused) return refused;
  const removed = await revokeApiToken(c.var.db, c.req.param("id"));
  return removed ? c.json({ ok: true }) : c.json({ error: "No such token" }, 404);
});
