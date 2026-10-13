import { Hono, type Context } from "hono";
import { getRepoRow, isArtifactsError, mintToken } from "../../git/artifacts.js";
import { listRefs } from "../../git/refs.js";
import { diffCommitTrees, isBinary } from "../../git/diff.js";
import { cleanPath } from "../../shared/refpath.js";
import type {
  BlobView,
  BranchInfo,
  CommitDetail,
  CommitList,
  CommitSummary,
  Contributor,
  ContributorList,
  Readme,
  RepoRefs,
  RepoRow,
  TreeEntry,
  TreeEntryType,
  TreeListing,
} from "../../shared/types.js";
import { canRead, type AppEnv } from "../session.js";

/**
 * Code browsing: refs, tree, blob, readme, commits, commit (with diff),
 * contributors. Mounted at /api/repos/:repo. Owned by the Code feature.
 *
 * Refs: the ref is the rest of the URL path (`/tree/feature/x?path=src`), so
 * branch names containing `/` need no escaping, and the file path always goes
 * in `?path=`. A ref is a branch, a tag or a full commit sha; the web app
 * splits its own `ref/path` URLs with `splitRefPath` (longest known ref wins).
 */
export const codeRoute = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

/** Blobs larger than this come back without text (the raw view still works). */
const TEXT_LIMIT = 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const README = /^readme(\.(md|markdown|mdown|txt|rst))?$/i;

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

/** The repo row when the viewer may read it; otherwise a 404 (never a 403). */
async function readableRepo(c: Ctx): Promise<RepoRow> {
  const row = await getRepoRow(c.env, c.req.param("repo")!);
  if (!(await canRead(c, row))) throw new HttpError(404, "Not found");
  return row!;
}

/** Run `fn` with the Artifacts handle, mapping binding errors to HTTP ones. */
async function withArtifacts<T>(c: Ctx, name: string, fn: (r: ArtifactsRepo) => Promise<T>) {
  try {
    using repo = await c.env.ARTIFACTS.get(name);
    return await fn(repo);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (isArtifactsError(e, "NOT_FOUND")) throw new HttpError(404, "Repository storage not found");
    if (isArtifactsError(e, "INVALID_INPUT")) throw new HttpError(400, "Invalid ref or path");
    if (isArtifactsError(e, "MEMORY_LIMIT")) throw new HttpError(413, "Object too large to read");
    if (
      isArtifactsError(e, "CREATE_IN_PROGRESS") ||
      isArtifactsError(e, "IMPORT_IN_PROGRESS") ||
      isArtifactsError(e, "FORK_IN_PROGRESS")
    ) {
      throw new HttpError(409, "Repository is still being created");
    }
    throw e;
  }
}

codeRoute.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
  console.error("mycelium: code route error", e);
  return c.json({ error: "Internal error" }, 500);
});

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export function toCommitSummary(m: ArtifactsCommitMetadata): CommitSummary {
  return {
    sha: m.hash,
    treeSha: m.treeHash,
    message: m.message,
    title: m.message.split("\n", 1)[0] ?? "",
    author: m.author,
    committer: m.committer,
    authoredAt: iso(m.authoredAt),
    committedAt: iso(m.committedAt),
    parents: m.parents,
  };
}

/** The ref from the URL path: everything after `/tree/`, `/blob/`… */
function refParam(c: Ctx): string {
  const ref = c.req.param("ref") ?? "";
  if (!ref || ref.includes("..") || /[\s~^:?*[\\]/.test(ref)) {
    throw new HttpError(400, "Invalid ref");
  }
  return ref;
}

function pathQuery(c: Ctx): string {
  const path = cleanPath(c.req.query("path") ?? "");
  if (path === null) throw new HttpError(400, "Invalid path");
  return path;
}

/** The commit a ref (branch, tag or sha) points at. */
async function resolveCommit(repo: ArtifactsRepo, ref: string): Promise<ArtifactsCommitMetadata> {
  const commit = SHA.test(ref)
    ? await repo.readCommit(ref)
    : (await repo.log({ ref, limit: 1 }))[0];
  if (!commit) throw new HttpError(404, `No such ref: ${ref}`);
  return commit;
}

type Located = { type: TreeEntryType; hash: string; mode: string };

/** Walk `path` from a root tree. The root itself is a tree. */
async function locate(repo: ArtifactsRepo, root: string, path: string): Promise<Located | null> {
  let current: Located = { type: "tree", hash: root, mode: "40000" };
  if (!path) return current;
  for (const name of path.split("/")) {
    if (current.type !== "tree") return null;
    const entries = await repo.readTree(current.hash);
    const entry = entries?.find((e) => e.name === name);
    if (!entry) return null;
    current = { type: entry.type, hash: entry.hash, mode: entry.mode };
  }
  return current;
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  const dir = (e: TreeEntry) => (e.type === "tree" ? 0 : 1);
  return entries.sort((a, b) => dir(a) - dir(b) || a.name.localeCompare(b.name));
}

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  wasm: "application/wasm",
};

