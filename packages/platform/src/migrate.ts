/**
 * A schema change. Never edit or reorder one that has shipped; add a new one.
 * Migrations only add: Worker versions can roll back, D1 can't. One SQL
 * statement per array entry (D1 prepares statements one at a time).
 */
export type Migration = { name: string; statements: string[] };

/**
 * Bring the database up to date with MIGRATIONS.
 *
 * Owners never run a migration command: the first request that needs the
 * database in each isolate applies whatever is pending (see migratedDb). Each migration runs as
 * one D1 batch (a transaction) that starts by recording its own name, so if two
 * isolates race, the loser's batch fails on the primary key and rolls back
 * without touching the schema.
 */
export async function migrate(db: D1Database, migrations: Migration[]): Promise<string[]> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    )
    .run();

  const { results } = await db.prepare("SELECT name FROM _migrations").all<{ name: string }>();
  const applied = new Set(results.map((r) => r.name));
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    try {
      await db.batch([
        db
          .prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
          .bind(migration.name, new Date().toISOString()),
        ...migration.statements.map((sql) => db.prepare(sql)),
      ]);
      newlyApplied.push(migration.name);
    } catch (error) {
      const row = await db
        .prepare("SELECT 1 FROM _migrations WHERE name = ?")
        .bind(migration.name)
        .first();
      // Another isolate applied it first. Anything else is a real failure.
      if (!row) throw error;
    }
  }
  return newlyApplied;
}

/**
 * Returns a getter for the migrated database. Memoized per isolate; a failed
 * attempt is forgotten so the next request retries instead of failing forever.
 */
export function migratedDb(migrations: Migration[]): (db: D1Database) => Promise<D1Database> {
  // Keyed by binding: one per isolate in production, one per test database in tests.
  const ready = new WeakMap<D1Database, Promise<unknown>>();
  return async (db) => {
    let done = ready.get(db);
    if (!done) {
      done = migrate(db, migrations).catch((error) => {
        ready.delete(db);
        throw error;
      });
      ready.set(db, done);
    }
    await done;
    return db;
  };
}
