// Development only: claim a deployed test instance without AT Protocol sign-in.
//
//   bun run instance/scripts/test-owner.ts --url https://myc-x.example.workers.dev --db myc-x
//
// Hits the instance once so its migrations apply, then writes a test owner DID, an API token and a
// web session straight into its D1 database with `cf d1 query`. Prints the bearer token (for curl)
// and the session cookie (for a browser, e.g. Playwright). Never run this against a real owner's
// instance: it replaces the owner.
import { generateToken, hashToken } from "@mycelium/platform";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

const url = arg("url").replace(/\/$/, "");
const dbName = arg("db");

async function cf(args: string[]): Promise<string> {
  const proc = Bun.spawn(["cf", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`cf ${args.join(" ")} failed: ${err || out}`);
  return out;
}

// 1. First request applies the migrations.
const status = await fetch(`${url}/api/auth/status`);
if (!status.ok) throw new Error(`${url}/api/auth/status answered ${status.status}`);

// 2. Find the database id.
const dbs = JSON.parse(await cf(["d1", "list"])) as { name: string; uuid: string }[];
const db = dbs.find((d) => d.name === dbName);
if (!db) throw new Error(`No D1 database named ${dbName}`);

// 3. Owner, API token (30 days) and web session (30 days).
const base32 = "abcdefghijklmnopqrstuvwxyz234567";
const did = `did:plc:${Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => base32[b % 32]).join("")}`;
const apiToken = `myc_${generateToken(32)}`;
const session = generateToken(32);
const now = new Date();
const later = new Date(now.getTime() + 30 * 86_400_000);
const sql = [
  `INSERT INTO settings (key, value, updated_at) VALUES ('owner_did', '${did}', '${now.toISOString()}')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  `INSERT INTO api_tokens (id, name, token_hash, prefix, created_at, expires_at)
     VALUES ('${crypto.randomUUID()}', 'test-owner script', '${await hashToken(apiToken)}',
             '${apiToken.slice(0, 10)}', '${now.toISOString()}', '${later.toISOString()}')`,
  `INSERT INTO web_sessions (token_hash, did, created_at, expires_at)
     VALUES ('${await hashToken(session)}', '${did}', ${now.getTime()}, ${later.getTime()})`,
].join(";\n");
await cf(["d1", "query", db.uuid, "--sql", sql]);

console.log(
  JSON.stringify({ owner: did, apiToken, sessionCookie: `mycelium_session=${session}` }, null, 2),
);