/** What raw bytes are served as. Text is always text/plain, so nothing runs. */
function contentTypeFor(name: string, binary: boolean): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (TYPES[ext]) return TYPES[ext];
  return binary ? "application/octet-stream" : "text/plain; charset=utf-8";
}

// --- Refs ----------------------------------------------------------------------

/**
 * Branches and tags, via smart HTTP with a short-lived read token (the
 * binding can't list refs). `?commits=1` adds each branch's tip commit.
 */
codeRoute.get("/refs", async (c) => {
  const row = await readableRepo(c);
  const { token } = await mintToken(c.env, row.name, "read", 60).catch((e) => {
    if (isArtifactsError(e, "NOT_FOUND")) throw new HttpError(404, "Repository storage not found");
    throw e;
  });
  const refs = await listRefs(row.remote, token);
  let branches: BranchInfo[] = refs.branches;
  if (c.req.query("commits") && branches.length > 0) {
    branches = await withArtifacts(c, row.name, (repo) =>
      Promise.all(
        refs.branches.slice(0, 100).map(async (b) => {
          const m = await repo.readCommit(b.sha).catch(() => null);
          return { ...b, commit: m ? toCommitSummary(m) : null };
        }),
      ),
    );
    branches.push(...refs.branches.slice(100));
  }
  return c.json<RepoRefs>({
    defaultBranch: row.default_branch,
    head: refs.head ?? null,
    branches,
    tags: refs.tags,
    empty: refs.branches.length === 0,
  });
});

// --- Tree, blob, readme -----------------------------------------------------

codeRoute.get("/tree/:ref{.+}", async (c) => {
  const row = await readableRepo(c);
  const ref = refParam(c);
  const path = pathQuery(c);
  return withArtifacts(c, row.name, async (repo) => {
    const commit = await resolveCommit(repo, ref);
    const dir = await locate(repo, commit.treeHash, path);
    if (!dir) throw new HttpError(404, `No such path: ${path}`);
    if (dir.type !== "tree") throw new HttpError(404, `Not a directory: ${path}`);
    const raw = (await repo.readTree(dir.hash)) ?? [];
    const entries = sortEntries(
      raw.map((e) => ({
        name: e.name,
        path: path ? `${path}/${e.name}` : e.name,
        type: e.type,
        mode: e.mode,
        sha: e.hash,
      })),
    );
    const readme = entries.find((e) => e.type !== "tree" && README.test(e.name))?.name ?? null;
    return c.json<TreeListing>({
      ref,
      commit: toCommitSummary(commit),
      path,
      entries,
      readme,
    });
  });
});

