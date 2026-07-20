/**
 * Postgres mirror for the Auto Mode delegation store.
 *
 * The in-memory `DelegationStore` (delegationStore.ts) stays the runtime source
 * of truth; these helpers keep the `pending_delegations` table in sync so
 * Darryl's classifications survive a hub restart. Writes are fire-and-forget
 * (logged on failure) — same durability posture as the other stores.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { pendingDelegations } from '../src/db/schema.js';
import type { PendingDelegation } from './delegationStore.js';

function rowToDelegation(r: typeof pendingDelegations.$inferSelect): PendingDelegation {
	return {
		ticketId: r.ticketId,
		ticketName: r.ticketName,
		ticketUrl: r.ticketUrl,
		recommendedAgentId: r.recommendedAgentId,
		recommendedAgentName: r.recommendedAgentName,
		recommendedAgentRole: r.recommendedAgentRole,
		recommendedWorkspacePath: r.recommendedWorkspacePath,
		reasoning: r.reasoning,
		brief: r.brief,
		createdAt: r.createdAt,
		lastEvaluatedAt: r.lastEvaluatedAt,
		ticketUpdatedAt: r.ticketUpdatedAt ?? undefined,
		postponedUntil: r.postponedUntil ?? undefined,
		buildingId: r.buildingId ?? undefined,
	};
}

function delegationToRow(d: PendingDelegation): typeof pendingDelegations.$inferInsert {
	return {
		ticketId: d.ticketId,
		buildingId: d.buildingId ?? null,
		ticketName: d.ticketName,
		ticketUrl: d.ticketUrl,
		recommendedAgentId: d.recommendedAgentId,
		recommendedAgentName: d.recommendedAgentName,
		recommendedAgentRole: d.recommendedAgentRole,
		recommendedWorkspacePath: d.recommendedWorkspacePath,
		reasoning: d.reasoning,
		brief: d.brief,
		createdAt: d.createdAt,
		lastEvaluatedAt: d.lastEvaluatedAt,
		ticketUpdatedAt: d.ticketUpdatedAt ?? null,
		postponedUntil: d.postponedUntil ?? null,
	};
}

/** Load every persisted delegation (all buildings — the store isn't scoped). */
export async function loadPersistedDelegations(): Promise<PendingDelegation[]> {
	const db = getDb();
	const rows = await db.select().from(pendingDelegations);
	return rows.map(rowToDelegation);
}

/** Insert or update a delegation. Fire-and-forget. */
export function persistDelegation(d: PendingDelegation): void {
	const db = getDb();
	const row = delegationToRow(d);
	(async () => {
		try {
			await db.insert(pendingDelegations).values(row)
				.onConflictDoUpdate({ target: pendingDelegations.ticketId, set: row });
		} catch (err) {
			console.error(`[delegationPersistence] Failed to persist delegation ${d.ticketId}:`, err);
		}
	})();
}

/** Delete a delegation row by ticket id. Fire-and-forget. */
export function deletePersistedDelegation(ticketId: string): void {
	if (!ticketId) return;
	const db = getDb();
	(async () => {
		try {
			await db.delete(pendingDelegations).where(eq(pendingDelegations.ticketId, ticketId));
		} catch (err) {
			console.error(`[delegationPersistence] Failed to delete delegation ${ticketId}:`, err);
		}
	})();
}
