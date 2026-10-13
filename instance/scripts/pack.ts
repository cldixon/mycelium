#!/usr/bin/env bun
/**
 * Build the publishable @mycelium/instance package into dist/package and pack
 * it into dist/, then create-mycelium into dist/create-mycelium. Publishing is
 * a separate, manual step.
 *
 * The instance package holds the prebuilt Worker bundle, the built web UI,
 * the runner's Dockerfile and bundled server, the defineMycelium config helper
 * and the mycelium CLI, so owners deploy without building mycelium's source.
 */
import { $ } from "bun";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";

export const PACKAGE_NAME = "@mycelium/instance";

const root = join(import.meta.dirname, "..");
const repo = join(root, "..");
const out = join(root, "dist", "package");
const own = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const REPOSITORY = "git+https://github.com/cldixon/mycelium.git";

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The web UI, then the Worker bundle. The bundle doesn't depend on any owner's
// settings, so the example config stands in for one. cf build also builds the
// repo's runner image (not shipped), which copies runner/bun.
const runnerBun = join(repo, "runner", "bun");
if (!existsSync(runnerBun)) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`Put a linux-x64 bun binary at ${runnerBun} first`);
  }
  copyFileSync(process.execPath, runnerBun);
  chmodSync(runnerBun, 0o755);
}
await $`bun run build`.cwd(root).quiet();
await $`bunx cf build`
  .cwd(root)
  .env({ ...process.env, MYCELIUM_CONFIG: "mycelium.config.example.json" })
  .quiet();
const built = join(root, ".cloudflare", "output", "v0", "workers", "default");
cpSync(join(built, "bundle"), join(out, "worker"), { recursive: true });
cpSync(join(root, "web", "build"), join(out, "web"), { recursive: true });

// The config helper and the CLI. cf and wrangler come from the owner's folder.
const external = ["cf", "cf/*", "wrangler", "wrangler/*"];
for (const [entry, target, naming] of [
  ["config.ts", "node", "config.js"],
  ["cli/mycelium.ts", "bun", "cli.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    outdir: out,
    target,
    format: "esm",
    external,
    naming,
  });
  if (!result.success) throw new AggregateError(result.logs, `Couldn't bundle ${entry}`);
}
cpSync(join(root, "package"), out, { recursive: true });

// The runner: its server bundled into one file next to a Dockerfile that takes
// bun from its official image, pinned to the bun that packed this.
const runner = await Bun.build({
  entrypoints: [join(repo, "runner", "src", "server.ts")],
  outdir: join(out, "runner"),
  target: "bun",
  format: "esm",
  naming: "server.js",
});
if (!runner.success) throw new AggregateError(runner.logs, "Couldn't bundle the runner");
const dockerfile = join(out, "runner", "Dockerfile");
writeFileSync(
  dockerfile,
  readFileSync(dockerfile, "utf-8").replaceAll("__BUN_VERSION__", Bun.version),
);

const cf = own.devDependencies.cf;
const wrangler = own.devDependencies.wrangler;
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: PACKAGE_NAME,
      version: own.version,
      description:
        "A Mycelium instance: a private, self-deployed GitHub-like service on Cloudflare",
      type: "module",
      license: "MIT",
      repository: { type: "git", url: REPOSITORY, directory: "instance" },
      bin: { mycelium: "cli.js" },
      exports: {
        "./config": { types: "./config.d.ts", default: "./config.js" },
        "./wrangler": "./wrangler.js",
      },
      files: [
        "cli.js",
        "config.js",
        "config.d.ts",
        "wrangler.js",
        "worker",
        "web",
        "runner",
        "README.md",
      ],
      peerDependencies: { cf, wrangler },
      engines: { bun: ">=1.2.0" },
    },
    null,
    2,
  ) + "\n",
);

await $`bun pm pack --destination ${join(root, "dist")}`.cwd(out).quiet();
console.log(`✓ Packed ${PACKAGE_NAME}@${own.version} into dist/`);

// create-mycelium, released in step with the instance, so `bun create
// mycelium` always installs the matching version.
const create = join(root, "dist", "create-mycelium");
mkdirSync(create, { recursive: true });
const scaffold = await Bun.build({
  entrypoints: [join(repo, "packages", "create-mycelium", "src", "index.ts")],
  outdir: create,
  target: "bun",
  format: "esm",
  naming: "index.js",
  define: {
    MYCELIUM_PACKAGE: JSON.stringify(PACKAGE_NAME),
    MYCELIUM_VERSION: JSON.stringify(own.version),
    CF_VERSION: JSON.stringify(cf),
    WRANGLER_VERSION: JSON.stringify(wrangler),
  },
});
if (!scaffold.success) throw new AggregateError(scaffold.logs, "Couldn't bundle create-mycelium");
writeFileSync(
  join(create, "README.md"),
  "# create-mycelium\n\nCreate your own [Mycelium](https://github.com/cldixon/mycelium) instance:\n\n```bash\nbun create mycelium my-mycelium\n```\n",
);
writeFileSync(
  join(create, "package.json"),
  JSON.stringify(
    {
      name: "create-mycelium",
      version: own.version,
      description:
        "Create your own Mycelium instance: a private, self-deployed GitHub-like service on Cloudflare",
      type: "module",
      license: "MIT",
      repository: { type: "git", url: REPOSITORY, directory: "packages/create-mycelium" },
      bin: { "create-mycelium": "index.js" },
      files: ["index.js", "README.md"],
      engines: { bun: ">=1.2.0" },
    },
    null,
    2,
  ) + "\n",
);
await $`bun pm pack --destination ${join(root, "dist")}`.cwd(create).quiet();
console.log(`✓ Packed create-mycelium@${own.version} into dist/`);
