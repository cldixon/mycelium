/**
 * AT Protocol OAuth for Workers, backed by D1.
 *
 * Sessions, pending authorization state and the refresh lock all live in D1,
 * never in isolate memory: isolates come and go, and a DPoP nonce or refresh
 * token held in memory is lost (or reused) when they do.
 */
import { JoseKey } from "@atproto/jwk-jose";
import {
  OAuthClient,
  type InternalStateData,
  type Key,
  type OAuthClientMetadataInput,
  type RuntimeImplementation,
  type RuntimeLock,
  type Session,
  type SessionStore,
  type StateStore,
} from "@atproto/oauth-client";
import {
  AtprotoDohHandleResolver,
  XrpcHandleResolver,
  type HandleResolver,
} from "@atproto-labs/handle-resolver";
import type { Migration } from "./migrate.ts";
import { readXrpcResponse } from "./xrpc.ts";
import { initSetting } from "./settings.ts";

export { OAuthClient };
export type { OAuthSession } from "@atproto/oauth-client";

export const OAUTH_MIGRATION: Migration = {
  name: "platform_0001_oauth",
  statements: [
    `CREATE TABLE oauth_states (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE oauth_sessions (
      sub TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE oauth_locks (
      name TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
  ],
};

/** How long a sign-in may take between redirect and callback. */
const STATE_TTL_MS = 60 * 60 * 1000;

type Stored<T> = Omit<T, "dpopKey"> & { dpopJwk: unknown };

async function serialize<T extends { dpopKey: Key }>(value: T): Promise<string> {
  const { dpopKey, ...rest } = value;
  const dpopJwk = dpopKey.privateJwk;
  if (!dpopJwk) throw new Error("DPoP key is not exportable");
  return JSON.stringify({ ...rest, dpopJwk });
}

async function deserialize<T extends { dpopKey: Key }>(json: string): Promise<T> {
  const { dpopJwk, ...rest } = JSON.parse(json) as Stored<T>;
  const dpopKey = await JoseKey.fromJWK(dpopJwk as Parameters<typeof JoseKey.fromJWK>[0]);
  return { ...rest, dpopKey } as unknown as T;
}

export function d1StateStore(db: D1Database): StateStore {
  return {
    async set(key, value) {
      const now = Date.now();
      await db.batch([
        db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
        db
          .prepare("INSERT OR REPLACE INTO oauth_states (key, value, expires_at) VALUES (?, ?, ?)")
          .bind(key, await serialize(value), now + STATE_TTL_MS),
      ]);
    },
    async get(key) {
      const row = await db
        .prepare("SELECT value FROM oauth_states WHERE key = ? AND expires_at >= ?")
        .bind(key, Date.now())
        .first<{ value: string }>();
      return row ? deserialize<InternalStateData>(row.value) : undefined;
    },
    async del(key) {
      await db.prepare("DELETE FROM oauth_states WHERE key = ?").bind(key).run();
    },
  };
}

export function d1SessionStore(db: D1Database): SessionStore {
  return {
    async set(sub, value) {
      await db
        .prepare("INSERT OR REPLACE INTO oauth_sessions (sub, value, updated_at) VALUES (?, ?, ?)")
        .bind(sub, await serialize(value), new Date().toISOString())
        .run();
    },
    async get(sub) {
      const row = await db
        .prepare("SELECT value FROM oauth_sessions WHERE sub = ?")
        .bind(sub)
        .first<{ value: string }>();
      return row ? deserialize<Session>(row.value) : undefined;
    },
    async del(sub) {
      await db.prepare("DELETE FROM oauth_sessions WHERE sub = ?").bind(sub).run();
    },
  };
}

/**
 * A lease lock in D1. Token refreshes for one account must not run
 * concurrently: refresh tokens are single use, and two isolates refreshing at
 * once would get the session revoked.
 */
export function d1Lock(
  db: D1Database,
  { leaseMs = 30_000, waitMs = 15_000, pollMs = 100 } = {},
): RuntimeLock {
  return async (name, fn) => {
    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = Date.now();
      const result = await db
        .prepare(
          `INSERT INTO oauth_locks (name, token, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
           WHERE oauth_locks.expires_at < ?`,
        )
        .bind(name, token, now + leaseMs, now)
        .run();
      if (result.meta.changes > 0) break;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock "${name}"`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    try {
      return await fn();
    } finally {
      await db
        .prepare("DELETE FROM oauth_locks WHERE name = ? AND token = ?")
        .bind(name, token)
        .run();
    }
  };
}

export function workersRuntime(db: D1Database): RuntimeImplementation {
  return {
    createKey: (algs) => JoseKey.generate(algs),
    getRandomValues: (length) => crypto.getRandomValues(new Uint8Array(length)),
    digest: async (bytes, { name }) =>
      new Uint8Array(await crypto.subtle.digest(name.replace("sha", "SHA-"), bytes)),
    requestLock: d1Lock(db),
  };
}

/** Generate an ES256 client signing key, as a private JWK JSON string. */
export async function generateSigningJwk(kid = `mycelium-${Date.now()}`): Promise<string> {
  const key = await JoseKey.generate(["ES256"], kid);
  return JSON.stringify(key.privateJwk);
}

export async function signingKeyFromJwk(jwk: string): Promise<Key> {
  return JoseKey.fromJWK(JSON.parse(jwk));
}

export function isLoopback(origin: string): boolean {
  const { hostname } = new URL(origin);
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Client metadata for a Worker at `origin`.
 *
 * Deployed, it is a confidential client whose client ID is its own metadata
 * URL, so it needs no registration anywhere. On localhost it is an AT Protocol
 * loopback client (public, no keys), so sign-in works under `cf dev` too.
 */
export function clientMetadata(
  origin: string,
  { scope, clientName }: { scope: string; clientName: string },
): OAuthClientMetadataInput {
  if (isLoopback(origin)) {
    // Loopback clients must redirect to 127.0.0.1, not localhost.
    const redirect = `http://127.0.0.1:${new URL(origin).port || "80"}/oauth/callback`;
    const params = new URLSearchParams({ redirect_uri: redirect, scope });
    return {
      client_id: `http://localhost?${params}`,
      client_name: clientName,
      redirect_uris: [redirect],
      scope,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      dpop_bound_access_tokens: true,
    };
  }
  return {
    client_id: `${origin}/oauth/client-metadata.json`,
    client_name: clientName,
    client_uri: origin,
    redirect_uris: [`${origin}/oauth/callback`],
    scope,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    jwks_uri: `${origin}/oauth/jwks.json`,
    application_type: "web",
    dpop_bound_access_tokens: true,
  };
}

/**
 * Resolve handles the decentralized way first (DNS TXT over HTTPS, then the
 * handle's /.well-known/atproto-did), and fall back to asking a service's
 * com.atproto.identity.resolveHandle. The fallback matters on Workers: a
 * Worker can't always reach Cloudflare's own DNS-over-HTTPS endpoint, so the
 * DNS path alone fails for handles that are DNS-only, like bsky.app.
 */
export class FallbackHandleResolver implements HandleResolver {
  constructor(private readonly resolvers: HandleResolver[]) {}

  async resolve(handle: string, options?: Parameters<HandleResolver["resolve"]>[1]) {
    let lastError: unknown;
    for (const resolver of this.resolvers) {
      try {
        const did = await resolver.resolve(handle, options);
        if (did) return did;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) console.warn(`Couldn't resolve handle ${handle}`, lastError);
    return null;
  }
}

/**
 * The AT Protocol libraries build requests with `redirect: "error"` (refuse
 * redirects), which the Workers runtime's Request constructor rejects
 * outright. On Workers, make the constructor map it to "manual": a redirect
 * then comes back as a 3xx, which the libraries reject because it isn't OK,
 * so the effect is the same. Elsewhere this does nothing.
 */
export function installWorkersRequestShim(force = false): void {
  const g = globalThis as { Request: typeof Request; __myceliumRequestShim?: true };
  const onWorkers = globalThis.navigator?.userAgent === "Cloudflare-Workers";
  if ((!onWorkers && !force) || g.__myceliumRequestShim) return;
  const NativeRequest = g.Request;
  class WorkersRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.redirect === "error" ? { ...init, redirect: "manual" } : init);
    }
    // Requests the runtime makes (incoming ones) must still pass instanceof Request.
    static [Symbol.hasInstance](value: unknown) {
      return value instanceof NativeRequest;
    }
  }
  g.Request = WorkersRequest as typeof Request;
  g.__myceliumRequestShim = true;
}

