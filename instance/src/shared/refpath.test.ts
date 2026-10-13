import { describe, expect, test } from "bun:test";
import { cleanPath, refUrl, splitRefPath } from "./refpath.js";

const refs = {
  branches: [{ name: "main" }, { name: "feature" }, { name: "feature/x" }, { name: "v1" }],
  tags: [{ name: "v1" }, { name: "release/2026.10" }],
};

describe("splitRefPath", () => {
  test("a plain branch and a path", () => {
    expect(splitRefPath("main/src/app.ts", refs)).toEqual({
      ref: "main",
      path: "src/app.ts",
      kind: "branch",
    });
  });

  test("the longest matching branch wins", () => {
    expect(splitRefPath("feature/x/src", refs)).toEqual({
      ref: "feature/x",
      path: "src",
      kind: "branch",
    });
    expect(splitRefPath("feature/y/src", refs)).toEqual({
      ref: "feature",
      path: "y/src",
      kind: "branch",
    });
  });

  test("a ref alone has an empty path", () => {
    expect(splitRefPath("feature/x", refs).path).toBe("");
    expect(splitRefPath("feature/x/", refs).path).toBe("");
  });

  test("tags with slashes; branches beat tags of the same name", () => {
    expect(splitRefPath("release/2026.10/README.md", refs)).toMatchObject({
      ref: "release/2026.10",
      kind: "tag",
    });
    expect(splitRefPath("v1/a", refs).kind).toBe("branch");
  });

  test("a full sha, else the first segment", () => {
    const sha = "ab".repeat(20);
    expect(splitRefPath(`${sha}/docs`, refs)).toEqual({ ref: sha, path: "docs", kind: "sha" });
    expect(splitRefPath("nope/docs/a.md", refs)).toEqual({
      ref: "nope",
      path: "docs/a.md",
      kind: "unknown",
    });
  });
});

test("cleanPath normalises and rejects ..", () => {
  expect(cleanPath("/src//lib/./a.ts/")).toBe("src/lib/a.ts");
  expect(cleanPath("")).toBe("");
  expect(cleanPath("src/../etc")).toBeNull();
});

test("refUrl keeps slashes and encodes the rest", () => {
  expect(refUrl("feature/a b#1")).toBe("feature/a%20b%231");
});
