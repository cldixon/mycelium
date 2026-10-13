import { auth } from "$lib/api";
import type { LayoutLoad } from "./$types";

// A client-rendered SPA, served by Workers Static Assets.
export const ssr = false;
export const prerender = false;

export const load: LayoutLoad = async ({ fetch, depends }) => {
  depends("mycelium:session");
  const status = await auth.status(fetch).catch(() => null);
  return { status };
};
