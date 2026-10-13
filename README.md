# Mycelium

A private, single-owner, GitHub-like service that you deploy into your own Cloudflare account.
Git repos live in Cloudflare Artifacts; a Worker (Hono + a SvelteKit SPA) serves code browsing,
pull requests and Actions-style workflows; D1 holds instance state; Queues carry push events and
jobs; a Container runs git, merges and workflow steps. Agent-first features come later, on top of
this base.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) (the v0 contract) and [`CLAUDE.md`](CLAUDE.md)
(conventions) before changing anything.

## Deploy your own

You need [Bun](https://bun.sh), a Cloudflare account (Workers paid plan, for Containers) and
[Docker](https://docs.docker.com/get-docker/) running: deploying builds the runner's container
image.

```sh
bun create mycelium my-mycelium
```

That makes a folder (your own repo: commit it) holding your settings, `mycelium.config.json`, and
depending on `@mycelium/instance`, which ships the prebuilt Worker, web app and runner. It signs
you in to Cloudflare, asks for a Worker name, title and optional custom domain, creates the two
queues (`<worker>-events`, `<worker>-jobs`) and offers to deploy. The first deploy prints a
**setup code**: open `/signin` on your instance and sign in with your AT Protocol account (e.g.
Bluesky) and that code to become its owner.

Inside the folder:

| Command                                             | What it does                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `bun run setup`                                     | Change the settings, create missing queues (re-run any time)       |
| `bun run deploy`                                    | Deploy; the first deploy sets the setup code and OAuth key         |
| `bun run dev`                                       | Run it locally on http://127.0.0.1:8787                            |
| `bun run secrets`                                   | New setup code and OAuth key (before claiming only)                |
| `CF_API_TOKEN=… bunx mycelium secrets cf-api-token` | Turn on push events (pushes start workflows, update pull requests) |

Push events are optional: without `CF_API_TOKEN` everything else works and workflows run by hand.
Non-interactive setup takes flags: `mycelium setup --worker my-forge --title "My forge" --yes`.

**Deploy on push:** the folder includes `.github/workflows/deploy.yml`, which deploys every push to
`main` once the repo has a `CLOUDFLARE_API_TOKEN` secret, and skips until then. GitHub-hosted
runners have the Docker it needs. CI never prints a setup code (logs may be public); run
`bun run secrets` locally for one.

**Update:** `bun update @mycelium/instance && bun run deploy`. Migrations apply themselves.

From a clone of this repo, the same CLI runs in `instance/`: `bun run setup`, `bun run deploy`
(builds the web app first, and copies your bun into `runner/bun` for the image on linux-x64), and
`bun run pack` builds both publishable packages into `instance/dist/` (it doesn't publish).

## Layout

```
instance/            @mycelium/instance: the Worker
  config.ts          defineMycelium(): the only place the cf config is built
  cli/mycelium.ts    the mycelium CLI: setup, deploy, secrets, dev
  scripts/pack.ts    build the publishable package (templates in package/) and create-mycelium
  src/api/           Hono app, routes (one file per feature), session guards
  src/auth/          owner + setup code, OAuth client, API tokens (myc_…)
  src/db/            self-applying D1 migrations
  src/git/           Artifacts helpers, ref listing over smart HTTP
  src/hooks/push.ts  extension point: react to pushes
  src/jobs/          extension point: workflow runs from the jobs queue
  src/runner.ts      typed client for the runner container
  src/queue.ts       queue consumer (events + jobs)
  src/shared/        types shared with the web app and the runner
  web/               @mycelium/instance-web: SvelteKit SPA
runner/              @mycelium/runner: the container (Dockerfile, Bun server, jobs)
packages/platform/   @mycelium/platform: migrations, settings, OAuth, sessions (from igloo)
packages/ui/         @mycelium/ui: design tokens and Svelte components (from igloo)
packages/create-mycelium/  `bun create mycelium`: an owner's deploy folder
probes/              throwaway exploration code; not part of the build
```

## Develop

Requires [Bun](https://bun.sh) and the `cf` CLI (installed as a dev dependency).

```sh
bun install
bun run check                      # format check, typecheck, svelte-check, tests
bun run format                     # prettier --write
bun run --cwd instance build       # build the SPA into instance/web/build
bun run --cwd instance dev         # cf dev on :8787 + vite on :5173 (--local: no config file)
```

Instance settings live in `instance/mycelium.config.json` (gitignored; copy
`mycelium.config.example.json`). `MYCELIUM_*` environment variables override it and
`MYCELIUM_CONFIG` picks another file.

Building the runner image needs the bun binary next to its Dockerfile:
`cp "$(which bun)" runner/bun` (gitignored). Validate the whole config without deploying:

```sh
cd instance && MYCELIUM_CONFIG=mycelium.config.example.json bunx cf deploy --dry-run
```

## License

MIT
