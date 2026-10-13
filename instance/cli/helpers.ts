/**
 * Pure helpers for the mycelium CLI (cli/mycelium.ts), kept apart so they can
 * be tested without Cloudflare, Docker or a terminal.
 */
import type { MyceliumConfig } from "../config.ts";

/** `--name value` and `--name=value` flags, plus bare `--switch`es and positionals. */
export type Args = { flags: Record<string, string | true>; positionals: string[] };

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && VALUE_FLAGS.has(arg.slice(2))) {
      flags[arg.slice(2)] = next;
      i++;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { flags, positionals };
}

/** Flags that take a value; every other flag is a switch. */
const VALUE_FLAGS = new Set(["worker", "title", "domain", "namespace", "database"]);

/**
 * Worker names become the D1 database, queue (`-events`, `-jobs`) and
 * container (`-runner`) names, so they follow the strictest of those rules.
 */
export function workerNameError(name: string): string | null {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return "Use lowercase letters, digits and dashes, starting and ending with a letter or digit";
  }
  if (name.length > 56) return "Keep it to 56 characters (queue names add -events, up to 63)";
  return null;
}

/** A domain (host name) or nothing. */
export function domainError(domain: string): string | null {
  if (!domain) return null;
  if (/^https?:\/\//.test(domain) || domain.includes("/")) return "Give a host name, not a URL";
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) return "Not a domain name";
  return null;
}

export type SetupAnswers = { worker: string; title: string; domain: string };

/**
 * The config `mycelium setup` writes: the current file's other settings kept,
 * these answers on top. A namespace or database the owner set by hand stays.
 */
export function nextConfig(
  current: Partial<MyceliumConfig>,
  answers: SetupAnswers,
): MyceliumConfig {
  return {
    ...current,
    worker: answers.worker,
    title: answers.title,
    domain: answers.domain || null,
  };
}

/** Queue names missing from a `cf queues list` answer. */
export function missingQueues(listing: unknown, wanted: string[]): string[] {
  const have = new Set(
    (Array.isArray(listing) ? listing : []).map((q: { queue_name?: string }) => q?.queue_name),
  );
  return wanted.filter((name) => !have.has(name));
}

/**
 * Whether a runner Dockerfile copies a bun binary from its build context (the
 * repo's runner/Dockerfile does; the published package's takes bun from an
 * image instead).
 */
export const copiesBunBinary = (dockerfile: string) => /^\s*COPY\s+bun\s/m.test(dockerfile);

/** The answer from `cf auth whoami`: signed in or not. */
export function isAuthenticated(stdout: string): boolean {
  try {
    return Boolean(JSON.parse(stdout).authenticated);
  } catch {
    return false;
  }
}
