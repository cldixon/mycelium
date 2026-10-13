/**
 * Unauthenticated XRPC reads against a PDS or the Bluesky AppView.
 * Authenticated writes go through an OAuth session's fetchHandler (oauth.ts).
 */

export type XrpcOptions = {
  fetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

export class XrpcError extends Error {
  constructor(
    readonly status: number,
    readonly error: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "XrpcError";
  }
}

export async function xrpcGet<T>(
  service: string,
  method: string,
  params: Record<string, string | number | undefined>,
  options: XrpcOptions = {},
): Promise<T> {
  const url = new URL(`/xrpc/${method}`, service);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const res = await (options.fetch ?? fetch)(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  return readXrpcResponse<T>(res, method);
}

export async function readXrpcResponse<T>(res: Response, method: string): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: { error?: string; message?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Not every failure has an XRPC error body.
  }
  throw new XrpcError(
    res.status,
    body.error,
    `${method} failed: HTTP ${res.status}${body.error ? ` ${body.error}` : ""}${body.message ? `: ${body.message}` : ""}`,
  );
}

export type RecordResponse = { uri: string; cid: string; value: unknown };

/** Errors that mean "this record no longer exists" rather than "try again later". */
const GONE = new Set([
  "RecordNotFound",
  "RepoNotFound",
  "RepoDeactivated",
  "RepoTakendown",
  "RepoSuspended",
]);

/** Fetch one record from a PDS. Returns null when the record (or its repo) is gone. */
export async function getRecord(
  pds: string,
  repo: string,
  collection: string,
  rkey: string,
  options?: XrpcOptions,
): Promise<RecordResponse | null> {
  try {
    return await xrpcGet<RecordResponse>(
      pds,
      "com.atproto.repo.getRecord",
      { repo, collection, rkey },
      options,
    );
  } catch (error) {
    if (
      error instanceof XrpcError &&
      (error.status === 404 || (error.error && GONE.has(error.error)))
    ) {
      return null;
    }
    throw error;
  }
}

/** Every record in one collection of a repo, following the cursor. */
export async function listAllRecords(
  pds: string,
  repo: string,
  collection: string,
  options?: XrpcOptions,
): Promise<RecordResponse[]> {
  const records: RecordResponse[] = [];
  let cursor: string | undefined;
  do {
    const page = await xrpcGet<{ records: RecordResponse[]; cursor?: string }>(
      pds,
      "com.atproto.repo.listRecords",
      { repo, collection, limit: 100, cursor },
      options,
    );
    records.push(...page.records);
    cursor = page.records.length > 0 ? page.cursor : undefined;
  } while (cursor);
  return records;
}

export type BskyProfile = {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
};

/** A public Bluesky profile, used for maintainer names and avatars. Null if the account has none. */
export async function getBskyProfile(
  actor: string,
  options: XrpcOptions & { appview?: string } = {},
): Promise<BskyProfile | null> {
  try {
    return await xrpcGet<BskyProfile>(
      options.appview ?? "https://public.api.bsky.app",
      "app.bsky.actor.getProfile",
      { actor },
      options,
    );
  } catch (error) {
    if (error instanceof XrpcError && error.status === 400) return null;
    throw error;
  }
}
