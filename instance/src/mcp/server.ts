import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  CommitDetail,
  CommitList,
  DiffResult,
  GitCredentials,
  Pull,
  PullComment,
  PullList,
  Repo,
  RepoRefs,
  RunDetail,
  Run,
  TreeListing,
  BlobView,
  WorkflowList,
} from "../shared/types.js";
import type { RequestActor } from "../api/session.js";

/**
 * The MCP server at /mcp (#17), after Tempra's: stateless Streamable HTTP, a
 * fresh server and transport per request, JSON responses, a bearer API token.
 *
 * Every tool is a call to the instance's own REST API with the caller's
 * token (`McpContext.api`), so routes stay the one place that checks access,
 * validates input and attributes writes to the token's agent.
 */

/** One call to the instance's REST API, as the MCP caller. */
export type ApiCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export type McpContext = {
  actor: RequestActor;
  api: ApiCall;
  /** The instance's origin, for web links. */
  origin: string;
};

export const SERVER_NAME = "mycelium";

/** An error answer from the REST API. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export function instructions(actor: RequestActor): string {
  const who =
    actor.kind === "agent"
      ? `You act as the agent \`${actor.name}\`: pull requests, comments, runs and git credentials you create are attributed to it.`
      : `You act as the instance owner (${actor.name}).`;
  const scope =
    actor.scope === "read"
      ? " Your token is read-only: you can read everything and get read-only git credentials, but not write."
      : "";
  return `Mycelium is a private git forge: repositories (git on Cloudflare Artifacts), pull requests and workflow runs ("actions"). ${who}${scope}

How to work:
1. \`list_repos\`, then \`get_repo\` / \`list_refs\` / \`read_tree\` / \`read_file\` / \`list_commits\` to read code without cloning.
2. To change code, call \`git_credentials\` (scope write) and use plain git with the token in a header, exactly as the result shows: \`git -c http.extraHeader="Authorization: Bearer <token>" clone <remote>\`. Never put the token in the URL (it contains \`?expires=\`). Tokens are short-lived; ask again when one expires.
3. Work on a new branch, never on the default branch. Commit with a clear message${actor.kind === "agent" ? ` and an \`Agent: ${actor.name}\` trailer` : ""}, push the branch, then \`open_pull\` (head = your branch, base = the default branch).
4. Pull requests run \`on: pull_request\` workflows (\`.mycelium/workflows/*.yml\`). Watch them with \`get_pull\` (its checks) or \`list_runs\`/\`get_run\` (step logs); \`run_workflow\` runs one by hand. Fix failures by pushing to the same branch.
5. Discuss with \`comment_pull\`. Merge with \`merge_pull\` only when checks pass and you were asked to; pass \`head_sha\` from \`get_pull\` so a newer push is never merged unseen.`;
}

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));
const seg = (s: string) => encodeURIComponent(s);
/** A ref in a URL path: branch names keep their slashes. */
const refPath = (ref: string) => ref.split("/").map(seg).join("/");
const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** Cap long text (logs, patches) so a tool answer stays readable. */
export function tail(s: string, max: number): string {
  return s.length <= max ? s : `…[${s.length - max} earlier characters cut]\n${s.slice(-max)}`;
}

/** Turn thrown API errors into tool errors the model can read. */
function guarded<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (error) {
      if (error instanceof ApiError) {
        const extra =
          error.body && typeof error.body === "object" && "files" in error.body
            ? `\nConflicting files: ${JSON.stringify((error.body as { files: unknown }).files)}`
            : "";
        return { ...text(`Error ${error.status}: ${error.message}${extra}`), isError: true };
      }
      throw error;
    }
  };
}

/** git commands for one set of credentials (header auth; see the instructions). */
export function gitCommands(repo: string, c: GitCredentials, defaultBranch: string): string {
  const h = `git -c http.extraHeader="Authorization: Bearer ${c.token}"`;
  const lines = [
    `# Clone (or, in an existing clone, fetch with the same -c option)`,
    `${h} clone ${c.remote} ${repo}`,
    `cd ${repo}`,
  ];
  if (c.scope === "write") {
    lines.push(
      `git checkout -b my-branch          # never work on ${defaultBranch} directly`,
      `# …edit, git add, git commit…`,
      `${h} push -u origin my-branch`,
      `# An empty repository: push the first commit to ${defaultBranch} instead.`,
    );
  }
  return lines.join("\n");
}

