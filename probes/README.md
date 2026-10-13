# Probes

Throwaway code from exploring Cloudflare Artifacts, Workers and Containers before building Mycelium.
Findings are written up in the Tempra library `cl_dixon/mycelium`. Nothing here is production code.

| Probe | What it shows |
|---|---|
| `tinyroute/` | Small HTTP router used as the test codebase in Artifacts (`bun test`). |
| `ingest-worker/` | Worker `mycelium-ingest`: consumes Artifacts push events from a Queue, parses commit trailers into D1, reads files and trees through the Artifacts binding, forks a lineage and subscribes it to push events. |
| `git-runner/` | Worker `mycelium-git` + Container: `POST /blend` runs cherry-pick, merge or rebase across lineage repos with short-lived repo tokens, runs tests, pushes, returns a transcript (or the conflict). |

Deploy with the new `cf` CLI (`cf deploy --secrets-file <file>`). Configuration lives in `cloudflare.config.ts`.
Resource IDs in the configs (queue ID, D1 name, namespace `mycelium-dev`) point at the dev account.
