import { describe, expect, test } from "bun:test";
import { getRecord, listAllRecords, XrpcError } from "./xrpc.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("getRecord", () => {
  test("returns the record", async () => {
    let url = "";
    const record = { uri: "at://x/y/z", cid: "bafy", value: { a: 1 } };
    const result = await getRecord("https://pds.example.com", "did:plc:x", "a.b.c", "k", {
      fetch: async (input) => ((url = String(input)), json(record)),
    });
    expect(result).toEqual(record);
    expect(url).toBe(
      "https://pds.example.com/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Ax&collection=a.b.c&rkey=k",
    );
  });

  test.each(["RecordNotFound", "RepoNotFound", "RepoDeactivated", "RepoTakendown"])(
    "%s means the record is gone",
    async (error) => {
      const fetch = async () => json({ error, message: "nope" }, 400);
      expect(await getRecord("https://pds.example.com", "d", "c", "k", { fetch })).toBeNull();
    },
  );

  test("other failures throw, so the caller retries", async () => {
    const fetch = async () => json({ error: "InternalServerError" }, 500);
    await expect(
      getRecord("https://pds.example.com", "d", "c", "k", { fetch }),
    ).rejects.toBeInstanceOf(XrpcError);
  });
});

test("listAllRecords follows the cursor", async () => {
  const pages = [
    { records: [{ uri: "1", cid: "a", value: {} }], cursor: "c1" },
    { records: [{ uri: "2", cid: "b", value: {} }], cursor: "c2" },
    { records: [], cursor: "c3" },
  ];
  const cursors: (string | null)[] = [];
  const fetch = async (input: Request | string | URL) => {
    cursors.push(new URL(String(input)).searchParams.get("cursor"));
    return json(pages.shift());
  };
  const records = await listAllRecords("https://pds.example.com", "d", "c", { fetch });
  expect(records.map((r) => r.uri)).toEqual(["1", "2"]);
  expect(cursors).toEqual([null, "c1", "c2"]);
});
