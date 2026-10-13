import type { Refs } from "../shared/types.js";

/**
 * Branches and tags of a repo, over git smart HTTP. The Artifacts binding
 * has no ref listing, so we read the upload-pack ref advertisement:
 * `GET {remote}/info/refs?service=git-upload-pack` with a read token.
 */
export async function listRefs(
  remote: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Refs> {
  const url = `${remote.replace(/\/$/, "")}/info/refs?service=git-upload-pack`;
  const res = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}`, "Git-Protocol": "version=1" },
  });
  if (!res.ok) throw new Error(`listing refs failed: HTTP ${res.status}`);
  return parseRefAdvertisement(new Uint8Array(await res.arrayBuffer()));
}

/** Split a pkt-line stream into lines; flush packets (0000) become null. */
export function pktLines(data: Uint8Array): (string | null)[] {
  const decoder = new TextDecoder();
  const out: (string | null)[] = [];
  let i = 0;
  while (i + 4 <= data.length) {
    const len = parseInt(decoder.decode(data.subarray(i, i + 4)), 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length at byte ${i}`);
    if (len === 0 || len === 1 || len === 2) {
      // flush (0000), delim (0001), response-end (0002)
      out.push(null);
      i += 4;
      continue;
    }
    if (len < 4 || i + len > data.length) throw new Error(`truncated pkt-line at byte ${i}`);
    out.push(decoder.decode(data.subarray(i + 4, i + len)).replace(/\n$/, ""));
    i += len;
  }
  return out;
}

/**
 * Parse a v0/v1 ref advertisement:
 *
 *   # service=git-upload-pack\n  0000
 *   <sha> HEAD\0<capabilities incl. symref=HEAD:refs/heads/main>
 *   <sha> refs/heads/main
 *   <sha> refs/tags/v1   (and <sha> refs/tags/v1^{} for annotated tags)
 *   0000
 *
 * Annotated tags report the commit they point at (the peeled `^{}` sha).
 */
export function parseRefAdvertisement(data: Uint8Array): Refs {
  const refs: Refs = { branches: [], tags: [] };
  const tags = new Map<string, string>();
  for (const line of pktLines(data)) {
    if (line === null || line.startsWith("#") || line.startsWith("version ")) continue;
    const [refPart, caps] = line.split("\0", 2) as [string, string | undefined];
    if (caps) {
      const symref = /(?:^| )symref=HEAD:refs\/heads\/(\S+)/.exec(caps);
      if (symref) refs.head = symref[1];
    }
    const space = refPart.indexOf(" ");
    if (space < 0) continue;
    const sha = refPart.slice(0, space);
    const name = refPart.slice(space + 1).trim();
    if (/^0{40}$/.test(sha)) continue; // "capabilities^{}" in an empty repo
    if (name.startsWith("refs/heads/")) {
      refs.branches.push({ name: name.slice("refs/heads/".length), sha });
    } else if (name.startsWith("refs/tags/")) {
      const tag = name.slice("refs/tags/".length);
      if (tag.endsWith("^{}")) tags.set(tag.slice(0, -3), sha);
      else if (!tags.has(tag)) tags.set(tag, sha);
    }
  }
  refs.tags = [...tags].map(([name, sha]) => ({ name, sha }));
  return refs;
}
