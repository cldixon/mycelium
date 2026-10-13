import { error } from "@sveltejs/kit";
import { ApiError, repos } from "$lib/api";
import type { LayoutLoad } from "./$types";

/** Every repo page has the repo (404 when it doesn't exist or isn't readable). */
export const load: LayoutLoad = async ({ params, fetch }) => {
  try {
    return { repo: await repos.get(params.repo, fetch) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) error(404, "No such repository");
    throw e;
  }
};
