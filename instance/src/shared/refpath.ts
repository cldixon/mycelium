/**
 * Splitting `<ref>/<path>` (as in `/:repo/tree/feature/x/src/app.ts`) into a
 * ref and a path. Branch and tag names may contain `/`, so the split can't be
 * positional. The rule (like GitHub's):
 *
 * 1. The longest prefix (on `/` boundaries) that is a known branch or tag wins.
 *    Branches beat tags of the same name.
 * 2. Otherwise a leading full 40-hex commit sha is the ref.
 * 3. Otherwise the first segment is the ref (it may not exist; the API says so).
 *
 * Pure: shared by the Worker and the web app.
 */

export type RefNames = { branches: { name: string }[]; tags: { name: string }[] };

export type RefPath = { ref: string; path: string; kind: "branch" | "tag" | "sha" | "unknown" };

const SHA = /^[0-9a-f]{40}$/i;

/** Normalise a repo path: no empty, "." or leading/trailing segments. Rejects "..". */
export function cleanPath(path: string): string | null {
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

export function splitRefPath(spec: string, refs: RefNames): RefPath {
  const parts = spec.split("/").filter((p) => p !== "");
  const branches = new Set(refs.branches.map((b) => b.name));
  const tags = new Set(refs.tags.map((t) => t.name));
  for (let n = parts.length; n > 0; n--) {
    const candidate = parts.slice(0, n).join("/");
    const kind = branches.has(candidate) ? "branch" : tags.has(candidate) ? "tag" : null;
    if (kind) return { ref: candidate, path: parts.slice(n).join("/"), kind };
  }
  const [first = "", ...rest] = parts;
  return { ref: first, path: rest.join("/"), kind: SHA.test(first) ? "sha" : "unknown" };
}

/** A ref for use in a URL path: each segment encoded, the `/`s kept. */
export function refUrl(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}
