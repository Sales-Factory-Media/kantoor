import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { seats } from './schema.js';
import { getActiveBuildingId, tryGetActiveBuildingId } from './activeBuilding.js';

export type SeatMeta = Record<string, unknown>;
export type SeatsBySession = Record<string, SeatMeta>;

let cache: SeatsBySession = {};

export async function initSeatStore(): Promise<void> {
	const db = getDb();
	const buildingId = getActiveBuildingId();
	const rows = await db.select().from(seats).where(eq(seats.buildingId, buildingId));
	const next: SeatsBySession = {};
	for (const r of rows) next[r.sessionId] = r.data;
	cache = next;
}

export function loadSeats(): SeatsBySession {
	return cache;
}

export function saveSeats(next: SeatsBySession): void {
	cache = next;
	const buildingId = tryGetActiveBuildingId();
	if (!buildingId) return;
	const db = getDb();
	const entries = Object.entries(next).map(([sessionId, data]) => ({
		buildingId,
		sessionId,
		data,
	}));
	(async () => {
		try {
			await db.transaction(async (tx) => {
				await tx.delete(seats).where(eq(seats.buildingId, buildingId));
				if (entries.length > 0) {
					for (let i = 0; i < entries.length; i += 200) {
						await tx.insert(seats).values(entries.slice(i, i + 200));
					}
				}
			});
		} catch (err) {
			console.error('[seatStore] Failed to persist seats:', err);
		}
	})();
}
