import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLog, parseMergeTree, parseUnifiedDiff, unquotePath } from "./compare.ts";

describe("parseUnifiedDiff", () => {
  const text = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "+more",
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/old name.md b/new name.md",
    "similarity index 90%",
    "rename from old name.md",
    "rename to new name.md",
    "diff --git a/img.png b/img.png",
    "new file mode 100644",
    "index 0000000..5555555",
    "Binary files /dev/null and b/img.png differ",
  ].join("\n");

  test("statuses, paths and counts", () => {
    const { files, truncated } = parseUnifiedDiff(text);
    expect(truncated).toBe(false);
    expect(files.map((f) => [f.status, f.path, f.additions, f.deletions, f.binary])).toEqual([
      ["modified", "src/a.ts", 2, 1, false],
      ["added", "new.txt", 1, 0, false],
      ["deleted", "gone.txt", 0, 1, false],
      ["renamed", "new name.md", 0, 0, false],
      ["added", "img.png", 0, 0, true],
    ]);
    expect(files[3]!.oldPath).toBe("old name.md");
    expect(files[0]!.patch).toStartWith("diff --git a/src/a.ts");
    expect(files[4]!.patch).toBe("");
  });

  test("caps files and bytes", () => {
    expect(parseUnifiedDiff(text, { maxFiles: 2 })).toMatchObject({ truncated: true });
    expect(parseUnifiedDiff(text, { maxFiles: 2 }).files).toHaveLength(2);
    const small = parseUnifiedDiff(text, { maxBytes: 150 });
    expect(small.truncated).toBe(true);
    expect(small.files).toHaveLength(5);
    expect(small.files[1]!.patch).toBe("");
    expect(parseUnifiedDiff(text, { maxFileBytes: 10 }).files[0]!.patch).toBe("");
  });

  test("quoted paths", () => {
    expect(unquotePath('"a\\tb"')).toBe("a\tb");
    expect(unquotePath('"caf\\303\\251"')).toBe("café");
    expect(unquotePath("plain")).toBe("plain");
  });
});

test("parseLog and parseMergeTree", () => {
  const log = "abc\x00p1 p2\x00Ann\x00a@x\x002026-01-01T00:00:00Z\x00Subject\n\nBody\n\x1e\n";
  expect(parseLog(log)).toEqual([
    {
      sha: "abc",
      parents: ["p1", "p2"],
      author: { name: "Ann", email: "a@x", date: "2026-01-01T00:00:00Z" },
      message: "Subject\n\nBody",
    },
  ]);
  expect(parseMergeTree("tree1\nf\nf\ng\n\ninfo")).toEqual({
    tree: "tree1",
    conflicts: ["f", "g"],
  });
});

