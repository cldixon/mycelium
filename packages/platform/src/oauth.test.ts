import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JoseKey } from "@atproto/jwk-jose";
import { migrate } from "./migrate.ts";
import {
  FallbackHandleResolver,
  OAUTH_MIGRATION,
  clientMetadata,
  createOAuthClient,
  d1Lock,
  d1SessionStore,
  d1StateStore,
  generateSigningJwk,
  signingKeyFromJwk,
} from "./oauth.ts";
import { createTestD1 } from "./testing.ts";

let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ db, dispose } = await createTestD1());
  await migrate(db, [OAUTH_MIGRATION]);
});
afterEach(() => dispose());

const SCOPE = "atproto repo:dev.example.thing";

describe("client metadata", () => {
  test("a deployed origin is a confidential client the library accepts", async () => {
    const metadata = clientMetadata("https://data.example.com", {
      scope: SCOPE,
      clientName: "mycelium",
    });
    expect(metadata.client_id).toBe("https://data.example.com/oauth/client-metadata.json");
    const signingKey = await signingKeyFromJwk(await generateSigningJwk("k1"));
    const client = createOAuthClient({ db, metadata, signingKey });
    expect(client.clientMetadata.token_endpoint_auth_method).toBe("private_key_jwt");
    // The published JWKS carries the public half only.
    expect(client.jwks.keys).toHaveLength(1);
    expect((client.jwks.keys[0] as { d?: string }).d).toBeUndefined();
    expect(client.jwks.keys[0]?.kid).toBe("k1");
  });

  test("localhost is a loopback client with no keys", () => {
    const metadata = clientMetadata("http://localhost:8787", {
      scope: SCOPE,
      clientName: "mycelium",
    });
    expect(metadata.redirect_uris).toEqual(["http://127.0.0.1:8787/oauth/callback"]);
    const client = createOAuthClient({ db, metadata });
    expect(client.clientMetadata.client_id).toStartWith("http://localhost?");
    expect(client.clientMetadata.token_endpoint_auth_method).toBe("none");
  });
});

describe("stores", () => {
  test("sessions round-trip, DPoP key included", async () => {
    const store = d1SessionStore(db);
    const dpopKey = await JoseKey.generate(["ES256"]);
    const session = {
      dpopKey,
      authMethod: { method: "none" as const },
      tokenSet: {
        iss: "https://pds",
        sub: "did:plc:x" as const,
        aud: "https://pds",
        scope: "atproto" as const,
        access_token: "t",
        token_type: "DPoP" as const,
      },
    };
    await store.set("did:plc:x", session as never);
    const back = await store.get("did:plc:x");
    expect(back?.tokenSet).toEqual(session.tokenSet);
    expect(back?.dpopKey.privateJwk).toEqual(dpopKey.privateJwk);
    await store.del("did:plc:x");
    expect(await store.get("did:plc:x")).toBeUndefined();
  });

  test("expired states are not returned", async () => {
    const store = d1StateStore(db);
    const state = {
      iss: "https://pds",
      dpopKey: await JoseKey.generate(["ES256"]),
      authMethod: { method: "none" as const },
      verifier: "v",
    };
    await store.set("s1", state as never);
    expect((await store.get("s1"))?.verifier).toBe("v");
    await db.prepare("UPDATE oauth_states SET expires_at = 0").run();
    expect(await store.get("s1")).toBeUndefined();
  });
});

describe("d1Lock", () => {
  test("runs holders of the same lock one at a time", async () => {
    const lock = d1Lock(db, { pollMs: 5 });
    let active = 0;
    let maxActive = 0;
    const work = () =>
      lock("refresh:did:plc:x", async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
      });
    await Promise.all([work(), work(), work()]);
    expect(maxActive).toBe(1);
  });

  test("an expired lease can be taken over", async () => {
    await db
      .prepare("INSERT INTO oauth_locks (name, token, expires_at) VALUES ('l', 'stale', 0)")
      .run();
    const lock = d1Lock(db, { waitMs: 200 });
    expect(await lock("l", () => "ran")).toBe("ran");
  });

  test("gives up after waiting", async () => {
    await db
      .prepare("INSERT INTO oauth_locks (name, token, expires_at) VALUES ('l', 'held', ?)")
      .bind(Date.now() + 60_000)
      .run();
    const lock = d1Lock(db, { waitMs: 50, pollMs: 10 });
    await expect(lock("l", () => "ran")).rejects.toThrow("Timed out");
  });
});

describe("FallbackHandleResolver", () => {
  const did = "did:plc:abcdefghijklmnopqrstuvwx" as const;
  const fails = { resolve: async () => Promise.reject(new Error("DoH unreachable")) };
  const finds = { resolve: async () => did };
  const none = { resolve: async () => null };

  test("uses the first resolver that finds the handle", async () => {
    expect(await new FallbackHandleResolver([fails, finds]).resolve("bsky.app")).toBe(did);
    expect(await new FallbackHandleResolver([none, finds]).resolve("bsky.app")).toBe(did);
  });

  test("returns null when none can", async () => {
    expect(await new FallbackHandleResolver([fails, none]).resolve("nobody.test")).toBeNull();
  });
});
