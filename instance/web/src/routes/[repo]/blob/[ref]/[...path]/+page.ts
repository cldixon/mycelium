import { error } from "@sveltejs/kit";
import { code, or404, resolveRefPath } from "$lib/code";
import type { PageLoad } from "./$types";

/** A file. The URL tail is `ref/path`; refs may contain `/` (longest known ref wins). */
export const load: PageLoad = async ({ params, fetch }) => {
  const refs = await or404(code.refs(params.repo, {}, fetch));
  const { ref, path } = resolveRefPath(`${params.ref}/${params.path}`, refs);
  if (!path) error(404, "No file path");
  const blob = await or404(code.blob(params.repo, ref, path, fetch));
  return { refs, ref, blob };
};
