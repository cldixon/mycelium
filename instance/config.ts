import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";

/**
 * What makes one Mycelium instance different from another. The code is the
 * same for everyone; these settings are each owner's, so they live in a
 * gitignored mycelium.config.json, never in the source.
 */
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

export const CONFIG_FILE = "mycelium.config.json";

export const DEFAULTS = {
  worker: "mycelium-instance",
  title: "mycelium",
} as const;

/** Environment variables that override the file, for CI. */
const ENV: Record<keyof MyceliumConfig, string> = {
  worker: "MYCELIUM_WORKER",
  namespace: "MYCELIUM_NAMESPACE",
  database: "MYCELIUM_DATABASE",
  domain: "MYCELIUM_DOMAIN",
  title: "MYCELIUM_TITLE",
};

/** The config file's path: mycelium.config.json, or the file `MYCELIUM_CONFIG` names. */
export function configPath(dir: string): string {
  const named = process.env.MYCELIUM_CONFIG;
  return named ? (isAbsolute(named) ? named : join(dir, named)) : join(dir, CONFIG_FILE);
}

/** Read the config file, or null if there isn't one. */
export function readConfigFile(dir: string): Partial<MyceliumConfig> | null {
  const path = configPath(dir);
  if (!existsSync(path)) {
    if (process.env.MYCELIUM_CONFIG && !process.env.MYCELIUM_SETUP) {
      throw new Error(`MYCELIUM_CONFIG points at ${path}, which doesn't exist`);
    }
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Partial<MyceliumConfig>;
}

/**
 * The instance's settings: the config file, then environment overrides.
 *
 * Without either, this throws unless `allowDefaults` is set (local dev and
 * type generation). A deploy that silently fell back to defaults could bind
 * a different namespace and drop the custom domain from a running instance.
 */
export function loadMyceliumConfig(dir: string, { allowDefaults = false } = {}): MyceliumConfig {
  const file = readConfigFile(dir);
  const env: Partial<MyceliumConfig> = {};
  for (const [key, name] of Object.entries(ENV) as [keyof MyceliumConfig, string][]) {
    const value = process.env[name];
    if (value !== undefined) (env as Record<string, string | null>)[key] = value || null;
  }
  // `mycelium setup` runs cf commands before the file exists, and cf evaluates
  // this config for every command run in the folder.
  if (!file && !env.worker && !allowDefaults && !process.env.MYCELIUM_SETUP) {
    throw new Error(
      `No ${CONFIG_FILE} in ${dir}. Run \`mycelium setup\` to create one, ` +
        `or set MYCELIUM_WORKER (and MYCELIUM_DOMAIN, MYCELIUM_NAMESPACE) in the environment.`,
    );
  }
  const config = { ...DEFAULTS, ...file, ...env } as MyceliumConfig;
  if (!config.worker) throw new Error(`${CONFIG_FILE} needs a worker name`);
  return config;
}

/** The queues the instance uses, named after its Worker. */
export const queueNames = (worker: string) => ({
  /** Artifacts push events (from per-repo event subscriptions). */
  events: `${worker}-events`,
  /** The instance's own async jobs (workflow runs). */
  jobs: `${worker}-jobs`,
});

/**
 * The runner image's Dockerfile. The published package ships it in runner/
 * next to this file (config.js); in the repo it is the runner workspace.
 */
export function runnerDockerfile(): string {
  const packaged = join(import.meta.dirname, "runner", "Dockerfile");
  return existsSync(packaged)
    ? packaged
    : resolve(import.meta.dirname, "..", "runner", "Dockerfile");
}

/**
 * The instance Worker's cf config, built from the owner's settings in `dir`.
 * The only place the cf config is built. The repo's own instance passes its
 * source entrypoint; the published package defaults to the prebuilt bundle it
 * ships (worker/worker.js next to config.js).
 *
 * `--mode local` (`dev --local`) needs no config file. Artifacts has no local
 * simulation, so the binding is always remote.
 */
export function defineMycelium({ dir, entrypoint }: { dir: string; entrypoint?: string }) {
  return defineConfig(({ mode }) => {
    const local = mode === "local";
    const mycelium = loadMyceliumConfig(dir, {
      allowDefaults: local || process.argv.includes("types") || process.argv.includes("dev"),
    });
    const domain = mycelium.domain || null;
    const queues = queueNames(mycelium.worker);

    // The runner: git, diffs, merges and workflow steps in a Linux container.
    // Build context is the Dockerfile's folder (see runner/Dockerfile for bun).
    const runner = defineContainer({
      name: `${mycelium.worker}-runner`,
      image: { dockerfile: runnerDockerfile() },
      instanceType: "basic",
      maxInstances: 5,
    });

    return {
      worker: {
        name: mycelium.worker,
        compatibilityDate: "2026-10-06",
        compatibilityFlags: ["nodejs_compat"],
        entrypoint: entrypoint ?? join(import.meta.dirname, "worker", "worker.js"),
        observability: { enabled: true },

        // The zone must be on your own Cloudflare account. Without a domain,
        // workers.dev is the only route the Worker has, so it is turned on.
        ...(domain && { domains: [domain] }),
        workersDev: !domain,

        // Preview versions share production's bindings, and migrations apply
        // themselves on first request, so a preview could migrate the real
        // database. Test locally instead.
        previewUrls: false,

        // The SvelteKit SPA (directory set in wrangler.config.ts). Navigation
        // requests that do not match a built asset fall through to index.html;
        // runWorkerFirst claims the API paths so they reach the Worker instead.
        assets: {
          notFoundHandling: "single-page-application",
          runWorkerFirst: ["/api/*", "/oauth/*", "/health"],
        },

        // Secrets (SETUP_CODE, OAUTH_SIGNING_KEY, CF_API_TOKEN) are optional
        // and not declared here, so a deploy without them works: the first
        // two are generated into settings on first use, and without
        // CF_API_TOKEN push subscriptions are skipped. See src/api/bindings.ts.
        env: {
          // Instance state. Migrates itself on first use. cf deploy creates it.
          DB: bindings.d1({ name: mycelium.database ?? mycelium.worker }),
          // The git repos.
          ARTIFACTS: bindings.artifacts({
            namespace: mycelium.namespace ?? mycelium.worker,
            dev: { remote: true },
          }),
          ASSETS: bindings.assets(),
          JOBS: bindings.queue({ name: queues.jobs }),
          RUNNER: bindings.durableObject({
            worker: mycelium.worker,
            exportName: "RunnerContainer",
          }),
          INSTANCE_TITLE: bindings.text(mycelium.title ?? DEFAULTS.title),
        },

        triggers: [
          triggers.queue({ name: queues.events, maxBatchSize: 50, maxBatchTimeout: 2 }),
          triggers.queue({ name: queues.jobs, maxBatchSize: 1, maxRetries: 2 }),
        ],

        exports: {
          RunnerContainer: exports.durableObject({ storage: "sqlite", container: runner }),
        },
      },
      containers: [runner],
    };
  });
}
