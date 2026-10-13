import { error } from "@sveltejs/kit";
import { ApiError } from "$lib/api";
import { pulls } from "$lib/pulls";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, url, fetch, depends }) => {
  depends("mycelium:pull");
  const n = Number(params.number);
  if (!Number.isInteger(n) || n < 1) error(404, "No such pull request");
  const tab = url.searchParams.get("tab");
  try {
    const [pull, comments] = await Promise.all([
      pulls.get(params.repo, n, fetch),
      pulls.comments(params.repo, n, fetch),
    ]);
    return {
      pull,
      comments,
      tab: tab === "commits" || tab === "files" ? tab : ("conversation" as const),
    };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) error(404, "No such pull request");
    throw e;
  }
};
