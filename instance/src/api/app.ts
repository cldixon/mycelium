import { Hono } from "hono";
import { authRoute, oauthRoute } from "./routes/auth.js";
import { reposRoute } from "./routes/repos.js";
import { codeRoute } from "./routes/code.js";
import { pullsRoute } from "./routes/pulls.js";
import { actionsRoute } from "./routes/actions.js";
import { settingsRoute } from "./routes/settings.js";
import { liveRoute } from "./routes/live.js";
import { checksRoute } from "./routes/checks.js";
import { mcpEndpoint } from "../mcp/route.js";
import type { AppEnv } from "./session.js";

/**
 * The Worker's HTTP app. Each feature owns one route file and adds its
 * endpoints there; this file only mounts them.
 */
const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/oauth", oauthRoute);
app.route("/api/auth", authRoute);
app.route("/api/repos", reposRoute); //            /api/repos, /api/repos/:repo, .../refs, .../git-credentials
app.route("/api/repos/:repo", codeRoute); //       .../tree, blob, commits, commit, contributors
app.route("/api/repos/:repo", pullsRoute); //      .../pulls/*
app.route("/api/repos/:repo", actionsRoute); //    .../runs/*, .../workflows
app.route("/api/repos/:repo", checksRoute); //     .../checks/required, .../pulls/:n/checks
app.route("/api", settingsRoute); //               /api/tokens/*
app.all("/mcp", mcpEndpoint(app)); //              MCP for agents (bearer API token)
app.route("/api", liveRoute); //                   /api/live, /api/repos/:repo/live, /api/activity

app.onError((error, c) => {
  console.error("mycelium: unhandled error", error);
  return c.json({ error: "Internal error" }, 500);
});

const API_PREFIXES = ["/api", "/health", "/oauth", "/mcp"];

// Requests reach the Worker either because runWorkerFirst claimed them or
// because they missed a static asset. Unmatched API paths are a real 404;
// anything else belongs to the SPA.
app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  if (API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export { app };
