import {
  OAUTH_MIGRATION,
  WEB_SESSION_MIGRATION,
  migratedDb,
  type Migration,
} from "@mycelium/platform";

/**
 * D1 schema for instance state, applied in order on first use. See
 * @mycelium/platform's migrate.ts for the rules: never edit a merged
 * migration, and only add. New tables or columns go in a new migration at the
 * end of MIGRATIONS.
 */

export const MIGRATIONS: Migration[] = [
  {
    // Platform tables from igloo: settings and API tokens. OAuth and web
    // session tables come from @mycelium/platform (see ALL_MIGRATIONS).
    name: "0001_platform",
    statements: [
      `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // API tokens for scripts and agents. Stored only as hashes.
      `CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT
      )`,
    ],
  },
  {
    // The schema in ARCHITECTURE.md ("D1 schema").
    name: "0002_mycelium",
    statements: [
      `CREATE TABLE repos (
        name TEXT PRIMARY KEY,
        description TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        default_branch TEXT NOT NULL DEFAULT 'main',
        remote TEXT NOT NULL,
        source_url TEXT,
        subscription_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // From push events.
      `CREATE TABLE pushes (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        ref TEXT NOT NULL,
        before TEXT,
        after TEXT,
        commits TEXT NOT NULL,
        pusher TEXT,
        at TEXT NOT NULL
      )`,
      `CREATE TABLE counters (
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        next INTEGER NOT NULL,
        PRIMARY KEY (repo, kind)
      )`,
      `CREATE TABLE pulls (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        head TEXT NOT NULL,
        base TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        author TEXT NOT NULL,
        head_sha TEXT,
        base_sha TEXT,
        merge_sha TEXT,
        merge_method TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        merged_at TEXT,
        UNIQUE (repo, number)
      )`,
      `CREATE TABLE pull_comments (
        id INTEGER PRIMARY KEY,
        pull_id INTEGER NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        workflow TEXT NOT NULL,
        event TEXT NOT NULL,
        ref TEXT NOT NULL,
        sha TEXT NOT NULL,
        pull_number INTEGER,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE (repo, number)
      )`,
      `CREATE TABLE run_steps (
        run_id INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        exit_code INTEGER,
        log TEXT NOT NULL DEFAULT '',
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, idx)
      )`,
    ],
  },
  {
    // Agents as identities (#17). A token with an agent name acts as that agent
    // (null: the owner's own script token); read-scoped tokens only read. What an
    // agent does is attributed to it: `author_kind` beside the existing author
    // names, `actor`/`actor_kind` on manual runs, and a log of minted git
    // credentials.
    name: "0003_agents",
    statements: [
      "ALTER TABLE api_tokens ADD COLUMN agent TEXT",
      "ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'write'",
      "ALTER TABLE pulls ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'owner'",
      "ALTER TABLE pull_comments ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'owner'",
      "ALTER TABLE runs ADD COLUMN actor TEXT",
      "ALTER TABLE runs ADD COLUMN actor_kind TEXT",
      `CREATE TABLE git_grants (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        token_id TEXT,
        scope TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX git_grants_repo ON git_grants (repo, id)",
    ],
  },
  {
    // Workflows that must succeed on a pull request's head before it merges
    // into `branch` (src/checks/).
    name: "0004_required_checks",
    statements: [
      `CREATE TABLE required_checks (
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        workflow TEXT NOT NULL,
        PRIMARY KEY (repo, branch, workflow)
      )`,
    ],
  },
];

/** All migrations, in order. */
export const ALL_MIGRATIONS: Migration[] = [OAUTH_MIGRATION, WEB_SESSION_MIGRATION, ...MIGRATIONS];

/** The instance database, migrated on first use in each isolate. */
export const getDb = migratedDb(ALL_MIGRATIONS);

/**
 * The next number of `kind` ("pull", "run") in `repo`, like GitHub's issue
 * and run numbers. Atomic: one statement claims the number.
 */
export async function nextNumber(db: D1Database, repo: string, kind: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO counters (repo, kind, next) VALUES (?, ?, 2)
       ON CONFLICT (repo, kind) DO UPDATE SET next = next + 1
       RETURNING next - 1 AS number`,
    )
    .bind(repo, kind)
    .first<{ number: number }>();
  return row!.number;
}
