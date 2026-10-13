# @mycelium/instance

The [Mycelium](https://github.com/cldixon/mycelium) instance: a private, single-owner, GitHub-like
service (git repos, pull requests, workflows) that runs in your own Cloudflare account on
Artifacts, Workers, D1, Queues and Containers.

Start one with:

```bash
bun create mycelium my-mycelium
```

That makes a folder with your settings (`mycelium.config.json`) and this package as a dependency,
and walks you through setup. Inside it:

| Command                              | What it does                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `bun run setup`                      | Ask for your settings, write `mycelium.config.json`, create the two queues   |
| `bun run deploy`                     | Deploy. The first deploy also prints the setup code that claims the instance |
| `bun run dev`                        | Run the instance locally on http://127.0.0.1:8787                            |
| `bun run secrets`                    | Replace the setup code and OAuth key (before claiming only)                  |
| `bunx mycelium secrets cf-api-token` | Set `CF_API_TOKEN` (from the environment) to turn on push events             |

Deploying needs [Docker](https://docs.docker.com/get-docker/) running: it builds the runner
container image (git, node and bun, for merges and workflow steps).

To update, bump this package's version and deploy again. Migrations apply themselves.

The package ships a prebuilt Worker bundle, web UI and runner server; see the mycelium repo for
the source.
