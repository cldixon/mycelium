import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestD1 } from "@mycelium/platform/testing";
import { setSetting } from "@mycelium/platform";
import { getDb } from "../db/migrations.js";
import { claimOwnership, getOwnerHandle } from "./owner.js";

const OWNER = "did:plc:ownerabcdefghijklmnopqrs";

function plc(handle: string | null, calls: string[]) {
  return async (input: Request | string | URL) => {
    calls.push(String(input));
    return Response.json({
      id: OWNER,
      alsoKnownAs: handle ? [`at://${handle}`] : [],
      service: [
        {
          id: "#atproto_pds",
          type: "AtprotoPersonalDataServer",
          serviceEndpoint: "https://pds.example.com",
        },
      ],
    });
  };
}

describe("getOwnerHandle", () => {
  let db: D1Database;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const test = await createTestD1();
    dispose = test.dispose;
    db = await getDb(test.db);
  });
  afterAll(() => dispose());

  test("is null before the instance is claimed", async () => {
    const calls: string[] = [];
    expect(await getOwnerHandle(db, { fetch: plc("alice.com", calls) })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("resolves the owner's handle once, then serves it from the cache", async () => {
    await claimOwnership(db, OWNER);
    const calls: string[] = [];
    expect(await getOwnerHandle(db, { fetch: plc("alice.com", calls) })).toBe("alice.com");
    expect(await getOwnerHandle(db, { fetch: plc("alice.com", calls) })).toBe("alice.com");
    expect(calls).toHaveLength(1);
  });

  test("refreshes a stale handle, and keeps the old one if resolving fails", async () => {
    await setSetting(db, "owner_handle_checked_at", new Date(0).toISOString());
    const calls: string[] = [];
    expect(await getOwnerHandle(db, { fetch: plc("alice.dev", calls) })).toBe("alice.dev");

    await setSetting(db, "owner_handle_checked_at", new Date(0).toISOString());
    const failing = async () => new Response("down", { status: 503 });
    expect(await getOwnerHandle(db, { fetch: failing })).toBe("alice.dev");
  });
});
