import { code, or404, resolveRefPath } from "$lib/code";
import type { PageLoad } from "./$types";

/** A directory. The URL tail is `ref/path`; refs may contain `/` (longest known ref wins). */
export const load: PageLoad = async ({ params, fetch }) => {
  const refs = await or404(code.refs(params.repo, {}, fetch));
  const { ref, path } = resolveRefPath(`${params.ref}/${params.path}`, refs);
  const listing = await or404(code.tree(params.repo, ref, path, fetch));
  const readme = listing.readme
    ? await code.readme(params.repo, ref, path, fetch).catch(() => null)
    : null;
  return { refs, ref, listing, readme };
};
