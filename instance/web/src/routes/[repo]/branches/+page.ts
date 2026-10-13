import { code, or404 } from "$lib/code";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => ({
  refs: await or404(code.refs(params.repo, { commits: true }, fetch)),
});
