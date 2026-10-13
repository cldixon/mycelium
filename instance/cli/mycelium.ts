#!/usr/bin/env bun
/**
 * mycelium: set up, deploy and look after one Mycelium instance. Runs in the
 * folder that holds its mycelium.config.json (`instance/` in the mycelium
 * repo, or a deploy folder made by `bun create mycelium`).
 *
 *   mycelium setup     ask for the settings, write mycelium.config.json and
 *                      create the two queues (safe to re-run)
 *                        --worker <name> --title <title> --domain <host|->
 *                        --yes   don't ask; use flags, MYCELIUM_* or defaults
 *   mycelium deploy    check Docker, build the web app (in the repo), deploy;
 *                      on the very first deploy, also set the setup code and
 *                      OAuth key and print the setup code (never in CI)
 *                        --no-build   skip the web app build (repo only)
 *                        -- <args>    passed on to cf deploy
 *   mycelium secrets   set a new setup code and OAuth key (only before the
 *                      instance is claimed: a new OAuth key signs out the owner)
 *   mycelium secrets cf-api-token
 *                      set CF_API_TOKEN (from the environment, or asked for),
 *                      which turns on push events
 *   mycelium dev       run the instance locally (`--local`: no config file)
 */
import { $ } from "bun";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { generateSigningJwk, generateToken } from "@mycelium/platform";
import {
  DEFAULTS,
  configPath,
  loadMyceliumConfig,
  queueNames,
  readConfigFile,
  runnerDockerfile,
  type MyceliumConfig,
} from "../config.ts";
import {
  copiesBunBinary,
  domainError,
  isAuthenticated,
  missingQueues,
  nextConfig,
  parseArgs,
  workerNameError,
} from "./helpers.ts";

const root = process.cwd();
const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
/** In the mycelium repo (source and web app here), not a deploy folder. */
const inRepo = existsSync(join(root, "scripts", "dev.ts")) && existsSync(join(root, "web", "src"));

const commands: Record<string, () => Promise<void>> = { setup, deploy, secrets, dev };
const run = command ? commands[command] : undefined;
if (!run) {
  console.log("Usage: mycelium <setup|deploy|secrets|dev>");
  process.exit(command && command !== "help" && command !== "--help" ? 1 : 0);
}
await run();

// --- commands ----------------------------------------------------------------

