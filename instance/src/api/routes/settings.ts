import { Hono } from "hono";
import { listApiTokens } from "../../auth/tokens.js";
import { requireOwner, type OwnerEnv } from "../session.js";

/**
 * Instance settings: API tokens (and later: owner, about).
 * Mounted at /api. Owned by the Settings feature.
 */
export const settingsRoute = new Hono<OwnerEnv>();

settingsRoute.use("/tokens", requireOwner);
settingsRoute.use("/tokens/*", requireOwner);

settingsRoute.get("/tokens", async (c) => {
  return c.json({ tokens: await listApiTokens(c.get("db")) });
});
