import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const DEFAULT_DATABASE_URL = 'postgres://pixelagents:pixelagents@localhost:5438/pixelagents';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let pool: pg.Pool | null = null;
let db: Database | null = null;

export function getDatabaseUrl(): string {
	return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

export function getDb(): Database {
	if (db) return db;
	pool = new pg.Pool({ connectionString: getDatabaseUrl() });
	db = drizzle(pool, { schema });
	return db;
}

export async function closeDb(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
		db = null;
	}
}
