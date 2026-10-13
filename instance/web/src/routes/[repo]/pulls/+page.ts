import { pulls } from "$lib/pulls";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, url, fetch }) => {
  const state = url.searchParams.get("state") === "closed" ? "closed" : "open";
  return { state, list: await pulls.list(params.repo, state, fetch) };
};
