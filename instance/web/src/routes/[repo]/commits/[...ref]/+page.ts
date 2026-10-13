import { code, defaultRef, or404 } from "$lib/code";
import type { PageLoad } from "./$types";

const PAGE_SIZE = 30;

/** First-parent history of a ref (the whole URL tail; branch names may contain `/`). */
export const load: PageLoad = async ({ params, url, fetch }) => {
  const refs = await or404(code.refs(params.repo, {}, fetch));
  const ref = params.ref || defaultRef(refs) || refs.defaultBranch;
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const list = await or404(
    code.commits(params.repo, ref, PAGE_SIZE, (page - 1) * PAGE_SIZE, fetch),
  );
  return { refs, ref, page, list };
};
