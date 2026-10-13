/**
 * Small key/value settings in a `settings (key, value, updated_at)` table,
 * which each Worker creates in its own migrations.
 */

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, new Date().toISOString())
    .run();
}

/**
 * Set a value only if the key is unset, and return whichever value won. Safe
 * when two isolates race to initialize the same setting.
 */
export async function initSetting(db: D1Database, key: string, value: string): Promise<string> {
  await db
    .prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, new Date().toISOString())
    .run();
  return (await getSetting(db, key)) as string;
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}
