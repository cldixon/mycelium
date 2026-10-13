import type { RunnerContainer } from "../worker.js";

/**
 * Bindings and vars declared in cloudflare.config.ts (the generated `Env`),
 * plus the optional secrets, which the config doesn't declare so that a
 * deploy without them works.
 */
export type Bindings = Omit<Env, "RUNNER"> & {
  /** The runner container's Durable Object namespace (see src/runner.ts). */
  RUNNER: DurableObjectNamespace<RunnerContainer>;
  /**
   * The one-time code that claims ownership. Without it, one is generated on
   * first use, kept in D1 and written to the Worker's logs.
   */
  SETUP_CODE?: string;
  /** The OAuth client's private JWK. Without it, one is generated into D1. */
  OAUTH_SIGNING_KEY?: string;
  /**
   * A Cloudflare API token for per-repo push event subscriptions. Without it,
   * push-triggered features degrade to manual (fail soft).
   */
  CF_API_TOKEN?: string;
};