async function setup() {
  console.log("\nmycelium setup\n");
  // Setup may create the file MYCELIUM_CONFIG names, and runs cf (which
  // evaluates the config) before there is one; everything else requires it.
  process.env.MYCELIUM_SETUP = "1";
  $.env(process.env);
  await requireAuth();

  const file = configPath(root);
  // Re-running setup offers the current answers as the defaults.
  const current: Partial<MyceliumConfig> = readConfigFile(root) ?? {};
  const asking = !args.flags.yes && process.stdin.isTTY;

  const worker = answer(
    "Worker name (also names its database, queues and repos namespace)",
    "worker",
    "MYCELIUM_WORKER",
    current.worker ?? DEFAULTS.worker,
    workerNameError,
  );
  const title = answer(
    "Title",
    "title",
    "MYCELIUM_TITLE",
    current.title ?? DEFAULTS.title,
    () => null,
  );
  const domainAnswer = answer(
    'Custom domain, on a zone in your Cloudflare account (blank for workers.dev, "-" to remove)',
    "domain",
    "MYCELIUM_DOMAIN",
    current.domain ?? "",
    (d) => (d === "-" ? null : domainError(d)),
  );
  const domain = domainAnswer === "-" ? "" : domainAnswer;

  const config = nextConfig(current, { worker, title, domain });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n✓ Wrote ${basename(file)}`);
  console.log(
    domain
      ? `✓ Routing ${domain} to this Worker (the zone must be on your account)`
      : `✓ No custom domain: your instance will be served from *.workers.dev`,
  );

  // cf deploy fails if the queues it consumes don't exist yet. The D1
  // database it creates itself.
  await ensureQueues(worker);

  console.log(`
Optional: push events. With a CF_API_TOKEN secret, new repos get a push event
subscription, so pushes start workflows and update pull requests. Without it
everything else works and workflows run by hand. To turn it on, create a
Cloudflare API token that can manage event subscriptions and queues on this
account, then: CF_API_TOKEN=<token> mycelium secrets cf-api-token
`);
  console.log(`Next: ${inRepo ? "bun cli/mycelium.ts deploy" : "bun run deploy"}\n`);

  function answer(
    question: string,
    flag: string,
    env: string,
    fallback: string,
    invalid: (value: string) => string | null,
  ): string {
    const given = args.flags[flag];
    let value = typeof given === "string" ? given : (process.env[env] ?? null);
    if (value === null && asking) {
      value = prompt(`${question} [${fallback}]:`)?.trim() || fallback;
    }
    value ??= fallback;
    let problem = invalid(value);
    while (problem && asking) {
      console.log(`  ${problem}`);
      value = prompt(`${question} [${fallback}]:`)?.trim() || fallback;
      problem = invalid(value);
    }
    if (problem) fail(`${flag} "${value}": ${problem}`);
    return value;
  }
}

async function deploy() {
  const config = loadMyceliumConfig(root);
  await requireAuth();
  await requireDocker();
  ensureRunnerBun();

  if (inRepo && !args.flags["no-build"]) {
    console.log("→ Building the web app");
    await $`bun run build`.cwd(root).quiet();
  }
  // The published package ships the web app prebuilt.
  if (inRepo && !existsSync(join(root, "web", "build", "index.html"))) {
    fail("The web app isn't built. Run: bun run build");
  }
  await ensureQueues(config.worker);

  // A Worker that already exists keeps its secrets, or the keys it generated
  // in D1; replacing either would sign its owner out.
  const existed = await workerExists(config.worker);
  const code = await interactive([...cf(), "deploy", ...args.positionals]);
  if (code !== 0) process.exit(code);
  if (existed) return;

  if (process.env.CF_API_TOKEN) await setCfApiToken(config.worker, process.env.CF_API_TOKEN);
  if (process.env.CI) {
    // CI logs can be public, and the setup code claims the instance. The
    // instance makes its own on first use and writes it to the Worker's logs.
    console.log("\nNo setup code was set here, since CI logs may be public.");
    console.log(
      "Run `mycelium secrets` on your own machine to get one before you claim the instance.\n",
    );
    return;
  }
  await setSetupSecrets(config.worker);
}

async function secrets() {
  const { worker } = loadMyceliumConfig(root);
  await requireAuth();
  const [which] = args.positionals;
  if (which === "cf-api-token") {
    const token =
      process.env.CF_API_TOKEN ||
      (process.stdin.isTTY ? prompt("Cloudflare API token for push events:")?.trim() : "");
    if (!token) fail("No token: set CF_API_TOKEN in the environment, or run this in a terminal.");
    await setCfApiToken(worker, token);
    return;
  }
  if (which) fail(`Unknown secret "${which}". Try: mycelium secrets [cf-api-token]`);
  await setSetupSecrets(worker);
}

async function dev() {
  if (inRepo) {
    // The Worker under cf dev plus the web app under Vite, with HMR.
    process.exit(await interactive(["bun", "scripts/dev.ts", ...rest]));
  }
  const local = Boolean(args.flags.local);
  process.exit(
    await interactive([...cf(), "dev", "--port", "8787", ...(local ? ["--mode", "local"] : [])]),
  );
}

// --- steps -------------------------------------------------------------------

async function setSetupSecrets(worker: string) {
  const setupCode = generateToken(12);
  const signingKey = await generateSigningJwk();
  await putSecret(worker, "SETUP_CODE", setupCode);
  await putSecret(worker, "OAUTH_SIGNING_KEY", signingKey);
  console.log(`\nSetup code: ${setupCode}`);
  console.log("Open /signin on your instance and sign in with it to claim the instance.\n");
}

async function setCfApiToken(worker: string, token: string) {
  await putSecret(worker, "CF_API_TOKEN", token);
}

async function putSecret(worker: string, name: string, value: string) {
  const result =
    await $`${cf()} workers secrets update ${name} --worker ${worker} --type secret_text --text ${value}`
      .cwd(root)
      .nothrow()
      .quiet();
  if (result.exitCode !== 0) {
    fail(`Couldn't set ${name} on ${worker}: ${result.stderr.toString() || result.stdout}`);
  }
  console.log(`✓ ${name} set on ${worker}`);
}

