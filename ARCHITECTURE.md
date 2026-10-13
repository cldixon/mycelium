# Mycelium architecture (v0: the instance)

Mycelium v0 is a **self-deployable, single-owner, private GitHub-like service** on Cloudflare,
modelled on igloo's instance (`cldixon/igloo`). One owner deploys one instance into their own
Cloudflare account. The agent-first features come later, on top of this base.

This file is the shared contract for everyone (people and agents) building v0. Change it in the
same PR as any code that departs from it.

## Platform facts this design relies on

Proven by the probes in `probes/` and written up in the Tempra library `cl_dixon/mycelium`
(`platform/*`):

- **Artifacts** stores git repos. Control plane (binding/REST) creates, imports, forks, deletes
  repos, mints repo-scoped tokens (`read`/`write`, TTL) and reads log, commits, trees, blobs and
  files. **There is no content-write API**: every write is a `git push`, from a client or from our
  runner container.
- The binding has **no ref listing**. List branches and tags with git smart HTTP:
  `GET {remote}/info/refs?service=git-upload-pack` with `Authorization: Bearer <read token>` and
  parse the pkt-line advertisement (helper: `instance/src/git/refs.ts`).
- **Push events**: per-repo event subscriptions (`artifacts.repo` source, event `pushed`) deliver
  full commit lists to a Queue within seconds. Creating a subscription needs the Cloudflare REST
  API (`CF_API_TOKEN` secret). Without it, the instance still works; push-triggered features
  degrade to manual (fail soft).
- `last_push_at` is always null; don't use it. Event commit lists are newest first.
- **Containers** run anything Linux; we run git + bun + node there. Cold start 17-30 s, warm jobs
  ~3 s, git ops milliseconds.
- `cf` CLI 1.0.0-beta.14, `cloudflare.config.ts` (see `platform/cf-cli` in Tempra).

## Repo layout (bun workspaces, isolated linker, like igloo)

```
package.json              workspaces: instance, instance/web, runner, packages/*
instance/                 @mycelium/instance: the Worker (Hono)
  config.ts               defineMycelium(): the ONLY place the cf config is built
  cloudflare.config.ts    calls defineMycelium with the source entrypoint
  wrangler.config.ts      assets dir + dev host/port (cf still bundles via wrangler)
  mycelium.config.example.json
  src/worker.ts           exports { fetch, queue } and the RunnerContainer Durable Object
  src/api/app.ts          Hono app; mounts routes; ASSETS fallback for the SPA
  src/api/routes/         auth.ts, repos.ts, code.ts, pulls.ts, actions.ts, settings.ts
  src/api/session.ts      cookie session + requireOwner / canRead guards
  src/auth/               owner + setup code, OAuth client, API tokens (from igloo)
  src/db/migrations.ts    ordered, append-only SQL migrations (self-applying)
  src/git/                artifacts.ts (binding helpers), refs.ts (smart HTTP), diff.ts (tree/line diff)
  src/runner.ts           client for the runner container (typed jobs)
  src/queue.ts            queue consumer: push events + job queue (don't edit; use the hooks below)
  src/hooks/push.ts       onPush(env, repo, push): extension point called once per new push
  src/jobs/workflow.ts    runWorkflow(env, runId): extension point for jobs-queue messages; enqueueRun
  src/shared/types.ts     API types shared with the web app (`$shared/types` there)
  src/shared/jobs.ts      runner Job/result types, shared with runner/ (type-only imports)
instance/web/             SvelteKit SPA (adapter-static, ssr=false), served by Workers Static Assets
runner/                   the container: Dockerfile + src/server.ts + src/jobs/*.ts
packages/platform/        copied from igloo: migrate, settings, web-sessions, oauth, identity, testing
packages/ui/              copied from igloo's @igloo/ui as @mycelium/ui: tokens + Svelte components
packages/create-mycelium/ scaffolder (later)
probes/                   throwaway exploration code; do not import from it
```

