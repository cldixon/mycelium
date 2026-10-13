---
name: mycelium
description: Work in a Mycelium instance (a private git forge on Cloudflare) as an agent - read code, clone and push with short-lived git tokens, open pull requests, watch workflow runs, comment and merge. Use when a task names a Mycelium instance, its /mcp server, or a myc_ API token.
---

# Working with a Mycelium instance

Mycelium is a single-owner git forge: repositories (git on Cloudflare Artifacts), pull requests
and workflow runs. You reach it with an **API token** (`myc_…`) the owner made for you in
Settings. A token may name an agent (e.g. `claude-1`): everything you create is then shown as
that agent's, with a bot icon. A `read` token only reads.

## Connect

MCP (preferred): the server is `<instance>/mcp` (Streamable HTTP, stateless) with the header
`Authorization: Bearer <token>`. In Claude Code:

```sh
claude mcp add --transport http mycelium https://<instance>/mcp --header "Authorization: Bearer myc_…"
```

The same token works on the REST API (`/api/...`, see ARCHITECTURE.md "API").

## Tools

| Need                      | Tool                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Find repos, branches      | `list_repos`, `get_repo`, `list_refs`                                                                |
| Read code without cloning | `read_tree`, `read_file`, `list_commits`, `get_commit`                                               |
| Git access                | `git_credentials` (remote, token, expiry, exact commands)                                            |
| New repo                  | `create_repo` (empty, or import a public https URL)                                                  |
| Pull requests             | `list_pulls`, `get_pull` (comments, checks, diff summary), `open_pull`, `comment_pull`, `merge_pull` |
| Workflows                 | `list_workflows`, `run_workflow`, `list_runs`, `get_run` (step logs)                                 |

## The loop

1. `get_repo` to learn the default branch.
2. `git_credentials {repo, scope: "write"}`, then plain git with the token **in a header**:

   ```sh
   H="Authorization: Bearer $TOKEN"
   git -c http.extraHeader="$H" clone "$REMOTE" repo && cd repo
   git checkout -b my-change
   # edit, git add, git commit (add an "Agent: <your-agent-name>" trailer)
   git -c http.extraHeader="$H" push -u origin my-change
   ```

   Never put the token in the URL (`https://x:TOKEN@host/...`): Artifacts tokens contain
   `?expires=…`, which breaks URL credentials. Quote the header. Tokens last an hour by
   default (`ttl` up to 7 days); when git answers 401, ask for new credentials and pass the new
   header (the remote URL stays the same). In an empty repo, push the first commit to the
   default branch.

3. `open_pull {repo, title, head: "my-change"}` (base defaults to the default branch). This
   starts `on: pull_request` workflows (`.mycelium/workflows/*.yml`).
4. Watch checks: `get_pull` lists the latest run per workflow for the head commit; `get_run`
   shows each step's exit code and the end of its log. Fix failures by pushing to the same
   branch (new runs start when push events are on; otherwise `run_workflow` at the branch).
5. Reply in the conversation with `comment_pull`. Merge with `merge_pull` only when asked and
   checks pass; pass `head_sha` from `get_pull` so a newer push isn't merged unseen. Branches can
   require workflows (`get_pull` → `requiredChecks`): until they succeed on the head commit the
   merge is refused with 409. A conflict pushes nothing and lists the files: merge the base into
   your branch, push, retry.

## Notes

- Everything is owner-scoped: an agent token can do what the owner can (except manage tokens),
  so stay inside the repos and branches your task names.
- Errors come back as `Error <status>: <message>`; 404 means no such repo (or no access), 409 a
  conflict or an existing open PR for the same branches.
- Workflow file format: `name`, `on: [push, pull_request, manual]`, `steps: [{name, run}]`,
  optional `timeout-minutes`. Steps run in a Linux container with git, node and bun.
