import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestD1 } from "./testing.ts";
import { migrate, type Migration } from "./migrate.ts";

const MIGRATIONS: Migration[] = [
  { name: "0001_a", statements: ["CREATE TABLE a (id INTEGER)", "CREATE INDEX a_id ON a (id)"] },
  { name: "0002_b", statements: ["CREATE TABLE b (id INTEGER)"] },
];

let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => ({ db, dispose } = await createTestD1()));
afterEach(() => dispose());

async function tables(): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\' ORDER BY name",
    )
    .all<{ name: string }>();
  return results.map((r) => r.name).filter((n) => !n.startsWith("sqlite_"));
}

describe("migrate", () => {
  test("applies every migration to a fresh database", async () => {
    expect(await migrate(db, MIGRATIONS)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await tables()).toEqual(["_migrations", "a", "b"]);
  });

  test("is a no-op once up to date", async () => {
    await migrate(db, MIGRATIONS);
    expect(await migrate(db, MIGRATIONS)).toEqual([]);
  });

  test("applies only what is pending", async () => {
    await migrate(db, MIGRATIONS);
    const next = { name: "9999_extra", statements: ["CREATE TABLE extra (id INTEGER)"] };
    expect(await migrate(db, [...MIGRATIONS, next])).toEqual(["9999_extra"]);
    expect(await tables()).toContain("extra");
  });

  test("a failing migration rolls back entirely and is not recorded", async () => {
    const bad = {
      name: "0002_bad",
      statements: ["CREATE TABLE half (id INTEGER)", "THIS IS NOT SQL"],
    };
    await expect(migrate(db, [...MIGRATIONS, bad])).rejects.toThrow();
    expect(await tables()).not.toContain("half");
    // The good migration before it stays applied, and the bad one can be retried once fixed.
    const fixed = { ...bad, statements: ["CREATE TABLE half (id INTEGER)"] };
    expect(await migrate(db, [...MIGRATIONS, fixed])).toEqual(["0002_bad"]);
  });

  test("concurrent runs apply each migration exactly once", async () => {
    const runs = await Promise.all([
      migrate(db, MIGRATIONS),
      migrate(db, MIGRATIONS),
      migrate(db, MIGRATIONS),
    ]);
    expect(runs.flat().sort()).toEqual(MIGRATIONS.map((m) => m.name).sort());
    const { results } = await db.prepare("SELECT name FROM _migrations").all();
    expect(results).toHaveLength(MIGRATIONS.length);
  });
});
