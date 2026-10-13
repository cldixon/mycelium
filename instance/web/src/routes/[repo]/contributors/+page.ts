import { code, or404 } from "$lib/code";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => ({
  list: await or404(code.contributors(params.repo, fetch)),
});
