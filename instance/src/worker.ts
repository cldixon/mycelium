import { Container } from "@cloudflare/containers";
import { app } from "./api/app.js";
import { handleQueue } from "./queue.js";
import type { Bindings } from "./api/bindings.js";

export { LiveHub } from "./live/hub.js";

/**
 * The runner container's Durable Object. One instance per key (the repo
 * name), so one repo's jobs share a warm container and its cached clone.
 * See src/runner.ts for the typed client.
 */
export class RunnerContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
}

export default {
  fetch: app.fetch,
  queue: (batch, env) => handleQueue(batch, env),
} satisfies ExportedHandler<Bindings>;