codeRoute.get("/blob/:ref{.+}", async (c) => {
  const row = await readableRepo(c);
  const ref = refParam(c);
  const path = pathQuery(c);
  if (!path) throw new HttpError(400, "A file path is required");
  const name = path.split("/").pop()!;
  return withArtifacts(c, row.name, async (repo) => {
    const commit = await resolveCommit(repo, ref);
    const entry = await locate(repo, commit.treeHash, path);
    if (!entry) throw new HttpError(404, `No such path: ${path}`);
    if (entry.type === "tree" || entry.type === "gitlink") {
      throw new HttpError(404, `Not a file: ${path}`);
    }
    const blob = await repo.readBlob(entry.hash);
    if (!blob) throw new HttpError(404, `No such path: ${path}`);
    const head = new Uint8Array(await blob.slice(0, 8000).arrayBuffer());
    const binary = isBinary(head);
    const contentType = contentTypeFor(name, binary);

    if (c.req.query("raw")) {
      return new Response(blob.stream(), {
        headers: {
          "content-type": contentType,
          "content-length": String(blob.size),
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
          "x-content-type-options": "nosniff",
          // Repo content runs nothing on this origin, even when opened directly.
          "content-security-policy":
            "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        },
      });
    }

    const tooLarge = blob.size > TEXT_LIMIT;
    const text = binary || tooLarge ? null : new TextDecoder().decode(await blob.arrayBuffer());
    return c.json<BlobView>({
      ref,
      path,
      name,
      size: blob.size,
      binary,
      tooLarge,
      text,
      contentType,
    });
  });
});

/** The README of a directory (default: the root), if it has one. */
codeRoute.get("/readme/:ref{.+}", async (c) => {
  const row = await readableRepo(c);
  const ref = refParam(c);
  const path = pathQuery(c);
  return withArtifacts(c, row.name, async (repo) => {
    const commit = await resolveCommit(repo, ref);
    const dir = await locate(repo, commit.treeHash, path);
    if (!dir || dir.type !== "tree") throw new HttpError(404, `No such directory: ${path}`);
    const entry = (await repo.readTree(dir.hash))?.find(
      (e) => e.type !== "tree" && e.type !== "gitlink" && README.test(e.name),
    );
    if (!entry) throw new HttpError(404, "No README");
    const blob = await repo.readBlob(entry.hash);
    if (!blob || blob.size > TEXT_LIMIT) throw new HttpError(404, "No README");
    return c.json<Readme>({
      path: path ? `${path}/${entry.name}` : entry.name,
      name: entry.name,
      text: new TextDecoder().decode(await blob.arrayBuffer()),
      markdown: /\.(md|markdown|mdown)$/i.test(entry.name),
    });
  });
});

// --- History ----------------------------------------------------------------

codeRoute.get("/commits/:ref{.+}", async (c) => {
  const row = await readableRepo(c);
  const ref = refParam(c);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 100);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  return withArtifacts(c, row.name, async (repo) => {
    const log = await repo.log({ ref, limit: limit + 1, offset });
    if (log.length === 0 && offset === 0) throw new HttpError(404, `No such ref: ${ref}`);
    return c.json<CommitList>({
      ref,
      commits: log.slice(0, limit).map(toCommitSummary),
      limit,
      offset,
      hasMore: log.length > limit,
    });
  });
});

/** One commit and its diff against its first parent (300 files / 1 MB cap). */
codeRoute.get("/commit/:sha", async (c) => {
  const row = await readableRepo(c);
  const sha = c.req.param("sha").toLowerCase();
  if (!SHA.test(sha)) throw new HttpError(400, "Expected a full 40-character commit sha");
  return withArtifacts(c, row.name, async (repo) => {
    const commit = await repo.readCommit(sha);
    if (!commit) throw new HttpError(404, `No such commit: ${sha}`);
    const parent = commit.parents[0] ?? null;
    const parentTree = parent ? ((await repo.readCommit(parent))?.treeHash ?? null) : null;
    const diff = await diffCommitTrees(repo, parentTree, commit.treeHash);
    return c.json<CommitDetail>({ commit: toCommitSummary(commit), parent, ...diff });
  });
});

/** Values of `Agent:` trailers in the message's last paragraph. */
export function agentTrailers(message: string): string[] {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1]! : "";
  const out: string[] = [];
  for (const line of last.split("\n")) {
    const m = /^Agent:\s*(\S.*?)\s*$/i.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Contributors, by author email, over up to 1000 commits of the default branch. */
export function aggregateContributors(log: ArtifactsCommitMetadata[]): Contributor[] {
  const byEmail = new Map<string, Contributor & { agentSet: Set<string>; latest: number }>();
  for (const m of log) {
    const key = m.author.email.toLowerCase() || m.author.name;
    const at = iso(m.authoredAt);
    let entry = byEmail.get(key);
    if (!entry) {
      entry = {
        name: m.author.name,
        email: m.author.email,
        commits: 0,
        firstAt: at,
        lastAt: at,
        agents: [],
        agentSet: new Set(),
        latest: m.authoredAt,
      };
      byEmail.set(key, entry);
    }
    entry.commits++;
    if (at < entry.firstAt) entry.firstAt = at;
    if (at > entry.lastAt) entry.lastAt = at;
    if (m.authoredAt > entry.latest) {
      entry.latest = m.authoredAt;
      entry.name = m.author.name; // the most recent spelling
    }
    for (const a of agentTrailers(m.message)) entry.agentSet.add(a);
  }
  return [...byEmail.values()]
    .map(({ agentSet, latest: _latest, ...c }) => ({ ...c, agents: [...agentSet].sort() }))
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

codeRoute.get("/contributors", async (c) => {
  const row = await readableRepo(c);
  const ref = row.default_branch;
  return withArtifacts(c, row.name, async (repo) => {
    const log = await repo.log({ ref, limit: 1000 });
    return c.json<ContributorList>({
      ref,
      scanned: log.length,
      truncated: log.length >= 1000,
      contributors: aggregateContributors(log),
    });
  });
});
