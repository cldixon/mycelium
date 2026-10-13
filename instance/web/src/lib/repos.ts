import type {
  CreateRepoInput,
  GitCredentials,
  GitScope,
  Refs,
  Repo,
  UpdateRepoInput,
} from "$shared/types";
import { get, request, seg } from "$lib/api";

/** Repos feature: create/import, update, delete, git credentials. */
export const repoAdmin = {
  create: (input: CreateRepoInput) => request<Repo>("POST", "/api/repos", input),
  update: (name: string, input: UpdateRepoInput) =>
    request<Repo>("PATCH", `/api/repos/${seg(name)}`, input),
  remove: (name: string) => request<{ deleted: string }>("DELETE", `/api/repos/${seg(name)}`),
  gitCredentials: (name: string, scope: GitScope, ttl?: number) =>
    request<GitCredentials>("POST", `/api/repos/${seg(name)}/git-credentials`, { scope, ttl }),
  /** Branches and tags (built by the Code feature). */
  refs: (name: string, fetcher?: typeof fetch) =>
    get<Refs>(`/api/repos/${seg(name)}/refs`, fetcher),
};

/**
 * Shell commands for plain git with a token. The token goes in a header:
 * the `https://x:TOKEN@host` URL form breaks because tokens contain `?expires=`.
 */
export function gitCommands(c: GitCredentials, repo: string, defaultBranch: string) {
  const header = `git -c http.extraHeader="Authorization: Bearer ${c.token}"`;
  return {
    clone: `${header} clone ${c.remote} ${repo}`,
    push: [
      `git remote add mycelium ${c.remote}`,
      `${header} push mycelium HEAD:${defaultBranch}`,
    ].join("\n"),
  };
}
