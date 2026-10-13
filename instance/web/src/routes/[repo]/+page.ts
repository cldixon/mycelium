import { code, defaultRef, or404 } from "$lib/code";
import type { PageLoad } from "./$types";

/** Code tab: the default branch's root and README, or the empty-repo state. */
export const load: PageLoad = async ({ params, fetch }) => {
  const refs = await or404(code.refs(params.repo, {}, fetch));
  const ref = defaultRef(refs);
  if (!ref) return { refs, ref: null, listing: null, readme: null };
  const listing = await or404(code.tree(params.repo, ref, "", fetch));
  const readme = listing.readme
    ? await code.readme(params.repo, ref, "", fetch).catch(() => null)
    : null;
  return { refs, ref, listing, readme };
};
