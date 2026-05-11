import * as path from 'path';
import * as fs from 'fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDatabaseUrl } from './client.js';

/**
 * Run all pending Drizzle migrations against the configured database.
 * Locates the migrations folder relative to this file so it works from
 * both `src/` (tsx/dev) and `dist/` (bundled standalone build).
 */
export async function runMigrations(): Promise<void> {
	const migrationsFolder = resolveMigrationsFolder();
	const pool = new pg.Pool({ connectionString: getDatabaseUrl() });
	try {
		const db = drizzle(pool);
		console.log(`[DB] Running migrations from ${migrationsFolder}`);
		await migrate(db, { migrationsFolder });
		console.log('[DB] Migrations up to date');
	} finally {
		await pool.end();
	}
}

function resolveMigrationsFolder(): string {
	// __dirname works under Node16/CommonJS module mode (the project's setting).
	const here = __dirname;
	const candidates = [
		path.resolve(here, 'migrations'),                       // src/db/ when running via tsx
		path.resolve(here, 'db', 'migrations'),                 // dist/ — bundle is dist/standalone.js, migrations copied to dist/db/migrations
		path.resolve(here, '..', 'src', 'db', 'migrations'),    // dist/ → repo root → src/db/migrations (fallback)
	];
	for (const c of candidates) {
		if (fs.existsSync(c) && fs.existsSync(path.join(c, 'meta'))) return c;
	}
	throw new Error(`[DB] Could not locate migrations folder. Tried: ${candidates.join(', ')}`);
}
