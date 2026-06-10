import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { sessionHistory } from './schema.js';
import { getActiveBuildingId, tryGetActiveBuildingId } from './activeBuilding.js';

/**
 * In-memory cache of (sessionId → agentId) for the ACTIVE building. Populated
 * at boot via `initSessionHistoryStore()` and on every building switch.
 * Reads are synchronous so callers like `onNewSession` (which is a sync scanner
 * callback) can resolve a freshly-discovered session to its original owner
 * without awaiting the DB.
 *
 * Writes go: update the cache synchronously, then fire-and-forget upsert the
 * row to Postgres. Crash-safety isn't critical here — on the next boot the
 * cache is re-hydrated from the DB, and any in-flight write that got dropped
 * just means the next `onNewSession` for that session falls through to minting
 * a provisional + popup (the pre-session-history behaviour). Far better than
 * blocking the sync scanner callback on every discovered file.
 */
let cache = new Map<string, string>();

export async function initSessionHistoryStore(): Promise<void> {
	const db = getDb();
	const buildingId = getActiveBuildingId();
	const rows = await db
		.select({ sessionId: sessionHistory.sessionId, agentId: sessionHistory.agentId })
		.from(sessionHistory)
		.where(eq(sessionHistory.buildingId, buildingId));
	const next = new Map<string, string>();
	for (const r of rows) next.set(r.sessionId, r.agentId);
	cache = next;
}

/** Sync read from the in-memory cache — null if nobody has ever owned this session. */
export function lookupSessionOwner(sessionId: string): string | null {
	return cache.get(sessionId) ?? null;
}

/**
 * Upsert ownership of `sessionId` to `agentId`. Idempotent — calling twice with
 * the same args is a no-op; calling with a different `agentId` (reassignment)
 * overwrites. Cache updated synchronously; DB upsert is fire-and-forget.
 */
export function recordSessionOwner(sessionId: string, agentId: string): void {
	if (!sessionId || !agentId) return;
	if (cache.get(sessionId) === agentId) return;
	cache.set(sessionId, agentId);

	const buildingId = tryGetActiveBuildingId();
	if (!buildingId) return;
	const db = getDb();
	(async () => {
		try {
			await db
				.insert(sessionHistory)
				.values({ sessionId, agentId, buildingId })
				.onConflictDoUpdate({
					target: sessionHistory.sessionId,
					set: { agentId },
				});
		} catch (err) {
			console.error(`[sessionHistory] Failed to record (${sessionId} → ${agentId}):`, err);
		}
	})();
}

/**
 * Bulk-seed the cache from a list of (sessionId, agentId) pairs. Used by the
 * server boot path to backfill any sessions present in PersistentAgent
 * `currentSessions` arrays but not yet in the session_history table (e.g.
 * sessions launched before this table existed — the migration's backfill
 * handles most, this catches the edge cases like additions made between
 * migration and store init).
 */
export function seedSessionHistoryCache(entries: Array<{ sessionId: string; agentId: string }>): void {
	for (const e of entries) {
		if (e.sessionId && e.agentId && !cache.has(e.sessionId)) {
			cache.set(e.sessionId, e.agentId);
		}
	}
}