installWorkersRequestShim();

export type FetchLike = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

export type CreateOAuthClientOptions = {
  db: D1Database;
  metadata: OAuthClientMetadataInput;
  /** The confidential client's signing key. Omit for loopback clients. */
  signingKey?: Key;
  fetch?: FetchLike;
  dohEndpoint?: string;
  /** Service for the resolveHandle fallback. */
  handleService?: string;
  plcDirectoryUrl?: string;
};

export function createOAuthClient(options: CreateOAuthClientOptions): OAuthClient {
  // Bound through a closure: Workers' fetch throws "Illegal invocation" when
  // called with another `this`, which is how the library calls it.
  const doFetch = (options.fetch ??
    ((input, init) => fetch(input, init))) as FetchLike as typeof fetch;
  return new OAuthClient({
    responseMode: "query",
    clientMetadata: options.metadata,
    keyset: options.signingKey ? [options.signingKey] : undefined,
    allowHttp: isLoopback(String(options.metadata.redirect_uris[0])),
    stateStore: d1StateStore(options.db),
    sessionStore: d1SessionStore(options.db),
    runtimeImplementation: workersRuntime(options.db),
    handleResolver: new FallbackHandleResolver([
      new AtprotoDohHandleResolver({
        dohEndpoint: options.dohEndpoint ?? "https://cloudflare-dns.com/dns-query",
        fetch: doFetch,
      }),
      new XrpcHandleResolver(options.handleService ?? "https://public.api.bsky.app", {
        fetch: doFetch,
      }),
    ]),
    plcDirectoryUrl: options.plcDirectoryUrl,
    fetch: doFetch,
  });
}

