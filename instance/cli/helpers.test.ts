import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  copiesBunBinary,
  domainError,
  isAuthenticated,
  missingQueues,
  nextConfig,
  parseArgs,
  workerNameError,
} from "./helpers.ts";
import { runnerDockerfile } from "../config.ts";

describe("parseArgs", () => {
  test("value flags, switches, = form and pass-through", () => {
    expect(
      parseArgs(["--worker", "myc-x", "--yes", "--title=My forge", "--", "--dry-run"]),
    ).toEqual({
      flags: { worker: "myc-x", yes: true, title: "My forge" },
      positionals: ["--dry-run"],
    });
  });

  test("a switch followed by a positional stays a switch", () => {
    expect(parseArgs(["--no-build", "cf-api-token"])).toEqual({
      flags: { "no-build": true },
      positionals: ["cf-api-token"],
    });
  });

  test("an empty domain clears it", () => {
    expect(parseArgs(["--domain="]).flags.domain).toBe("");
  });
});

describe("validation", () => {
  test("worker names", () => {
    expect(workerNameError("myc-pack")).toBeNull();
    expect(workerNameError("My_Forge")).not.toBeNull();
    expect(workerNameError("-x")).not.toBeNull();
    expect(workerNameError("a".repeat(57))).not.toBeNull();
  });

  test("domains", () => {
    expect(domainError("")).toBeNull();
    expect(domainError("git.example.com")).toBeNull();
    expect(domainError("https://git.example.com")).not.toBeNull();
    expect(domainError("localhost")).not.toBeNull();
  });
});

test("setup keeps settings it doesn't ask about", () => {
  expect(
    nextConfig(
      { worker: "old", namespace: "repos", title: "old", domain: "git.example.com" },
      { worker: "new", title: "Forge", domain: "" },
    ),
  ).toEqual({ worker: "new", namespace: "repos", title: "Forge", domain: null });
});

test("missing queues", () => {
  const listing = [{ queue_name: "myc-x-events" }, { queue_name: "other" }];
  expect(missingQueues(listing, ["myc-x-events", "myc-x-jobs"])).toEqual(["myc-x-jobs"]);
  expect(missingQueues({ error: true }, ["a"])).toEqual(["a"]);
});

test("cf auth whoami", () => {
  expect(isAuthenticated('{"authenticated": true}')).toBe(true);
  expect(isAuthenticated('{"authenticated": false}')).toBe(false);
  expect(isAuthenticated("not json")).toBe(false);
});

test("runner Dockerfiles", () => {
  // In the repo, the runner image copies a bun binary from runner/.
  const dockerfile = runnerDockerfile();
  expect(dockerfile).toBe(join(import.meta.dirname, "..", "..", "runner", "Dockerfile"));
  expect(copiesBunBinary(readFileSync(dockerfile, "utf-8"))).toBe(true);
  // The published package takes bun from an image instead.
  const packaged = readFileSync(
    join(import.meta.dirname, "..", "package", "runner", "Dockerfile"),
    "utf-8",
  );
  expect(copiesBunBinary(packaged)).toBe(false);
});
