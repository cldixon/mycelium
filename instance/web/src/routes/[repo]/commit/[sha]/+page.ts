import { code, or404 } from "$lib/code";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, fetch }) => ({
  detail: await or404(code.commit(params.repo, params.sha, fetch)),
});
