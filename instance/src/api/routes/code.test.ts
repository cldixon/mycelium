import { expect, test } from "bun:test";
import { agentTrailers, aggregateContributors } from "./code.js";

const commit = (email: string, name: string, at: number, message = "x") =>
  ({
    hash: "0".repeat(40),
    treeHash: "0".repeat(40),
    message,
    author: { name, email },
    committer: { name, email },
    parents: [],
    authoredAt: at,
    committedAt: at,
  }) as ArtifactsCommitMetadata;

test("agentTrailers reads the trailer paragraph only", () => {
  expect(agentTrailers("Fix it\n\nAgent: claude-code\nCo-Authored-By: X <x@y>")).toEqual([
    "claude-code",
  ]);
  expect(agentTrailers("Agent: not a trailer")).toEqual([]);
});

test("aggregateContributors groups by email, newest name, most commits first", () => {
  const list = aggregateContributors([
    commit("a@x.dev", "Ann B", 300, "three\n\nAgent: bot-1"),
    commit("b@x.dev", "Bo", 250),
    commit("A@x.dev", "ann", 200),
    commit("a@x.dev", "ann", 100, "one\n\nAgent: bot-2"),
  ]);
  expect(list).toEqual([
    {
      name: "Ann B",
      email: "a@x.dev",
      commits: 3,
      firstAt: new Date(100_000).toISOString(),
      lastAt: new Date(300_000).toISOString(),
      agents: ["bot-1", "bot-2"],
    },
    {
      name: "Bo",
      email: "b@x.dev",
      commits: 1,
      firstAt: new Date(250_000).toISOString(),
      lastAt: new Date(250_000).toISOString(),
      agents: [],
    },
  ]);
});
