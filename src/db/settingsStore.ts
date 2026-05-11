import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { appSettings, buildings } from './schema.js';
import { getActiveBuildingId, tryGetActiveBuildingId } from './activeBuilding.js';

/**
 * Global app settings (NOT building-scoped). Values are typed as `unknown` —
 * each caller knows what shape it stored.
 */
let cache: Map<string, unknown> = new Map();

export async function initSettingsStore(): Promise<void> {
	const db = getDb();
	const rows = await db.select().from(appSettings);
	const next = new Map<string, unknown>();
	for (const r of rows) next.set(r.key, r.value);
	cache = next;
}

export function getAppSetting<T = unknown>(key: string): T | undefined {
	return cache.get(key) as T | undefined;
}

export function setAppSetting(key: string, value: unknown): void {
	cache.set(key, value);
	const db = getDb();
	(async () => {
		try {
			await db.insert(appSettings).values({ key, value })
				.onConflictDoUpdate({ target: appSettings.key, set: { value } });
		} catch (err) {
			console.error(`[settingsStore] Failed to persist setting "${key}":`, err);
		}
	})();
}

/**
 * Building-scoped connector config (e.g. ClickUp { apiToken, listId },
 * GitHub { token, owner, repo }). Read returns the active building's
 * config; write merges into it.
 */
export async function getActiveBuildingConnectorConfig(): Promise<Record<string, unknown>> {
	const db = getDb();
	const buildingId = getActiveBuildingId();
	const rows = await db.select({ cfg: buildings.connectorConfig }).from(buildings).where(eq(buildings.id, buildingId)).limit(1);
	return (rows[0]?.cfg ?? {}) as Record<string, unknown>;
}

export async function patchActiveBuildingConnectorConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
	const buildingId = tryGetActiveBuildingId();
	if (!buildingId) throw new Error('[settingsStore] activeBuilding not initialized');
	const db = getDb();
	const merged = { ...(await getActiveBuildingConnectorConfig()), ...patch };
	await db.update(buildings).set({ connectorConfig: merged }).where(eq(buildings.id, buildingId));
	return merged;
}
