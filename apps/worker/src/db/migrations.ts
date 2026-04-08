/**
 * Schema migrations for Tower Together Durable Object SQLite storage.
 *
 * SQL lives in apps/worker/migrations/NNNN_<description>.sql and is bundled
 * as text via the [[rules]] entry in wrangler.toml.
 *
 * Each migration is applied exactly once per DO instance, tracked in the
 * `schema_migrations` table. To add a new migration:
 *   1. Create apps/worker/migrations/NNNN_<description>.sql
 *   2. Import it below and append an entry to MIGRATIONS.
 *   Never edit or reorder existing entries.
 */

import sql_0001 from "../../migrations/0001_initial.sql";

interface Migration {
	version: number;
	description: string;
	sql: string;
}

const MIGRATIONS: Migration[] = [
	{ version: 1, description: "Initial schema", sql: sql_0001 },
];

/**
 * Apply all pending migrations to the given SQLite handle.
 * Safe to call on every DO construction — already-applied migrations are skipped.
 */
export function runMigrations(sql: SqlStorage): void {
	sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  INTEGER NOT NULL
    )
  `);

	const rows = sql
		.exec("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations")
		.toArray() as Array<{ v: number }>;
	const currentVersion = rows[0]?.v ?? 0;

	for (const migration of MIGRATIONS) {
		if (migration.version <= currentVersion) continue;
		sql.exec(migration.sql);
		sql.exec(
			"INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
			migration.version,
			migration.description,
			Date.now(),
		);
	}
}