/** Call an XRPC procedure as the signed-in account. */
export async function xrpcProcedure<T>(
  fetchHandler: (path: string, init?: RequestInit) => Promise<Response>,
  method: string,
  input: unknown,
): Promise<T> {
  const res = await fetchHandler(`/xrpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readXrpcResponse<T>(res, method);
}

const clients = new Map<string, Promise<OAuthClient>>();

/**
 * The OAuth client for a Worker at `origin`, cached per isolate. Its signing
 * key is `signingKeySecret` when set, otherwise generated once and kept in the
 * `settings` table, so a deploy without secrets still works.
 */
export function oauthClientFor(
  db: D1Database,
  origin: string,
  options: { scope: string; clientName: string; signingKeySecret?: string },
): Promise<OAuthClient> {
  const cacheKey = `${origin} ${options.scope}`;
  let client = clients.get(cacheKey);
  if (!client) {
    client = (async () => {
      const metadata = clientMetadata(origin, options);
      const signingKey = isLoopback(origin)
        ? undefined
        : await signingKeyFromJwk(
            options.signingKeySecret ??
              (await initSetting(db, "oauth_signing_jwk", await generateSigningJwk())),
          );
      return createOAuthClient({ db, metadata, signingKey });
    })();
    client.catch(() => clients.delete(cacheKey));
    clients.set(cacheKey, client);
  }
  return client;
}
