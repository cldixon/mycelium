/** A did:plc or did:web identifier. */
export const DID_PATTERN = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]+)$/;

export function isDid(value: string): boolean {
  return DID_PATTERN.test(value);
}

/**
 * Minimal DID resolution: enough to find a repo's PDS and claimed handle.
 * Supports did:plc (through a PLC directory) and did:web.
 */

export type DidDocument = {
  id: string;
  alsoKnownAs?: string[];
  service?: { id: string; type: string; serviceEndpoint: string | Record<string, unknown> }[];
};

export type ResolvedIdentity = {
  did: string;
  /** The PDS base URL, e.g. https://morel.us-east.host.bsky.network */
  pds: string;
  /** The handle the DID document claims, unverified. */
  handle: string | null;
};

export type IdentityOptions = {
  fetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  plcDirectory?: string;
  timeoutMs?: number;
};

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export function didDocumentUrl(did: string, plcDirectory = "https://plc.directory"): string {
  if (did.startsWith("did:plc:")) return `${plcDirectory}/${did}`;
  if (did.startsWith("did:web:")) {
    // did:web encodes a port as %3A; paths (more colons) aren't used for atproto.
    const host = decodeURIComponent(did.slice("did:web:".length));
    return `https://${host}/.well-known/did.json`;
  }
  throw new IdentityError(`Unsupported DID method: ${did}`);
}

export function pdsFromDocument(doc: DidDocument): string | null {
  const service = doc.service?.find(
    (s) =>
      (s.id === "#atproto_pds" || s.id === `${doc.id}#atproto_pds`) &&
      s.type === "AtprotoPersonalDataServer",
  );
  const endpoint = service?.serviceEndpoint;
  if (typeof endpoint !== "string") return null;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : null;
  } catch {
    return null;
  }
}

export function handleFromDocument(doc: DidDocument): string | null {
  const aka = doc.alsoKnownAs?.find((a) => a.startsWith("at://"));
  return aka ? aka.slice("at://".length) : null;
}

export async function resolveDid(
  did: string,
  options: IdentityOptions = {},
): Promise<ResolvedIdentity> {
  if (!isDid(did)) throw new IdentityError(`Not a DID: ${did}`);
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(didDocumentUrl(did, options.plcDirectory), {
    headers: { accept: "application/did+ld+json, application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new IdentityError(`Could not resolve ${did}: HTTP ${res.status}`);
  const doc = (await res.json()) as DidDocument;
  if (doc.id !== did) throw new IdentityError(`DID document for ${did} names ${doc.id}`);
  const pds = pdsFromDocument(doc);
  if (!pds) throw new IdentityError(`${did} has no PDS endpoint`);
  return { did, pds, handle: handleFromDocument(doc) };
}