## One Worker

`mycelium-instance` (name from config) serves:

- `/api/*`, `/oauth/*`, `/health` → Hono. Everything else → the SPA (`ASSETS`,
  `notFoundHandling: "single-page-application"`, `runWorkerFirst` for the API paths).
- `queue()` consumes two queues: `<worker>-events` (Artifacts push events) and `<worker>-jobs`
  (our own async jobs: workflow runs).
- Durable Object `RunnerContainer` (container `<worker>-runner`, e.g. `mycelium-instance-runner`;
  container names are account-wide, so it follows the Worker name; image from `runner/Dockerfile`).

Secrets are not declared in the cf config (declared secrets are required); they are optional
fields on the hand-written `Bindings` type in `src/api/bindings.ts`.

Bindings: `DB` (D1), `ARTIFACTS` (namespace from config, default = worker name), `ASSETS`,
`JOBS` (queue producer), `RUNNER` (DO namespace). Secrets: `SETUP_CODE`, `OAUTH_SIGNING_KEY`
(both optional, generated into settings like igloo), `CF_API_TOKEN` (optional; enables push
subscriptions). Text vars: `INSTANCE_TITLE`.

## Auth (copied from igloo)

- AT Protocol OAuth is the only browser sign-in. A one-time setup code claims ownership; the owner
  DID is stored in `settings`.
- Session cookie `mycelium_session` (sha256 stored in `web_sessions`).
- API tokens (`myc_<hex>`, sha256 stored, always expiring) for scripts and agents:
  `Authorization: Bearer`. `requireOwner` accepts either.
- Repos have `visibility`: `private` (owner only, default) or `public` (read-only for anyone).
  Every read route goes through `canRead(c, repo)`; every write through `requireOwner`.
- Git access: the owner (or an agent with an API token) asks the instance for a short-lived
  Artifacts token: `POST /api/repos/:repo/git-credentials {scope, ttl}`, then uses plain git
  against the repo's Artifacts remote with `http.extraHeader=Authorization: Bearer <token>`.

## D1 schema (migration `0002_mycelium`; owned by the scaffold, extend only by new migrations)

```sql
repos(name TEXT PRIMARY KEY, description TEXT, visibility TEXT NOT NULL DEFAULT 'private',
      default_branch TEXT NOT NULL DEFAULT 'main', remote TEXT NOT NULL, source_url TEXT,
      subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
pushes(id INTEGER PRIMARY KEY, repo TEXT NOT NULL, ref TEXT NOT NULL, before TEXT, after TEXT,
       commits TEXT NOT NULL, pusher TEXT, at TEXT NOT NULL)                 -- from push events
counters(repo TEXT NOT NULL, kind TEXT NOT NULL, next INTEGER NOT NULL, PRIMARY KEY (repo, kind))
pulls(id INTEGER PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', head TEXT NOT NULL, base TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',            -- open | closed | merged
      author TEXT NOT NULL, head_sha TEXT, base_sha TEXT, merge_sha TEXT, merge_method TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, merged_at TEXT,
      UNIQUE (repo, number))
pull_comments(id INTEGER PRIMARY KEY, pull_id INTEGER NOT NULL, author TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL)
runs(id INTEGER PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, workflow TEXT NOT NULL,
     event TEXT NOT NULL,                             -- push | pull_request | manual
     ref TEXT NOT NULL, sha TEXT NOT NULL, pull_number INTEGER,
     status TEXT NOT NULL DEFAULT 'queued',           -- queued | running | success | failure | error | cancelled
     created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, UNIQUE (repo, number))
run_steps(run_id INTEGER NOT NULL, idx INTEGER NOT NULL, name TEXT NOT NULL, command TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending', exit_code INTEGER, log TEXT NOT NULL DEFAULT '',
     started_at TEXT, finished_at TEXT, PRIMARY KEY (run_id, idx))
```

