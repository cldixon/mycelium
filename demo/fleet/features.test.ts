import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirFiles, FEATURES, type Feature } from "./features";

const SEED = join(import.meta.dir, "seed");

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-features-"));
  cpSync(SEED, dir, { recursive: true });
  return dir;
}

function bunTest(dir: string, ...files: string[]): boolean {
  const p = Bun.spawnSync(["bun", "test", ...files.map((f) => `./${f}`)], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return p.exitCode === 0;
}

function withTree(fn: (dir: string) => void) {
  const dir = workspace();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("fleet features on the seed", () => {
  test("ids are unique", () => {
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
  });

  for (const f of FEATURES) {
    test(`${f.id} applies and passes every test`, () => {
      withTree((dir) => {
        f.apply(dirFiles(dir));
        expect(bunTest(dir)).toBe(true);
      });
    });
  }

  for (const f of FEATURES.filter((x) => x.buggy)) {
    test(`${f.id}: the buggy attempt passes its own test, fails the suite, and the fix heals it`, () => {
      withTree((dir) => {
        const files = dirFiles(dir);
        f.buggy!(files);
        expect(bunTest(dir, f.test)).toBe(true);
        expect(bunTest(dir)).toBe(false);
        f.fix!(files);
        expect(bunTest(dir)).toBe(true);
      });
    });
  }

  for (const order of [
    ["optional-params", "param-constraints"],
    ["param-constraints", "optional-params"],
  ]) {
    test(`${order.join(" then ")} stack`, () => {
      withTree((dir) => {
        for (const id of order) FEATURES.find((f) => f.id === id)!.apply(dirFiles(dir));
        expect(bunTest(dir)).toBe(true);
      });
    });
  }

  test("everything that can land together does", () => {
    // One of each region at a time: the clean features, then each pair member on top.
    const pairs = FEATURES.filter((x) => x.roles.includes("pair"));
    const others = FEATURES.filter((x) => !x.roles.includes("pair"));
    withTree((dir) => {
      const files = dirFiles(dir);
      for (const f of [...others, ...pairs] as Feature[]) f.apply(files);
      expect(bunTest(dir)).toBe(true);
    });
  });
});

describe("fleet features under git", () => {
  const git = (dir: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@x", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode;

  /** Branch each feature off the seed, then squash-merge them in order; each merge's exit code. */
  function mergeAll(ids: string[]): number[] {
    const features = ids.map((id) => FEATURES.find((f) => f.id === id)!);
    const dir = workspace();
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "seed");
      for (const f of features) {
        git(dir, "checkout", "-qb", f.id, "main");
        f.apply(dirFiles(dir));
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", f.id);
      }
      git(dir, "checkout", "-q", "main");
      return features.map((f) => {
        const code = git(dir, "merge", "--squash", f.id);
        if (code === 0) git(dir, "commit", "-qm", `merge ${f.id}`);
        else git(dir, "reset", "-q", "--hard");
        return code;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("features in different regions merge cleanly", () => {
    const ids = [
      "redirect-helper",
      "route-groups",
      "error-hook",
      "optional-params",
      "options-method",
    ];
    expect(mergeAll(ids)).toEqual([0, 0, 0, 0, 0]);
  });

  test("two shorthands conflict", () => {
    const [first, second] = mergeAll(["all-method", "options-method"]);
    expect(first).toBe(0);
    expect(second).not.toBe(0);
  });
});
