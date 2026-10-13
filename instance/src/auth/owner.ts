import {
  generateToken,
  getSetting,
  initSetting,
  resolveDid,
  setSetting,
  type IdentityOptions,
} from "@mycelium/platform";

/**
 * Ownership of the instance.
 *
 * A fresh instance has no owner. The first sign-in must present the setup
 * code; that account's DID becomes the owner, and the code stops working.
 * After that only the owner can sign in.
 */

export const OWNER_DID = "owner_did";
const SETUP_CODE = "setup_code";

export async function getOwner(db: D1Database): Promise<string | null> {
  return getSetting(db, OWNER_DID);
}

/**
 * The setup code: the SETUP_CODE secret when set, otherwise one generated on
 * first use and written to the Worker's logs (visible only in the owner's
 * Cloudflare account).
 */
export async function getSetupCode(db: D1Database, secret: string | undefined): Promise<string> {
  if (secret) return secret;
  return initSetting(db, SETUP_CODE, generateToken(12));
}

export async function logSetupCodeIfUnclaimed(
  db: D1Database,
  secret: string | undefined,
): Promise<void> {
  if (secret || (await getOwner(db))) return;
  const code = await getSetupCode(db, secret);
  console.log(`mycelium: this instance is unclaimed. Setup code: ${code}`);
}

/** Constant-time comparison, so the code can't be guessed a character at a time. */
export async function checkSetupCode(
  db: D1Database,
  secret: string | undefined,
  attempt: string,
): Promise<boolean> {
  const expected = new TextEncoder().encode(await getSetupCode(db, secret));
  const given = new TextEncoder().encode(attempt.trim());
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
  return diff === 0;
}

/**
 * Make `did` the owner if there is none yet. Returns the owner afterwards,
 * which is someone else if another claim won a race.
 */
export async function claimOwnership(db: D1Database, did: string): Promise<string> {
  return initSetting(db, OWNER_DID, did);
}

const OWNER_HANDLE = "owner_handle";
const OWNER_HANDLE_CHECKED = "owner_handle_checked_at";
const HANDLE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The owner's handle, for display (`handle / repo`). Read from the owner's
 * DID document and cached for a day. Falls back to the cached value, or null,
 * if the DID can't be resolved.
 */
export async function getOwnerHandle(
  db: D1Database,
  options: IdentityOptions = {},
): Promise<string | null> {
  const did = await getOwner(db);
  if (!did) return null;
  const [cached, checkedAt] = await Promise.all([
    getSetting(db, OWNER_HANDLE),
    getSetting(db, OWNER_HANDLE_CHECKED),
  ]);
  if (cached && checkedAt && Date.now() - Date.parse(checkedAt) < HANDLE_TTL_MS) return cached;
  try {
    const { handle } = await resolveDid(did, { timeoutMs: 3000, ...options });
    await setSetting(db, OWNER_HANDLE_CHECKED, new Date().toISOString());
    if (handle) await setSetting(db, OWNER_HANDLE, handle);
    return handle ?? cached;
  } catch {
    return cached;
  }
}
