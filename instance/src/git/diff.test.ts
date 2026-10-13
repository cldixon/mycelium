import { describe, expect, test } from "bun:test";
import {
  diffCommitTrees,
  diffTrees,
  isBinary,
  lineDiff,
  type GitReader,
  type TreeItem,
} from "./diff.js";

/** An in-memory object store: content-addressed by a made-up hash. */
class Store implements GitReader {
  trees = new Map<string, TreeItem[]>();
  blobs = new Map<string, Uint8Array>();
  reads = 0;
  private n = 0;
  private id(): string {
    return (++this.n).toString(16).padStart(40, "0");
  }
  blob(content: string | Uint8Array): string {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    for (const [h, b] of this.blobs)
      if (b.length === bytes.length && b.every((x, i) => x === bytes[i])) return h;
    const h = this.id();
    this.blobs.set(h, bytes);
    return h;
  }
  /** A tree from a nested object: strings are files, objects are directories. */
  tree(spec: Record<string, string | Uint8Array | object>): string {
    const entries: TreeItem[] = Object.entries(spec).map(([name, v]) =>
      typeof v === "string" || v instanceof Uint8Array
        ? { name, mode: "100644", hash: this.blob(v), type: "blob" }
        : { name, mode: "40000", hash: this.tree(v as Record<string, string>), type: "tree" },
    );
    const key = JSON.stringify(entries);
    for (const [h, t] of this.trees) if (JSON.stringify(t) === key) return h;
    const h = this.id();
    this.trees.set(h, entries);
    return h;
  }
  async readTree(hash: string) {
    this.reads++;
    return this.trees.get(hash) ?? null;
  }
  async readBlob(hash: string) {
    const b = this.blobs.get(hash);
    return b ? new Blob([b as Uint8Array<ArrayBuffer>]) : null;
  }
}

describe("diffTrees", () => {
  test("finds added, deleted and modified files in nested directories", async () => {
    const s = new Store();
    const before = s.tree({
      "README.md": "hi\n",
      src: { "a.ts": "a\n", "b.ts": "b\n", deep: { "c.ts": "c\n" } },
      untouched: { "x.ts": "x\n" },
    });
    const after = s.tree({
      "README.md": "hi\n",
      src: { "a.ts": "a2\n", deep: { "c.ts": "c\n", "d.ts": "d\n" } },
      untouched: { "x.ts": "x\n" },
      "new.txt": "new\n",
    });
    const changes = await diffTrees(s, before, after);
    expect(changes.map((c) => [c.path, c.status])).toEqual([
      ["new.txt", "added"],
      ["src/a.ts", "modified"],
      ["src/b.ts", "deleted"],
      ["src/deep/d.ts", "added"],
    ]);
  });

  test("does not descend into unchanged subtrees", async () => {
    const s = new Store();
    const big = { a: { b: { c: { d: "deep\n" } } } };
    const before = s.tree({ big, f: "1\n" });
    const after = s.tree({ big, f: "2\n" });
    s.reads = 0;
    await diffTrees(s, before, after);
    expect(s.reads).toBe(2); // just the two roots
  });

  test("a root commit adds everything; file to directory is delete + add", async () => {
    const s = new Store();
    const one = s.tree({ x: "file\n", d: { e: "e\n" } });
    expect((await diffTrees(s, null, one)).map((c) => c.path)).toEqual(["d/e", "x"]);
    const two = s.tree({ x: { inner: "now a dir\n" }, d: { e: "e\n" } });
    expect((await diffTrees(s, one, two)).map((c) => [c.path, c.status])).toEqual([
      ["x", "deleted"],
      ["x/inner", "added"],
    ]);
  });
});

describe("lineDiff", () => {
  test("counts additions and deletions in unified hunks", () => {
    const d = lineDiff("one\ntwo\nthree\n", "one\n2\nthree\nfour\n")!;
    expect(d.additions).toBe(2);
    expect(d.deletions).toBe(1);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]!.lines).toEqual([" one", "-two", "+2", " three", "+four"]);
  });

  test("gives up past maxEditLength", () => {
    const a = Array.from({ length: 200 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 200 }, (_, i) => `b${i}`).join("\n");
    expect(lineDiff(a, b, 10)).toBeNull();
  });
});

describe("diffCommitTrees", () => {
  test("marks binary files and skips their hunks", async () => {
    const s = new Store();
    const before = s.tree({ "t.txt": "a\n" });
    const after = s.tree({ "t.txt": "b\n", "img.png": new Uint8Array([137, 80, 78, 71, 0, 1, 2]) });
    const d = await diffCommitTrees(s, before, after);
    expect(d.files.map((f) => [f.path, f.binary, f.hunks === null])).toEqual([
      ["img.png", true, true],
      ["t.txt", false, false],
    ]);
    expect([d.additions, d.deletions]).toEqual([1, 1]);
  });

  test("caps the file count and the byte budget", async () => {
    const s = new Store();
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}`] = `${"x".repeat(40)}${i}\n`;
    const d = await diffCommitTrees(s, null, s.tree(files), {
      maxFiles: 3,
      maxBytes: 100,
      maxFileBytes: 1000,
    });
    expect(d.totalFiles).toBe(5);
    expect(d.truncated).toBe(true);
    expect(d.files.map((f) => f.tooLarge)).toEqual([false, false, true]);
  });

  test("a single file over the per-file limit is too large", async () => {
    const s = new Store();
    const d = await diffCommitTrees(s, null, s.tree({ big: "y".repeat(2000) }), {
      maxFiles: 10,
      maxBytes: 100_000,
      maxFileBytes: 1000,
    });
    expect(d.files[0]).toMatchObject({ path: "big", tooLarge: true, hunks: null });
  });
});

test("isBinary looks for NUL bytes", () => {
  expect(isBinary(new TextEncoder().encode("plain text"))).toBe(false);
  expect(isBinary(new Uint8Array([65, 0, 66]))).toBe(true);
});
