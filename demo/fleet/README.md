# Agent fleet

Scripted agents (no model behind them) working on one Mycelium repository **at the same time**,
the way a real agent does: the instance's MCP server (`/mcp`) for everything forge-side, plain
git for the code. Each agent clones with a short-lived token from `git_credentials`, branches,
makes a real change to [tinyroute](seed/) (a small router) with a test, runs `bun test`, commits
with an `Agent:` trailer, pushes, opens a pull request, comments, waits for the required `test`
check and squash-merges.

The **realistic** scenario (default, 5 agents) adds what happens on a real team:

- one agent runs only the test it wrote, so CI catches a regression it missed: it reads the failing
  run with `get_run`, fixes the code, runs the whole suite, pushes, waits for green, merges;
- two agents change the same lines: whoever merges second gets a conflict (or sees its PR become
  unmergeable), fetches `main`, re-applies its change there, force-pushes, waits, merges;
- one agent reviews another's pull request with a comment, and the author answers.

The **clean** scenario has every agent ship one independent change.

## Before the first run

1. **Agent tokens.** In the instance's **Settings → API tokens**, create one token per agent: name
   it, set **Agent** to its name (`agent-a`, `agent-b`, …) and **Scope** to `write`. Put them in a
   file next to where you run the fleet (it is gitignored, never commit it):

   ```json
   {
     "agent-a": "myc_…",
     "agent-b": "myc_…",
     "agent-c": "myc_…",
     "agent-d": "myc_…",
     "agent-e": "myc_…"
   }
   ```

   The key is the name the timeline prints; the instance shows the token's agent name.

2. **The repository.** The fleet needs `tinyroute` with a `test` workflow that runs on
   `pull_request`, required on `main`. Let the fleet set it up once:

   ```sh
   bun run fleet --url https://<instance> --tokens fleet.tokens.json --setup --plan
   ```

   `--setup` creates the repo (public) from `demo/fleet/seed` if it doesn't exist, adds
   `.mycelium/workflows/test.yml` if it's missing, requires `test` on `main` (REST
   `PUT /api/repos/:repo/checks/required`; MCP has no tool for it) and tags `main` as
   `fleet-base`. Without `--setup` the fleet changes no settings: it checks and tells you what's
   missing. `--plan` stops after printing who will do what.

   For runs to start on push, the instance needs its `CF_API_TOKEN` secret (push events). Without
   it the fleet still works: an agent starts a missing check with `run_workflow`.

## Run it

```sh
bun run fleet --url https://<instance> --tokens fleet.tokens.json
```

| Option                 | Default             | What it does                                                            |
| ---------------------- | ------------------- | ----------------------------------------------------------------------- |
| `--repo`               | `tinyroute`         | The repository to work on                                               |
| `--agents N`           | all tokens          | How many agents (the first N in the file)                               |
| `--scenario`           | `realistic`         | `realistic` or `clean`                                                  |
| `--pace ms`            | `1500`              | Pause between steps, so people can follow along                         |
| `--reset`              |                     | Close open PRs, delete fleet branches, move `main` back to `fleet-base` |
| `--setup`              |                     | Make the repo ready (see above)                                         |
| `--plan`               |                     | Print the plan and stop                                                 |
| `--owner-token myc_…`  | first agent's token | Token for the REST calls (required checks, closing PRs)                 |
| `--timeout s`          | `900`               | Give up after this long                                                 |
| `--keep`, `--no-color` |                     | Keep the clones (their path is printed); plain output                   |

Each run picks features `main` doesn't have yet (13 in [features.ts](features.ts): `redirect()`,
`readJson()`, query and cookie helpers, `withCors()`, route groups, `onError()`, `all()`, automatic
`OPTIONS`, `patch()`, `route()`, optional params, param constraints), so two or three runs work
back to back. Before recording, rehearse, then `--reset` to start from `fleet-base` again.

The output is a timeline and a summary:

```
[09:37:43] agent-b   check test failed (run #45, step "Test": 4 failing)
[09:37:43] agent-b     read the log: (fail) Router > named params are decoded
[09:37:46] agent-b   fixed it and ran the whole suite this time: 10 pass, 0 fail
[09:37:52] agent-d   merge refused: conflict ["src/index.ts"]
[09:37:53] agent-d   someone merged first: rebasing onto main (209e1b0) by re-applying the change

agent    feature          role     PR   result  time  check wait  CI fixes  rebases  merge retries
agent-b  optional-params  breaker  #12  merged  107s  80s         1         0        0
agent-d  options-method   pair     #14  merged  113s  81s         0         1        0
```

## What to open in the browser

Signed in as the owner, before starting the fleet:

- `/activity`: every push, pull request event and run across the instance, live;
- `/tinyroute/pulls`: pull requests appear, then move to Closed as they merge;
- `/tinyroute/actions`: runs queue, run and pass (or fail, for the breaker);
- a pull request page, e.g. the one that conflicts, to watch the comments, checks and merge box.

The first run after a deploy waits for the runner container to start (about a minute of "queued");
later runs take seconds.