Numbers (`pulls.number`, `runs.number`) come from `counters` per repo and kind, like GitHub.
Before `0001`, `@mycelium/platform` applies its own `platform_0001_oauth` and
`platform_0002_web_sessions`; `0001_platform` adds `settings` and `api_tokens`. `nextNumber(db,
repo, kind)` in `src/db/migrations.ts` claims the next number atomically.

## Runner container protocol

The Worker calls the container through `instance/src/runner.ts`:
`runJob(env, key, job)` → `POST http://runner/jobs` → JSON result. `key` picks the instance
(use `repo` so one repo's jobs share a warm container). The Worker mints tokens with the binding
before every job and passes `remotes: [{ name, url, token }]`; the container never sees an
account credential.

```ts
type Job =
  | { type: "diff"; remotes; repo: string; base: string; head: string }
      // → { mergeBase, ahead, behind, mergeable: boolean, files: FileDiff[], commits: CommitInfo[] }
  | { type: "merge"; remotes; repo: string; base: string; head: string;
      method: "merge" | "squash" | "rebase"; message: string; author: { name: string; email: string } }
      // → { status: "merged", sha } | { status: "conflict", files: string[], diff: string }
  | { type: "workflow"; remotes; repo: string; sha: string; steps: { name: string; run: string }[];
      timeoutSec: number }
      // → { status: "success" | "failure" | "error", steps: { exitCode, log, durationMs }[] }
```

Besides the three jobs above there is `{ type: "ping" }` → `{ ok, git, bun }` (health). Types live
in `instance/src/shared/jobs.ts`. On failure the runner answers `{ error }` with a 4xx/5xx and
`runJob` throws `RunnerError`.

`runner/src/jobs/<type>.ts` exports a handler; `runner/src/server.ts` dispatches by `type` from
a registry (`runner/src/jobs/index.ts`). Shared helper `runner/src/git.ts` sets up a scratch repo
with one remote per entry (per-remote `http.<url>.extraHeader`), with clones cached on disk by
repo while the container stays warm. Image: Debian `node:22` from `mirror.gcr.io` with git, plus
bun copied in (Docker Hub is rate-limited from our dev environment).

## Workflows ("Actions")

Files `.mycelium/workflows/*.yml` on the commit being run:

```yaml
name: test
on: [push, pull_request]      # also: manual (always allowed)
steps:
  - name: Install
    run: bun install
  - name: Test
    run: bun test
```

Push event (or PR open/update, or "Run" in the UI) → instance reads workflow files at that sha
through the binding → inserts `runs` + `run_steps` (status `queued`) → sends `{ runId }` to the
`JOBS` queue → queue consumer marks `running`, calls the runner `workflow` job, writes step
results and final status. The PR page shows the latest run per workflow for the PR's head sha.

## Diffs

- Commit view: the Worker diffs the commit's tree against its first parent's tree (recursive
  `readTree`, then line diff of changed blobs with the `diff` package). Cap at 300 files / 1 MB.
- PR view and mergeability: runner `diff` job (needs a merge base). Cache nothing in v0.

## Web app (instance/web)

SvelteKit 2 + Svelte 5 runes, adapter-static, `ssr = false`. Tailwind v4, Bits UI, Lucide
(`@lucide/svelte/icons/*`). Every page is composed from `@mycelium/ui` components; no page-level
colours. Pass 1 is structure only: white background, black text, system fonts, plain underlined
links, no accent colour.

Routes (repo names are a single path segment; the owner's handle is shown, not routed):

```
/                                  repositories (+ New repository: create empty or import a public git URL)
/signin                            sign in / claim
/settings                          instance settings: API tokens, owner, about
/:repo                             Code tab: default branch tree + README
/:repo/tree/:ref/[...path]         directory
/:repo/blob/:ref/[...path]         file
/:repo/commits/:ref                commit list
/:repo/commit/:sha                 commit + diff
/:repo/branches                    branches
/:repo/pulls                       pull requests (open / closed)
/:repo/pulls/new                   compare branches + open
/:repo/pulls/:number               conversation | commits | files changed; merge box
/:repo/actions                     runs list (+ workflows, Run button)
/:repo/actions/runs/:number        run detail with step logs
/:repo/contributors                contributors from the log
/:repo/settings                    description, visibility, default branch, git credentials, delete
```

Static routes win over `[repo]`, so repo names `signin`, `settings`, `api`, `oauth` and `health`
must be rejected at creation. Branch names may contain `/`; `tree/[ref]/[...path]` has to resolve
the longest matching ref (from `/refs`).

Repo header: `handle / repo` + visibility, then tabs: Code · Pull requests · Actions ·
Contributors · Settings (Settings only for the owner).

## API (JSON, under /api)

```
GET  /api/auth/status · POST /api/auth/login · POST /api/auth/logout · GET /oauth/callback
GET  /api/repos                              POST /api/repos {name, description?, visibility?, importUrl?, branch?}
GET  /api/repos/:repo                        PATCH /api/repos/:repo · DELETE /api/repos/:repo
POST /api/repos/:repo/git-credentials {scope, ttl}
GET  /api/repos/:repo/refs                   branches + tags with shas
GET  /api/repos/:repo/tree/:ref?path=        GET /api/repos/:repo/blob/:ref?path=   (raw: ?raw=1)
GET  /api/repos/:repo/commits/:ref?limit&offset   GET /api/repos/:repo/commit/:sha (with diff)
GET  /api/repos/:repo/contributors
GET  /api/repos/:repo/pulls?state=           POST /api/repos/:repo/pulls
GET  /api/repos/:repo/pulls/:n               PATCH (title, body, state)   GET .../diff
POST /api/repos/:repo/pulls/:n/merge {method}  POST .../comments {body}
GET  /api/repos/:repo/runs                   POST /api/repos/:repo/runs {workflow, ref}
GET  /api/repos/:repo/runs/:n                GET /api/repos/:repo/workflows
GET  /api/tokens · POST /api/tokens · DELETE /api/tokens/:id
```

## File ownership (parallel feature work)

The scaffold fixes these boundaries so features can be built in parallel without touching each
other's files. Shared files (`app.ts`, `queue.ts`, `session.ts`, `migrations.ts` except new
migrations appended at the end, `config.ts`, `packages/*`) change only when a feature truly needs
it, in a small separate commit.

| Feature  | Worker                                                                                   | Web (`instance/web/src`)                                                    | Runner                   |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------ |
| Repos    | `api/routes/repos.ts` (+ subscriptions, `git/artifacts.ts` additions)                    | `routes/+page.svelte`, `routes/[repo]/settings/`, `lib/repos.ts`            | -                        |
| Code     | `api/routes/code.ts`, `git/diff.ts`                                                      | `routes/[repo]/+page.svelte`, `tree/`, `blob/`, `commits/`, `commit/`, `branches/`, `contributors/` | -                        |
| Pulls    | `api/routes/pulls.ts`, `hooks/push.ts` (PR head updates)                                 | `routes/[repo]/pulls/`                                                      | `jobs/diff.ts`, `jobs/merge.ts` |
| Actions  | `api/routes/actions.ts`, `jobs/workflow.ts`, `hooks/push.ts` (push-triggered runs)       | `routes/[repo]/actions/`                                                    | `jobs/workflow.ts`       |
| Settings | `api/routes/settings.ts`                                                                 | `routes/settings/`                                                          | -                        |

Each feature adds its API types in its own section of `src/shared/types.ts` and its client calls
in its own `instance/web/src/lib/<feature>.ts` (using `request` from `$lib/api`). Runner job
handlers are registered with one line each in `runner/src/jobs/index.ts`. `hooks/push.ts` is
shared by Pulls and Actions: each should put its logic in its own module and add one call there.

## Conventions

See `CLAUDE.md`.