export function buildServer(ctx: McpContext): McpServer {
  const { api, actor } = ctx;
  const canWrite = actor.scope === "write";
  const server = new McpServer(
    { name: SERVER_NAME, version: "0.1.0" },
    { instructions: instructions(actor), capabilities: { tools: {} } },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const repoArg = z.string().describe("Repository name, as list_repos shows it.");
  const refArg = z
    .string()
    .optional()
    .describe("Branch, tag or full commit sha. Defaults to the repository's default branch.");

  const defaultBranch = async (repo: string) =>
    (await api<Repo>("GET", `/api/repos/${seg(repo)}`)).defaultBranch;

  // ------------------------------------------------------------------ repositories and code

  server.registerTool(
    "list_repos",
    {
      title: "List repositories",
      description:
        "Every repository on this instance: name, description, visibility, default branch, git remote and last activity.",
      inputSchema: {},
      annotations: readOnly,
    },
    guarded(async () => json((await api<{ repos: Repo[] }>("GET", "/api/repos")).repos)),
  );

  server.registerTool(
    "get_repo",
    {
      title: "Get a repository",
      description:
        "One repository's details plus its branches and tags (with shas). Use before reading code or opening a pull request.",
      inputSchema: { repo: repoArg },
      annotations: readOnly,
    },
    guarded(async ({ repo }: { repo: string }) => {
      const [info, refs] = await Promise.all([
        api<Repo>("GET", `/api/repos/${seg(repo)}`),
        api<RepoRefs>("GET", `/api/repos/${seg(repo)}/refs`),
      ]);
      return json({ ...info, branches: refs.branches, tags: refs.tags, empty: refs.empty });
    }),
  );

  server.registerTool(
    "list_refs",
    {
      title: "List branches and tags",
      description:
        "Branches and tags with their commit shas, and which branch is the default. `commits: true` adds each branch's tip commit (message, author, date).",
      inputSchema: {
        repo: repoArg,
        commits: z.boolean().optional().describe("Include each branch's tip commit."),
      },
      annotations: readOnly,
    },
    guarded(async ({ repo, commits }: { repo: string; commits?: boolean }) =>
      json(
        await api<RepoRefs>("GET", `/api/repos/${seg(repo)}/refs${commits ? "?commits=1" : ""}`),
      ),
    ),
  );

  server.registerTool(
    "read_tree",
    {
      title: "List a directory",
      description:
        "The entries of a directory at a ref (directories first): name, path, type (tree, blob, symlink, exec, gitlink). `path` empty for the root.",
      inputSchema: {
        repo: repoArg,
        ref: refArg,
        path: z
          .string()
          .optional()
          .describe("Directory path in the repository; empty for the root."),
      },
      annotations: readOnly,
    },
    guarded(async ({ repo, ref, path }: { repo: string; ref?: string; path?: string }) => {
      const r = ref || (await defaultBranch(repo));
      const listing = await api<TreeListing>(
        "GET",
        `/api/repos/${seg(repo)}/tree/${refPath(r)}${qs({ path })}`,
      );
      return json({
        ref: listing.ref,
        commit: listing.commit.sha,
        path: listing.path,
        entries: listing.entries.map((e) => ({ path: e.path, type: e.type })),
      });
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Read a file",
      description:
        "A file's text at a ref. Binary files and files over 1 MB come back without text.",
      inputSchema: {
        repo: repoArg,
        path: z.string().describe("File path in the repository."),
        ref: refArg,
      },
      annotations: readOnly,
    },
    guarded(async ({ repo, path, ref }: { repo: string; path: string; ref?: string }) => {
      const r = ref || (await defaultBranch(repo));
      const blob = await api<BlobView>(
        "GET",
        `/api/repos/${seg(repo)}/blob/${refPath(r)}${qs({ path })}`,
      );
      if (blob.text === null) {
        return text(
          `${blob.path} (${blob.size} bytes) is ${blob.binary ? "binary" : "too large to show"}.`,
        );
      }
      return text(blob.text);
    }),
  );

  server.registerTool(
    "list_commits",
    {
      title: "List commits",
      description: "First-parent history of a ref, newest first: sha, title, author, date.",
      inputSchema: {
        repo: repoArg,
        ref: refArg,
        limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
        offset: z.number().int().min(0).optional(),
      },
      annotations: readOnly,
    },
    guarded(
      async ({
        repo,
        ref,
        limit,
        offset,
      }: {
        repo: string;
        ref?: string;
        limit?: number;
        offset?: number;
      }) => {
        const r = ref || (await defaultBranch(repo));
        const list = await api<CommitList>(
          "GET",
          `/api/repos/${seg(repo)}/commits/${refPath(r)}${qs({ limit: limit ?? 20, offset })}`,
        );
        return json({
          ref: list.ref,
          hasMore: list.hasMore,
          commits: list.commits.map((c) => ({
            sha: c.sha,
            title: c.title,
            author: c.author.name,
            date: c.authoredAt,
          })),
        });
      },
    ),
  );

  server.registerTool(
    "get_commit",
    {
      title: "Get a commit",
      description:
        "A commit's message, author and parents, and its changes against its first parent (per-file counts; patches when `patch` is true, capped).",
      inputSchema: {
        repo: repoArg,
        sha: z.string().describe("Full 40-character commit sha."),
        patch: z.boolean().optional().describe("Include unified diffs (capped at ~60 KB)."),
      },
      annotations: readOnly,
    },
    guarded(async ({ repo, sha, patch }: { repo: string; sha: string; patch?: boolean }) => {
      const d = await api<CommitDetail>("GET", `/api/repos/${seg(repo)}/commit/${seg(sha)}`);
      let budget = 60_000;
      const files = d.files.map((f) => {
        const base = {
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        };
        if (!patch || !f.hunks) return base;
        const body = f.hunks
          .map(
            (h) =>
              `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`,
          )
          .join("\n");
        if (body.length > budget) return { ...base, patch: "(cut: over the size budget)" };
        budget -= body.length;
        return { ...base, patch: body };
      });
      return json({
        commit: d.commit,
        parent: d.parent,
        additions: d.additions,
        deletions: d.deletions,
        totalFiles: d.totalFiles,
        files,
      });
    }),
  );

  server.registerTool(
    "git_credentials",
    {
      title: "Get git credentials",
      description:
        "A short-lived token for plain git against the repository's remote, with the exact commands to clone and push. The token goes in an http.extraHeader, never in the URL. Scope `write` to push (needs a write token).",
      inputSchema: {
        repo: repoArg,
        scope: z
          .enum(["read", "write"])
          .optional()
          .describe("Default write (read for read-only tokens)."),
        ttl: z
          .number()
          .int()
          .min(60)
          .max(7 * 86_400)
          .optional()
          .describe("Lifetime in seconds; default 3600."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guarded(
      async ({ repo, scope, ttl }: { repo: string; scope?: "read" | "write"; ttl?: number }) => {
        const want = scope ?? (canWrite ? "write" : "read");
        const [cred, branch] = await Promise.all([
          api<GitCredentials>("POST", `/api/repos/${seg(repo)}/git-credentials`, {
            scope: want,
            ttl,
          }),
          defaultBranch(repo),
        ]);
        return text(
          [
            `remote: ${cred.remote}`,
            `token: ${cred.token}`,
            `scope: ${cred.scope}`,
            `expires: ${cred.expiresAt}`,
            `default branch: ${branch}`,
            "",
            gitCommands(repo, cred, branch),
          ].join("\n"),
        );
      },
    ),
  );

  if (canWrite) {
    server.registerTool(
      "create_repo",
      {
        title: "Create a repository",
        description:
          "Create an empty repository (default branch main), or import one from a public https git URL. Private unless `visibility` is public.",
        inputSchema: {
          name: z
            .string()
            .describe("Letters, digits, '.', '-', '_'; up to 100; starts with a letter or digit."),
          description: z.string().optional(),
          visibility: z.enum(["private", "public"]).optional(),
          import_url: z.string().optional().describe("A public https git URL to import."),
        },
        annotations: writes,
      },
      guarded(
        async (a: {
          name: string;
          description?: string;
          visibility?: "private" | "public";
          import_url?: string;
        }) =>
          json(
            await api<Repo>("POST", "/api/repos", {
              name: a.name,
              description: a.description,
              visibility: a.visibility,
              importUrl: a.import_url,
            }),
          ),
      ),
    );
  }

  // ------------------------------------------------------------------ pull requests

  server.registerTool(
    "list_pulls",
    {
      title: "List pull requests",
      description: "Pull requests in a repository, newest first, with open and closed counts.",
      inputSchema: {
        repo: repoArg,
        state: z.enum(["open", "closed", "all"]).optional().describe("Default open."),
      },
      annotations: readOnly,
    },
    guarded(async ({ repo, state }: { repo: string; state?: string }) =>
      json(await api<PullList>("GET", `/api/repos/${seg(repo)}/pulls${qs({ state })}`)),
    ),
  );

  server.registerTool(
    "get_pull",
    {
      title: "Get a pull request",
      description:
        "A pull request with its comments, its checks (the latest run of each workflow for the head commit) and a diff summary: mergeable, conflicts, ahead/behind, commits and per-file counts (patches when `patch` is true, capped).",
      inputSchema: {
        repo: repoArg,
        number: z.number().int().min(1),
        patch: z.boolean().optional().describe("Include unified diffs (capped at ~60 KB)."),
      },
      annotations: readOnly,
    },
    guarded(async ({ repo, number, patch }: { repo: string; number: number; patch?: boolean }) => {
      const base = `/api/repos/${seg(repo)}/pulls/${number}`;
      const [pull, { comments }] = await Promise.all([
        api<Pull>("GET", base),
        api<{ comments: PullComment[] }>("GET", `${base}/comments`),
      ]);
      let diff: Record<string, unknown> | { error: string };
      try {
        const d = await api<DiffResult>("GET", `${base}/diff`);
        let budget = 60_000;
        diff = {
          mergeable: d.mergeable,
          conflicts: d.conflicts,
          ahead: d.ahead,
          behind: d.behind,
          baseSha: d.baseSha,
          headSha: d.headSha,
          truncated: d.truncated,
          commits: d.commits.map((c) => ({
            sha: c.sha,
            title: c.message.split("\n", 1)[0],
            author: c.author.name,
          })),
          files: d.files.map((f) => {
            const row = {
              path: f.path,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
            };
            if (!patch || !f.patch) return row;
            if (f.patch.length > budget) return { ...row, patch: "(cut: over the size budget)" };
            budget -= f.patch.length;
            return { ...row, patch: f.patch };
          }),
        };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        diff = { error: error.message };
      }
      const sha =
        pull.state === "open" && "headSha" in diff ? (diff.headSha as string) : pull.headSha;
      const checks = sha ? await latestRuns(api, repo, sha) : [];
      return json({ ...pull, checks, comments, diff });
    }),
  );

  if (canWrite) {
    server.registerTool(
      "open_pull",
      {
        title: "Open a pull request",
        description:
          "Open a pull request merging `head` into `base` (default: the default branch). Push the head branch first. Starts `on: pull_request` workflows.",
        inputSchema: {
          repo: repoArg,
          title: z.string(),
          head: z.string().describe("The branch with your changes."),
          base: z
            .string()
            .optional()
            .describe("The branch to merge into; default branch if omitted."),
          body: z.string().optional().describe("Markdown description."),
        },
        annotations: writes,
      },
      guarded(
        async (a: { repo: string; title: string; head: string; base?: string; body?: string }) => {
          const base = a.base || (await defaultBranch(a.repo));
          const pull = await api<Pull>("POST", `/api/repos/${seg(a.repo)}/pulls`, {
            title: a.title,
            head: a.head,
            base,
            body: a.body ?? "",
          });
          return json({ ...pull, url: `${ctx.origin}/${seg(a.repo)}/pulls/${pull.number}` });
        },
      ),
    );

    server.registerTool(
      "comment_pull",
      {
        title: "Comment on a pull request",
        description: "Add a markdown comment to a pull request's conversation.",
        inputSchema: { repo: repoArg, number: z.number().int().min(1), body: z.string() },
        annotations: writes,
      },
      guarded(async ({ repo, number, body }: { repo: string; number: number; body: string }) =>
        json(
          await api<PullComment>("POST", `/api/repos/${seg(repo)}/pulls/${number}/comments`, {
            body,
          }),
        ),
      ),
    );

    server.registerTool(
      "merge_pull",
      {
        title: "Merge a pull request",
        description:
          "Merge an open pull request into its base. `method`: merge (default), squash or rebase. Pass `head_sha` (from get_pull) to refuse if the branch moved since you looked. On a conflict nothing is pushed and the conflicting files are listed.",
        inputSchema: {
          repo: repoArg,
          number: z.number().int().min(1),
          method: z.enum(["merge", "squash", "rebase"]).optional(),
          message: z.string().optional().describe("Commit message; a default names the PR."),
          head_sha: z.string().optional(),
        },
        annotations: { ...writes, destructiveHint: true },
      },
      guarded(
        async (a: {
          repo: string;
          number: number;
          method?: string;
          message?: string;
          head_sha?: string;
        }) =>
          json(
            await api<Pull>("POST", `/api/repos/${seg(a.repo)}/pulls/${a.number}/merge`, {
              method: a.method,
              message: a.message,
              headSha: a.head_sha,
            }),
          ),
      ),
    );
  }

  // ------------------------------------------------------------------ workflows and runs

  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description:
        "Workflow files (.mycelium/workflows/*.yml) at a ref: name, events (push, pull_request, manual) and steps, plus files that fail to parse.",
      inputSchema: { repo: repoArg, ref: refArg },
      annotations: readOnly,
    },
    guarded(async ({ repo, ref }: { repo: string; ref?: string }) =>
      json(await api<WorkflowList>("GET", `/api/repos/${seg(repo)}/workflows${qs({ ref })}`)),
    ),
  );

  server.registerTool(
    "list_runs",
    {
      title: "List workflow runs",
      description:
        "Workflow runs, newest first: number, workflow, event, ref, sha, status and who started a manual run. Filter by commit `sha` to see a pull request's checks.",
      inputSchema: {
        repo: repoArg,
        sha: z.string().optional(),
        workflow: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 20."),
      },
      annotations: readOnly,
    },
    guarded(
      async ({
        repo,
        sha,
        workflow,
        limit,
      }: {
        repo: string;
        sha?: string;
        workflow?: string;
        limit?: number;
      }) =>
        json(
          (
            await api<{ runs: Run[] }>(
              "GET",
              `/api/repos/${seg(repo)}/runs${qs({ sha, workflow, limit: limit ?? 20 })}`,
            )
          ).runs,
        ),
    ),
  );

  if (canWrite) {
    server.registerTool(
      "run_workflow",
      {
        title: "Run a workflow",
        description:
          "Run a workflow by hand at a ref (default branch if omitted). Returns the queued run; poll get_run until its status is success, failure, error or cancelled.",
        inputSchema: {
          repo: repoArg,
          workflow: z.string().describe("The workflow's name, or its file name."),
          ref: refArg,
        },
        annotations: writes,
      },
      guarded(async ({ repo, workflow, ref }: { repo: string; workflow: string; ref?: string }) => {
        const run = await api<RunDetail>("POST", `/api/repos/${seg(repo)}/runs`, { workflow, ref });
        return json(summarizeRun(run, 0));
      }),
    );
  }

  server.registerTool(
    "get_run",
    {
      title: "Get a workflow run",
      description:
        "One run with its steps: status, exit code and log (the end of each log, capped by `log_chars`, default 4000 per step).",
      inputSchema: {
        repo: repoArg,
        number: z.number().int().min(1),
        log_chars: z.number().int().min(0).max(100_000).optional(),
      },
      annotations: readOnly,
    },
    guarded(
      async ({ repo, number, log_chars }: { repo: string; number: number; log_chars?: number }) =>
        json(
          summarizeRun(
            await api<RunDetail>("GET", `/api/repos/${seg(repo)}/runs/${number}`),
            log_chars ?? 4000,
          ),
        ),
    ),
  );

  return server;
}

function summarizeRun(run: RunDetail, logChars: number) {
  return {
    ...run,
    steps: run.steps.map((s) => ({
      name: s.name,
      command: s.command,
      status: s.status,
      exitCode: s.exitCode,
      ...(logChars > 0 && { log: tail(s.log, logChars) }),
    })),
  };
}

/** The latest run of each workflow for a commit: a pull request's checks. */
async function latestRuns(api: ApiCall, repo: string, sha: string) {
  const { runs } = await api<{ runs: Run[] }>("GET", `/api/repos/${seg(repo)}/runs${qs({ sha })}`);
  const seen = new Set<string>();
  return runs
    .filter((r) => !seen.has(r.workflow) && seen.add(r.workflow))
    .map((r) => ({ workflow: r.workflow, number: r.number, event: r.event, status: r.status }));
}

/** Serves one MCP request statelessly: a fresh server and transport per HTTP request. */
export async function handleMcp(req: Request, ctx: McpContext): Promise<Response> {
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
