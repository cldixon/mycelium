# Mycelium

A private, single-owner, GitHub-like service that you deploy into your own Cloudflare account.
Git repos live in Cloudflare Artifacts; a Worker (Hono + a SvelteKit SPA) serves code browsing,
pull requests and Actions-style workflows; D1 holds instance state; Queues carry push events and
jobs; a Container runs git, merges and workflow steps. Agent-first features come later, on top of
this base.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) (the v0 contract) and [`CLAUDE.md`](CLAUDE.md)
(conventions) before changing anything.

## Layout

```
instance/            @mycelium/instance: the Worker
  config.ts          defineMycelium(): the only place the cf config is built
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
