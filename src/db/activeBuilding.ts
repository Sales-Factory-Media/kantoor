import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { buildings } from './schema.js';
import type { Building } from './schema.js';

/**
 * Tracks the currently-active building. For now (step 4 of the multi-building
 * migration) the server always operates against a single building — the
 * "Vibelab" one populated by the JSON import. Step 5 introduces the UI
 * dropdown and per-connection building switching; at that point this becomes
 * a per-WS-connection concept rather than a global one. Until then, having a
 * single global "active building" keeps the existing single-building call
 * sites working unchanged.
 */

let activeBuildingId: string | null = null;
let activeBuildingCache: Building | null = null;

export async function initActiveBuilding(slug = 'vibelab'): Promise<Building> {
	const db = getDb();
	const rows = await db.select().from(buildings).where(eq(buildings.slug, slug)).limit(1);
	if (rows.length === 0) {
		throw new Error(`[activeBuilding] No building with slug "${slug}" found. Did the JSON migration run?`);
	}
	activeBuildingCache = rows[0];
	activeBuildingId = rows[0].id;
	return rows[0];
}

export function getActiveBuildingId(): string {
	if (!activeBuildingId) {
		throw new Error('[activeBuilding] Not initialized. Call initActiveBuilding() at server boot.');
	}
	return activeBuildingId;
}

/** Returns null if not initialized — for callers that can no-op gracefully (e.g. VS Code extension). */
export function tryGetActiveBuildingId(): string | null {
	return activeBuildingId;
}

export function getActiveBuilding(): Building {
	if (!activeBuildingCache) {
		throw new Error('[activeBuilding] Not initialized. Call initActiveBuilding() at server boot.');
	}
	return activeBuildingCache;
}

export async function listBuildings(): Promise<Building[]> {
	const db = getDb();
	return db.select().from(buildings).orderBy(buildings.sortOrder);
}

/**
 * Switch the module-level active building to a different slug. The caller is
 * responsible for re-running each store's `initX()` afterward to refresh their
 * caches. Returns the new active building.
 */
export async function switchActiveBuilding(slug: string): Promise<Building> {
	const db = getDb();
	const rows = await db.select().from(buildings).where(eq(buildings.slug, slug)).limit(1);
	if (rows.length === 0) {
		throw new Error(`[activeBuilding] No building with slug "${slug}"`);
	}
	activeBuildingCache = rows[0];
	activeBuildingId = rows[0].id;
	return rows[0];
}
