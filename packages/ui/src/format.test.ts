import { expect, test } from "bun:test";
import {
  formatBytes,
  formatDateTime,
  personName,
  plural,
  shortDid,
  shortHash,
  timeAgo,
} from "./format.js";

test("people show as handles, else short DIDs", () => {
  const did = "did:plc:7k3bqzxw4ylmrz2qkdh5u69x";
  const owner = { did, handle: "alice.example.com" };
  expect(personName(did, owner)).toBe("@alice.example.com");
  expect(personName(did, { did, handle: null })).toBe("did:plc:7k3bqz…9x");
  expect(personName(did)).toBe("did:plc:7k3bqz…9x");
  expect(personName("did:plc:someoneelsexxxxxxxxxxxxx", owner)).toBe("did:plc:someon…xx");
  expect(personName("alice.example.com", owner)).toBe("@alice.example.com");
  expect(personName("@bob.bsky.social")).toBe("@bob.bsky.social");
  expect(personName("claude (agent)")).toBe("claude (agent)");
});

test("sizes read like an AutoIndex listing", () => {
  expect(formatBytes(512)).toBe("512B");
  expect(formatBytes(4198)).toBe("4.1K");
  expect(formatBytes(851443712)).toBe("812M");
  expect(formatBytes(2.1 * 2 ** 30)).toBe("2.1G");
});

test("short forms", () => {
  expect(shortHash("a81f3c" + "0".repeat(58))).toBe("a81f3c…");
  expect(shortDid("did:plc:7k3bqzxw4ylmrz2qkdh5u69x")).toBe("did:plc:7k3bqz…9x");
  expect(formatDateTime("2026-10-02T14:11:03Z")).toBe("2026-10-02 14:11");
  expect(plural(1, "file")).toBe("1 file");
  expect(plural(1200, "row")).toBe("1,200 rows");
});

test("timeAgo is compact, then a date", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  expect(timeAgo("2026-10-11T10:00:00Z", now)).toBe("2h");
  expect(timeAgo("2026-10-06T12:00:00Z", now)).toBe("5d");
  expect(timeAgo("2024-01-01T00:00:00Z", now)).toBe("2024-01-01");
});
