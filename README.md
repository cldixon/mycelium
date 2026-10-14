# Mycelium

A private, single-owner, GitHub-like service that you deploy into your own Cloudflare account,
built for agents as much as for people. Git repos live in
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/); one Worker (Hono + a
SvelteKit SPA) serves code browsing, pull requests, Actions-style workflows and an MCP server; D1
holds instance state; Queues carry push events and jobs; Durable Objects push live updates; a
Container runs git, merges and workflow steps.

- **Code:** repos (create, import a public git URL), files, branches, tags, commits and diffs,
  contributors.
- **Pull requests:** branch to branch, diff, merge / squash / rebase in the runner container,
  conflicts reported without touching the base, comments.
- **Actions:** `.mycelium/workflows/*.yml` run in a container on push, on pull requests or by hand,
  with logs streamed while they run.
- **Required checks:** workflows that must pass on a PR's head before it can merge.
- **Agents:** an MCP server at `/mcp`; API tokens issued to named agents (read or write); every PR,
  comment, run and git credential grant records which agent did it.
- **Live:** pages update in place over WebSockets; `/activity` shows everything as it happens.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) (the contract) and [`CLAUDE.md`](CLAUDE.md)
(conventions) before changing anything.

## Try the demo

<https://mycelium-demo.cl-dixon.workers.dev> runs this code. Its public repo
[`tinyroute`](https://mycelium-demo.cl-dixon.workers.dev/tinyroute) has pull requests opened and
merged by agents, workflow runs and a required `test` check; [`/activity`](https://mycelium-demo.cl-dixon.workers.dev/activity)
follows what happens live.

## Agents

An agent works here the way a developer does: through the MCP server for repos, pull requests and
workflows, and plain git for code.

1. The owner creates a token for the agent in **Settings → API tokens** (agent name, read or write).
2. The agent connects to `https://<instance>/mcp` with `Authorization: Bearer <token>`. For Claude
   Code: `claude mcp add --transport http mycelium https://<instance>/mcp --header "Authorization: Bearer <token>"`.
3. `git_credentials` returns a short-lived git token and the exact commands; then clone, branch,
   commit, push, `open_pull`, wait for the checks in `get_pull`, `merge_pull`.

[`skills/mycelium/SKILL.md`](skills/mycelium/SKILL.md) is the agent-facing guide.
[`demo/fleet`](demo/fleet) runs several scripted agents against an instance at once.

## Deploy your own

You need [Bun](https://bun.sh), a Cloudflare account on the Workers paid plan (Containers and
Artifacts), and [Docker](https://docs.docker.com/get-docker/) running: deploying builds the
runner's container image.

```sh
git clone https://github.com/cldixon/mycelium && cd mycelium
bun install
cd instance
bunx cf auth login                 # or set CLOUDFLARE_API_TOKEN
bun run setup                      # Worker name, title, optional domain; creates the two queues
bun run deploy                     # builds the web app and runner image, deploys, prints a setup code
```

Open `/signin` on your instance and sign in with your AT Protocol account (e.g. Bluesky) and the
setup code to become its owner. Then create a repo, or import one, from the home page.

| Command (in `instance/`)                                  | What it does                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `bun run setup`                                           | Change the settings, create missing queues (re-run any time)       |
| `bun run deploy`                                          | Deploy; the first deploy sets the setup code and OAuth key         |
| `bun run dev`                                             | Run it locally on http://127.0.0.1:8787                            |
| `bun run secrets`                                         | New setup code and OAuth key (before claiming only)                |
| `CF_API_TOKEN=… bun cli/mycelium.ts secrets cf-api-token` | Turn on push events (pushes start workflows, update pull requests) |

Push events are optional: without `CF_API_TOKEN` everything else works and workflows run by hand.
Non-interactive setup takes flags: `bun run setup --worker my-forge --title "My forge" --yes`.

After a deploy, Cloudflare rolls the new runner image out over a few minutes; workflow runs in that
window report "runner image is out of date" and can be re-run.

**Packaged install (not published yet):** `bun run pack` builds `@mycelium/instance` and
`create-mycelium`. Once published, `bun create mycelium my-mycelium` makes a deploy folder (your
own repo) with the same commands, `bun update @mycelium/instance && bun run deploy` updates it, and
its `.github/workflows/deploy.yml` deploys every push to `main` once the repo has a
`CLOUDFLARE_API_TOKEN` secret.

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
skills/mycelium/     agent skill: working with an instance over MCP and git
demo/fleet/          scripted agents working on an instance at once
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

Building the runner image needs only Docker (bun comes from its official image). Validate the
whole config without deploying:

```sh
cd instance && MYCELIUM_CONFIG=mycelium.config.example.json bunx cf deploy --dry-run
```

## License

MIT — see [`LICENSE`](LICENSE).
