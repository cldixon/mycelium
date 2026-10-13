/** A Mycelium instance's settings, as mycelium.config.json holds them. */
export type MyceliumConfig = {
  /** Worker name. Also names the D1 database, the queues and (by default) the Artifacts namespace. */
  worker: string;
  /** Artifacts namespace that holds the repos. Defaults to the Worker name. */
  namespace?: string;
  /** D1 database for instance state. Defaults to the Worker name. */
  database?: string;
  /** Custom domain on a zone in your account. Without one, workers.dev serves the instance. */
  domain?: string | null;
  title?: string;
};

/**
 * The instance Worker's cf config, from the mycelium.config.json in `dir`.
 * Use as the default export of cloudflare.config.ts:
 *
 *   export default defineMycelium({ dir: import.meta.dirname });
 */
export function defineMycelium(options: { dir: string; entrypoint?: string }): unknown;

export function loadMyceliumConfig(
  dir: string,
  options?: { allowDefaults?: boolean },
): MyceliumConfig;

/** The queues the instance uses, named after its Worker. */
export function queueNames(worker: string): { events: string; jobs: string };
