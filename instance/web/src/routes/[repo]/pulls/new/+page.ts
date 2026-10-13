import { pulls } from "$lib/pulls";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, url, fetch }) => {
  const { defaultBranch, branches } = await pulls.branches(params.repo, fetch);
  const names = branches.map((b) => b.name);
  const base = url.searchParams.get("base") ?? defaultBranch;
  const head = url.searchParams.get("head") ?? names.find((n) => n !== base) ?? "";
  return { branches: names, base, head };
};
