import type {
  BlobView,
  CommitDetail,
  CommitList,
  ContributorList,
  Readme,
  RepoRefs,
  TreeListing,
} from "$shared/types";
import { refUrl, splitRefPath, type RefPath } from "$shared/refpath";
import { error } from "@sveltejs/kit";
import { ApiError, get, seg } from "$lib/api";

/**
 * Code browsing client: refs, tree, blob, readme, commits, commit, contributors.
 * API refs go in the URL path (slashes kept), file paths in `?path=`.
 */

const base = (repo: string) => `/api/repos/${seg(repo)}`;
const q = (path: string) => (path ? `?path=${encodeURIComponent(path)}` : "");

export const code = {
  refs: (repo: string, opts: { commits?: boolean } = {}, fetcher?: typeof fetch) =>
    get<RepoRefs>(`${base(repo)}/refs${opts.commits ? "?commits=1" : ""}`, fetcher),
  tree: (repo: string, ref: string, path = "", fetcher?: typeof fetch) =>
    get<TreeListing>(`${base(repo)}/tree/${refUrl(ref)}${q(path)}`, fetcher),
  blob: (repo: string, ref: string, path: string, fetcher?: typeof fetch) =>
    get<BlobView>(`${base(repo)}/blob/${refUrl(ref)}${q(path)}`, fetcher),
  readme: (repo: string, ref: string, path = "", fetcher?: typeof fetch) =>
    get<Readme>(`${base(repo)}/readme/${refUrl(ref)}${q(path)}`, fetcher),
  commits: (repo: string, ref: string, limit: number, offset: number, fetcher?: typeof fetch) =>
    get<CommitList>(
      `${base(repo)}/commits/${refUrl(ref)}?limit=${limit}&offset=${offset}`,
      fetcher,
    ),
  commit: (repo: string, sha: string, fetcher?: typeof fetch) =>
    get<CommitDetail>(`${base(repo)}/commit/${seg(sha)}`, fetcher),
  contributors: (repo: string, fetcher?: typeof fetch) =>
    get<ContributorList>(`${base(repo)}/contributors`, fetcher),
};

/** URL of raw file bytes. */
export const rawUrl = (repo: string, ref: string, path: string) =>
  `${base(repo)}/blob/${refUrl(ref)}?path=${encodeURIComponent(path)}&raw=1`;

const pathUrl = (path: string) => (path ? `/${path.split("/").map(seg).join("/")}` : "");

/** Web URLs inside a repo. */
export const links = {
  tree: (repo: string, ref: string, path = "") =>
    `/${seg(repo)}/tree/${refUrl(ref)}${pathUrl(path)}`,
  blob: (repo: string, ref: string, path: string) =>
    `/${seg(repo)}/blob/${refUrl(ref)}${pathUrl(path)}`,
  commits: (repo: string, ref: string) => `/${seg(repo)}/commits/${refUrl(ref)}`,
  commit: (repo: string, sha: string) => `/${seg(repo)}/commit/${seg(sha)}`,
};

/**
 * Split a `ref/path` web URL tail using the repo's refs (longest known
 * branch or tag wins; see shared/refpath.ts).
 */
export function resolveRefPath(spec: string, refs: RepoRefs): RefPath {
  return splitRefPath(spec, refs);
}

/** Breadcrumbs for a path: repo root, then each directory, then the leaf. */
export function pathCrumbs(repo: string, ref: string, path: string) {
  const parts = path ? path.split("/") : [];
  return [
    { label: repo, href: links.tree(repo, ref) },
    ...parts.map((label, i) => ({
      label,
      href: links.tree(repo, ref, parts.slice(0, i + 1).join("/")),
    })),
  ];
}

/** Directory of a path ("" at the root). */
export const dirname = (path: string) => path.split("/").slice(0, -1).join("/");

/** In a load function: an API 404/400 becomes the error page with its message. */
export async function or404<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) error(e.status, e.message);
    throw e;
  }
}

/** The branch to show by default: the repo's default branch if it exists, else HEAD's, else the first. */
export function defaultRef(refs: RepoRefs): string | null {
  const names = refs.branches.map((b) => b.name);
  if (names.includes(refs.defaultBranch)) return refs.defaultBranch;
  if (refs.head && names.includes(refs.head)) return refs.head;
  return names[0] ?? null;
}
