import { describe, expect, test } from "bun:test";
import {
  branchUpdate,
  defaultMergeMessage,
  isBranchName,
  isMergeMethod,
  ownerIdentity,
  pullPatch,
  statesFor,
} from "./logic.js";

describe("pull logic", () => {
  test("state filters", () => {
    expect(statesFor(undefined)).toEqual(["open"]);
    expect(statesFor("closed")).toEqual(["closed", "merged"]);
    expect(statesFor("all")).toHaveLength(3);
    expect(statesFor("bogus")).toBeNull();
  });

  test("merge methods and messages", () => {
    expect(isMergeMethod("squash")).toBe(true);
    expect(isMergeMethod("ff")).toBe(false);
    const pull = { number: 7, title: "Add routes", body: "Details\n", head: "feat/routes" };
    expect(defaultMergeMessage(pull, "merge")).toBe(
      "Merge pull request #7 from feat/routes\n\nAdd routes",
    );
    expect(defaultMergeMessage(pull, "squash")).toBe("Add routes (#7)\n\nDetails");
    expect(defaultMergeMessage({ ...pull, body: "" }, "squash")).toBe("Add routes (#7)");
  });

  test("owner identity", () => {
    expect(ownerIdentity("alice.bsky.social", "did:plc:x", "git.example")).toEqual({
      name: "alice.bsky.social",
      email: "alice.bsky.social@git.example",
    });
    expect(ownerIdentity(null, "did:plc:abc", "h")).toEqual({
      name: "did:plc:abc",
      email: "did-plc-abc@h",
    });
  });

  test("branch names", () => {
    for (const ok of ["main", "feat/x", "v1.2", "a_b-c"]) expect(isBranchName(ok)).toBe(true);
    for (const bad of ["", "-x", "a..b", "a b", "x.lock", "/a", "a/", "a~1", "a:b", 3]) {
      expect(isBranchName(bad)).toBe(false);
    }
  });

  test("branch updates from pushes", () => {
    const sha = "a".repeat(40);
    expect(branchUpdate({ ref: "refs/heads/feat/x", after: sha })).toEqual({
      branch: "feat/x",
      sha,
    });
    expect(branchUpdate({ ref: "refs/heads/x", after: "0".repeat(40) })).toEqual({
      branch: "x",
      sha: null,
    });
    expect(branchUpdate({ ref: "refs/heads/x", after: null })?.sha).toBeNull();
    expect(branchUpdate({ ref: "refs/tags/v1", after: sha })).toBeNull();
  });

  test("patch validation", () => {
    expect(pullPatch({ title: " New " }, { state: "open" })).toEqual({ title: "New" });
    expect(pullPatch({ title: "" }, { state: "open" })).toHaveProperty("error");
    expect(pullPatch({ state: "merged" }, { state: "open" })).toHaveProperty("error");
    expect(pullPatch({ state: "open" }, { state: "merged" })).toHaveProperty("error");
    expect(pullPatch({ state: "closed", body: "b" }, { state: "open" })).toEqual({
      state: "closed",
      body: "b",
    });
    expect(pullPatch(null, { state: "open" })).toHaveProperty("error");
  });
});
