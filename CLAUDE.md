# Mycelium — development notes

Read `ARCHITECTURE.md` first. It is the contract for v0 (the self-deployable instance). Where code
and that file disagree, fix one of them in the same PR.

## What this is

A private, single-owner GitHub-like service an owner deploys into their own Cloudflare account,
built on Cloudflare Artifacts (git repos), Workers, D1, Queues and Containers. It follows igloo's
instance model (`cldixon/igloo`): reuse its patterns and code wherever they fit. Agent-first
features come later, on top of this base.

## Tooling

- **Bun only** (workspaces, isolated linker). No npm/npx/yarn/pnpm and no other lockfiles.
- **`cf` CLI 1.0.0-beta.14, not wrangler.** Config lives in `cloudflare.config.ts` via
  `defineMycelium()` in `instance/config.ts`, the single place the cf config is built. Discover
  commands with `cf cli search "<generic task>"` (no names, IDs or tokens in queries).
- Types: `cf workers types` then `tsc --noEmit`; `svelte-check --fail-on-warnings` for Svelte.
- Format with Prettier (printWidth 100, prettier-plugin-svelte).
- Tests: `bun test`. D1/R2 tests use real local bindings via Miniflare 4 (`@mycelium/platform/testing`).
- `bun run check` at the root runs format check, typecheck, svelte-check and tests. Run it before
  every push.
- **D1 migrations apply themselves** (`packages/platform/src/migrate.ts`). Append only; never edit
  a migration that has been merged.
- No owner-specific values in the repo. `instance/mycelium.config.json` is gitignored;
  `MYCELIUM_*` env vars override it; `MYCELIUM_CONFIG` picks another file.
- Minimize what an owner has to do; optional things fail soft (e.g. no `CF_API_TOKEN` → no push
  subscriptions, manual workflow runs still work).

## UI

- One design system: `@mycelium/ui` (`packages/ui`), derived from igloo's `@igloo/ui`. Tailwind v4
  tokens as CSS variables in `mycelium.css`; Svelte 5 components on Bits UI; Lucide icons from
  `@lucide/svelte/icons/<name>`.
- Pass 1 is structure only: white background, black text, system fonts, plain underlined links,
  no accent colour, no shadows or rounded cards. Every colour/font/radius comes from a token.
  Pages compose components; they don't style themselves.
- Svelte 5 runes (`$props`, `$state`, `$derived`, snippets).

## Testing on Cloudflare (dev account)

The dev Cloudflare account also holds other projects (igloo, tempra, …). **Only create, change or
delete resources whose names start with `myc-`.** Never touch anything else.

To test a branch end to end, deploy your own throwaway instance named `myc-<something>`:

```sh
cp "$(which bun)" runner/bun                     # once; gitignored
docker info >/dev/null 2>&1 || (dockerd >/tmp/dockerd.log 2>&1 &)   # cf deploy builds the runner image
(cd /tmp && cf queues create --queue-name myc-x-events && cf queues create --queue-name myc-x-jobs)
bun run --cwd instance build                     # the SPA
cd instance && MYCELIUM_WORKER=myc-x MYCELIUM_TITLE="myc-x" cf deploy
bun run instance/scripts/test-owner.ts --url https://myc-x.cl-dixon.workers.dev --db myc-x
```

- Run `cf` commands that aren't about the instance (queues, d1 list…) from outside `instance/`,
  because cf evaluates the instance config in that folder.
- A fresh workers.dev deployment can answer 404 / error 1042 on some paths for a minute.
- `test-owner.ts` claims the instance with a fake owner and prints an API token (for
  `Authorization: Bearer`) and a session cookie (for a browser, e.g. Playwright with
  `/opt/pw-browsers`). Use `CF_API_TOKEN` from the environment as a secret only on test instances.
- Artifacts git remotes are reachable from this environment; push test code with a token from
  `POST /api/repos/:repo/git-credentials` (header form: `git -c http.extraHeader="Authorization: Bearer $T"`).

## Workflow

- Issues and planning: GitHub issues on `cldixon/mycelium`. Status and platform knowledge: the
  Tempra library `cl_dixon/mycelium`.
- Integration branch: `claude/fervent-bell-3egged`. Work on a feature branch, open a PR into it.
- **Conserve GitHub Actions minutes**: there is no CI on PRs; run `bun run check` locally and say
  in the PR body that it passed.
- Never commit tokens, `.env` files, `mycelium.config.json` or the bun binary in `runner/`.
- Artifacts quirks to remember: see `ARCHITECTURE.md` "Platform facts".
