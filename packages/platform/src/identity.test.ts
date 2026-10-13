import { describe, expect, test } from "bun:test";
import { didDocumentUrl, IdentityError, resolveDid } from "./identity.ts";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";

function docFetch(doc: unknown, status = 200) {
  const calls: string[] = [];
  const fetch = async (input: Request | string | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(doc), { status });
  };
  return { fetch, calls };
}

const doc = {
  id: DID,
  alsoKnownAs: ["at://alice.example.com"],
  service: [
    {
      id: "#atproto_pds",
      type: "AtprotoPersonalDataServer",
      serviceEndpoint: "https://pds.example.com",
    },
  ],
};

describe("resolveDid", () => {
  test("finds the PDS and claimed handle", async () => {
    const { fetch, calls } = docFetch(doc);
    expect(await resolveDid(DID, { fetch })).toEqual({
      did: DID,
      pds: "https://pds.example.com",
      handle: "alice.example.com",
    });
    expect(calls).toEqual([`https://plc.directory/${DID}`]);
  });

  test("did:web documents come from the domain, with an encoded port", () => {
    expect(didDocumentUrl("did:web:someone.org")).toBe("https://someone.org/.well-known/did.json");
    expect(didDocumentUrl("did:web:localhost%3A2583")).toBe(
      "https://localhost:2583/.well-known/did.json",
    );
  });

  test("rejects a document for a different DID", async () => {
    const { fetch } = docFetch({ ...doc, id: "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz" });
    await expect(resolveDid(DID, { fetch })).rejects.toBeInstanceOf(IdentityError);
  });

  test("rejects a document without a PDS, or an http one", async () => {
    await expect(resolveDid(DID, docFetch({ ...doc, service: [] }))).rejects.toThrow("no PDS");
    const http = {
      ...doc,
      service: [{ ...doc.service[0], serviceEndpoint: "http://pds.example.com" }],
    };
    await expect(resolveDid(DID, docFetch(http))).rejects.toThrow("no PDS");
  });

  test("surfaces directory errors", async () => {
    await expect(resolveDid(DID, docFetch({}, 404))).rejects.toThrow("HTTP 404");
  });
});