// End to end against a local bare repo: real git, no network.
describe("diff and merge jobs", () => {
  const dirs: string[] = [];
  let origin: string;
  let sh: typeof import("../git.ts").sh;
  let jobs: typeof import("./index.ts").handlers;
  const ident = {
    GIT_AUTHOR_NAME: "dev",
    GIT_AUTHOR_EMAIL: "dev@example.com",
    GIT_COMMITTER_NAME: "dev",
    GIT_COMMITTER_EMAIL: "dev@example.com",
  };
  const author = { name: "owner", email: "owner@example.com" };
  const remotes = () => [{ name: "origin", url: origin, token: "t" }];

  beforeAll(async () => {
    const work = await mkdtemp(join(tmpdir(), "pulls-work-"));
    const seed = await mkdtemp(join(tmpdir(), "pulls-seed-"));
    origin = await mkdtemp(join(tmpdir(), "pulls-origin-"));
    dirs.push(work, seed, origin);
    process.env.MYCELIUM_WORK_DIR = work;
    ({ sh } = await import("../git.ts"));
    ({ handlers: jobs } = await import("./index.ts"));
    await sh(origin, ["git", "init", "-q", "--bare", "-b", "main"]);
    const g = (...a: string[]) => sh(seed, ["git", ...a], ident);
    const commit = async (file: string, body: string, msg: string) => {
      await writeFile(join(seed, file), body);
      await g("add", file);
      await g("commit", "-q", "-m", msg);
    };
    await g("init", "-q", "-b", "main");
    await commit("a.txt", "one\ntwo\nthree\n", "initial");
    for (const b of ["clean", "clash"]) await g("branch", b);
    await commit("a.txt", "ONE\ntwo\nthree\n", "main edits line one");
    await g("checkout", "-q", "clean");
    await commit("b.txt", "new file\n", "add b");
    await commit("a.txt", "one\ntwo\nTHREE\n", "edit line three");
    await g("checkout", "-q", "clash");
    await commit("a.txt", "uno\ntwo\nthree\n", "conflicting edit");
    await g("push", "-q", origin, "main", "clean", "clash");
  });
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  const branchSha = async (b: string) => (await sh(origin, ["git", "rev-parse", b])).out;

  test("diff: clean and conflicting branches", async () => {
    const clean = await jobs.diff!({
      type: "diff",
      remotes: remotes(),
      repo: "demo",
      base: "main",
      head: "clean",
    });
    expect(clean).toMatchObject({ ahead: 2, behind: 1, mergeable: true, conflicts: [] });
    expect(clean.files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["b.txt", "added"],
    ]);
    expect(clean.commits.map((c) => c.message)).toEqual(["add b", "edit line three"]);
    expect(clean.headSha).toBe(await branchSha("clean"));

    const clash = await jobs.diff!({
      type: "diff",
      remotes: remotes(),
      repo: "demo",
      base: "main",
      head: "clash",
    });
    expect(clash).toMatchObject({ ahead: 1, behind: 1, mergeable: false, conflicts: ["a.txt"] });
  });

  test("merge: conflict pushes nothing", async () => {
    const before = await branchSha("main");
    const r = await jobs.merge!({
      type: "merge",
      remotes: remotes(),
      repo: "demo",
      base: "main",
      head: "clash",
      method: "merge",
      message: "Merge clash",
      author,
    });
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") {
      expect(r.files).toEqual(["a.txt"]);
      expect(r.diff).toContain("<<<<<<<");
    }
    expect(await branchSha("main")).toBe(before);
    for (const method of ["squash", "rebase"] as const) {
      const again = await jobs.merge!({ ...baseJob("clash"), method });
      expect(again.status).toBe("conflict");
    }
    expect(await branchSha("main")).toBe(before);
  });

  const baseJob = (head: string) => ({
    type: "merge" as const,
    remotes: remotes(),
    repo: "demo",
    base: "main",
    head,
    method: "merge" as const,
    message: `Merge ${head}`,
    author,
  });

  test("merge: refuses a head that moved", async () => {
    expect(jobs.merge!({ ...baseJob("clean"), headSha: "0".repeat(40) })).rejects.toThrow(/moved/);
  });

  test("merge, squash and rebase push base", async () => {
    const show = (fmt: string, rev = "main") =>
      sh(origin, ["git", "log", "-1", `--format=${fmt}`, rev]).then((r) => r.out);
    // squash: one commit, owner as author, with the message
    await sh(origin, ["git", "branch", "-f", "s", "clean"]);
    const s = await jobs.merge!({ ...baseJob("s"), method: "squash", message: "Squash (#1)" });
    expect(s.status).toBe("merged");
    expect(await show("%P %an %s")).toMatch(/^\w{40} owner Squash \(#1\)$/);

    // rebase: head's commits replayed on main, original authors kept, main fast-forwarded
    // (a fresh branch from main~1, so main is ahead of its fork point)
    const before = await branchSha("main");
    const seed = await mkdtemp(join(tmpdir(), "pulls-seed2-"));
    dirs.push(seed);
    await sh(seed, ["git", "clone", "-q", origin, "."], ident);
    await sh(seed, ["git", "checkout", "-q", "-b", "r", `${before}~1`], ident);
    await writeFile(join(seed, "c.txt"), "c\n");
    await sh(seed, ["git", "add", "c.txt"], ident);
    await sh(seed, ["git", "commit", "-q", "-m", "add c"], ident);
    await sh(seed, ["git", "push", "-q", "origin", "r"], ident);
    const r = await jobs.merge!({ ...baseJob("r"), method: "rebase" });
    expect(r.status).toBe("merged");
    expect(await show("%P %an %s")).toBe(`${before} dev add c`);
    expect(await show("%cn")).toBe("owner");

    // merge: a merge commit with two parents
    await sh(seed, ["git", "fetch", "-q"], ident);
    await sh(seed, ["git", "checkout", "-q", "-b", "m", "origin/main~1"], ident);
    await writeFile(join(seed, "d.txt"), "d\n");
    await sh(seed, ["git", "add", "d.txt"], ident);
    await sh(seed, ["git", "commit", "-q", "-m", "add d"], ident);
    await sh(seed, ["git", "push", "-q", "origin", "m"], ident);
    const m = await jobs.merge!({ ...baseJob("m"), message: "Merge pull request #3 from m" });
    expect(m.status).toBe("merged");
    expect((await show("%P")).split(" ")).toHaveLength(2);
    expect(await show("%an %s")).toBe("owner Merge pull request #3 from m");
    if (m.status === "merged") expect(m.sha).toBe(await branchSha("main"));
    // nothing left to merge
    expect(jobs.merge!({ ...baseJob("m") })).rejects.toThrow(/nothing/);
  });
});
