import { oauthClientFor, type OAuthClient } from "@mycelium/platform";

/**
 * What the instance asks the owner's PDS for: identity only. Mycelium writes
 * nothing to the owner's AT Protocol repo; sign-in just proves who they are.
 */
export const OAUTH_SCOPE = "atproto";

/** The OAuth client for this instance at `origin`. */
export function getOAuthClient(
  db: D1Database,
  origin: string,
  { title, signingKeySecret }: { title: string; signingKeySecret: string | undefined },
): Promise<OAuthClient> {
  return oauthClientFor(db, origin, {
    scope: OAUTH_SCOPE,
    clientName: title,
    signingKeySecret,
  });
}
