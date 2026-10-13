#!/usr/bin/env bun
/**
 * `bun create mycelium [folder]`: make a folder that deploys a Mycelium instance.
 *
 * The folder holds the owner's settings (mycelium.config.json) and depends on
 * the instance package, which ships the prebuilt Worker, web app, runner and
 * the mycelium CLI. It is meant to be its own git repo: commit it, and
 * updating Mycelium is bumping that dependency.
 *
 *   --from <spec>      install the instance package from <spec> instead of npm
 *                      (a version, a tarball path or URL)
 *   --no-workflow      leave out .github/workflows/deploy.yml
 *   --deploy           deploy after setup without asking
 *   --no-deploy        stop after setup
 *   --worker, --title, --domain, --yes
 *                      passed on to `mycelium setup` (answers without prompts)
 */
import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { scaffoldFiles } from "./files.ts";

declare const MYCELIUM_PACKAGE: string;
declare const MYCELIUM_VERSION: string;
declare const CF_VERSION: string;
declare const WRANGLER_VERSION: string;

const args = process.argv.slice(2);
const take = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const has = (name: string) => {
  const i = args.indexOf(name);
  if (i !== -1) args.splice(i, 1);
  return i !== -1;
};
const from = take("--from");
const setupArgs: string[] = [];
for (const name of ["--worker", "--title", "--domain"]) {
  const value = take(name);
  if (value !== undefined) setupArgs.push(name, value);
}
if (has("--yes")) setupArgs.push("--yes");
const noWorkflow = has("--no-workflow");
const deployNow = has("--deploy");
const noDeploy = has("--no-deploy");
const folder = args.find((a) => !a.startsWith("--")) ?? "my-mycelium";
const dir = resolve(folder);

if (existsSync(dir) && readdirSync(dir).length > 0) {
  console.error(`${folder} already exists and isn't empty.`);
  process.exit(1);
}

console.log(`\nCreating a Mycelium instance in ${folder}\n`);
mkdirSync(dir, { recursive: true });

const files = scaffoldFiles({
  name: basename(dir),
  packageName: MYCELIUM_PACKAGE,
  packageSpec: from ? resolveSpec(from) : `^${MYCELIUM_VERSION}`,
  cfVersion: CF_VERSION,
  wranglerVersion: WRANGLER_VERSION,
  workflow: !noWorkflow,
});
for (const [name, content] of Object.entries(files)) {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
}
console.log("✓ Wrote the instance folder");

await $`bun install`.cwd(dir).quiet();
console.log(`✓ Installed ${MYCELIUM_PACKAGE}`);

if ((await $`git --version`.nothrow().quiet()).exitCode === 0) {
  await $`git init -q`.cwd(dir).nothrow();
}

const whoami = await $`bun run cf auth whoami`.cwd(dir).nothrow().quiet();
let signedIn = false;
try {
  signedIn = whoami.exitCode === 0 && JSON.parse(whoami.stdout.toString()).authenticated;
} catch {
  // Unparseable output means cf could not report a session.
}
if (!signedIn) {
  console.log("\nSign in to Cloudflare (a browser window opens):");
  await interactive(["bun", "run", "cf", "auth", "login"]);
}

await interactive(["bun", "run", "mycelium", "setup", ...setupArgs]);

const deploy =
  deployNow ||
  (!noDeploy &&
    process.stdin.isTTY &&
    (prompt("Deploy it now? (needs Docker running) [Y/n]") ?? "").trim().toLowerCase() !== "n");
if (deploy) await interactive(["bun", "run", "mycelium", "deploy"]);

console.log(
  `\nDone. Your instance lives in ${folder}: commit it, and deploy with \`bun run deploy\`.\n`,
);

/** Run a command in the new folder with this terminal, so it can prompt. */
async function interactive(cmd: string[]) {
  const code = await Bun.spawn(cmd, { cwd: dir, stdio: ["inherit", "inherit", "inherit"] }).exited;
  if (code !== 0) process.exit(code);
}

/** A local tarball path becomes absolute, so the new folder can install it. */
function resolveSpec(spec: string): string {
  return /^(\.|\/).*\.tgz$/.test(spec) ? resolve(spec) : spec;
}
