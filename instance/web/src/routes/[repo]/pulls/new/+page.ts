import { code, defaultRef } from "$lib/code";
import type { PageLoad } from "./$types";

/** Branches from the Code feature's GET /refs; base defaults to the default branch. */
export const load: PageLoad = async ({ params, url, fetch }) => {
  const refs = await code.refs(params.repo, {}, fetch);
  const names = refs.branches.map((b) => b.name);
  const base = url.searchParams.get("base") ?? defaultRef(refs) ?? names[0] ?? "";
  const head = url.searchParams.get("head") ?? names.find((n) => n !== base) ?? "";
  return { branches: names, base, head };
};
