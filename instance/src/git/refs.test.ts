import { describe, expect, test } from "bun:test";
import { listRefs, parseRefAdvertisement, pktLines } from "./refs.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

/** Encode lines as pkt-lines; null is a flush packet. */
function pkt(lines: (string | null)[]): Uint8Array {
  const out = lines
    .map((l) => (l === null ? "0000" : (l.length + 4).toString(16).padStart(4, "0") + l))
    .join("");
  return new TextEncoder().encode(out);
}

const ADVERTISEMENT = pkt([
  "# service=git-upload-pack\n",
  null,
  `${A} HEAD\0multi_ack thin-pack side-band ofs-delta symref=HEAD:refs/heads/main agent=git/2.45\n`,
  `${B} refs/heads/feature/x\n`,
  `${A} refs/heads/main\n`,
  `${C} refs/tags/v1.0\n`,
  `${D} refs/tags/v1.0^{}\n`,
  `${A} refs/tags/light\n`,
  `${B} refs/pull/1/head\n`,
  null,
]);

describe("parseRefAdvertisement", () => {
  test("reads HEAD, branches and tags (peeled)", () => {
    expect(parseRefAdvertisement(ADVERTISEMENT)).toEqual({
      head: "main",
      branches: [
        { name: "feature/x", sha: B },
        { name: "main", sha: A },
      ],
      tags: [
        { name: "v1.0", sha: D },
        { name: "light", sha: A },
      ],
    });
  });

  test("an empty repo has no refs", () => {
    const empty = pkt([
      "# service=git-upload-pack\n",
      null,
      `${"0".repeat(40)} capabilities^{}\0multi_ack agent=git/2.45\n`,
      null,
    ]);
    expect(parseRefAdvertisement(empty)).toEqual({ branches: [], tags: [] });
  });

  test("rejects truncated input", () => {
    expect(() => pktLines(new TextEncoder().encode("00ffabc"))).toThrow();
  });
});

describe("listRefs", () => {
  test("sends the token and parses the response", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = {
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
      };
      return new Response(ADVERTISEMENT as Uint8Array<ArrayBuffer>);
    }) as typeof fetch;
    const refs = await listRefs("https://git.example/ns/repo.git/", "tok", fetcher);
    expect(seen!).toEqual({
      url: "https://git.example/ns/repo.git/info/refs?service=git-upload-pack",
      auth: "Bearer tok",
    });
    expect(refs.head).toBe("main");
  });
});