/** Create the instance's two queues if they're missing. */
async function ensureQueues(worker: string) {
  const { events, jobs } = queueNames(worker);
  const listed = await $`${cf()} queues list`.cwd(root).nothrow().quiet();
  let listing: unknown = [];
  try {
    listing = JSON.parse(listed.stdout.toString());
  } catch {
    // Treat an unreadable listing as empty; create reports "already exists".
  }
  for (const name of [events, jobs]) {
    if (!missingQueues(listing, [name]).length) {
      console.log(`✓ Queue ${name} exists`);
      continue;
    }
    const created = await $`${cf()} queues create --queue-name ${name}`.cwd(root).nothrow().quiet();
    const output = `${created.stdout}${created.stderr}`;
    if (created.exitCode !== 0 && !/already (exists|taken)/i.test(output)) {
      fail(`Couldn't create queue ${name}: ${output}`);
    }
    console.log(`✓ Queue ${name} created`);
  }
}

async function workerExists(worker: string): Promise<boolean> {
  const listed = await $`${cf()} workers secrets list --worker ${worker}`
    .cwd(root)
    .nothrow()
    .quiet();
  return listed.exitCode === 0;
}

async function requireAuth() {
  const whoami = await $`${cf()} auth whoami`.cwd(root).nothrow().quiet();
  if (whoami.exitCode !== 0 || !isAuthenticated(whoami.stdout.toString())) {
    fail(`Not signed in to Cloudflare. Run: ${cf().join(" ")} auth login`);
  }
}

async function requireDocker() {
  const info = await $`docker info`.nothrow().quiet();
  if (info.exitCode !== 0) {
    fail(
      "Docker isn't running. Deploying builds the runner's container image with Docker:\n" +
        "start Docker (Docker Desktop, OrbStack, colima or dockerd) and try again.",
    );
  }
}

/**
 * The repo's runner/Dockerfile copies a bun binary from its build context
 * (runner/bun, gitignored). Cloudflare runs containers on linux/amd64, so on
 * such a machine the bun running this CLI is the right one to copy.
 */
function ensureRunnerBun() {
  const dockerfile = runnerDockerfile();
  if (!copiesBunBinary(readFileSync(dockerfile, "utf-8"))) return;
  const target = join(dirname(dockerfile), "bun");
  if (existsSync(target)) return;
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail(
      `${target} is missing: put a linux-x64 bun binary there (from ` +
        "https://github.com/oven-sh/bun/releases) so the runner image can be built.",
    );
  }
  copyFileSync(process.execPath, target);
  chmodSync(target, 0o755);
  console.log(`✓ Copied this bun (${Bun.version}) into ${target} for the runner image`);
}

// --- plumbing ----------------------------------------------------------------

/** The cf CLI: the folder's own install when there is one. */
function cf(): string[] {
  const local = join(root, "node_modules", ".bin", "cf");
  if (existsSync(local)) return [local];
  return Bun.which("cf") ? ["cf"] : ["bunx", "cf"];
}

/** Run a command with this terminal, so it can prompt. */
function interactive(cmd: string[]): Promise<number> {
  return Bun.spawn(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] }).exited;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}
