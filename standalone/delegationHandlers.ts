/**
 * Auto Mode delegation handlers — the hub side of the human-gated Darryl flow.
 *
 *   /api/darryl-recommendation  → Darryl posts his worker pick (no dispatch).
 *   confirmDelegation (ws)      → human clicks Start → dispatch that worker on
 *                                 the current branch, drop the pending record.
 *   discardDelegation (ws)      → human drops a bad recommendation → ticket is
 *                                 re-classified on the next poll.
 *
 * See standalone/delegationStore.ts for the store and standalone/clickupHandlers
 * (autoJasperClassifyPickup) for how tickets get here.
 */

import type { ServerContext } from './serverContext.js';
import {
	addPendingDelegation,
	getPendingDelegation,
	getPendingDelegations,
	postponeDelegation,
	removePendingDelegation,
	type PendingDelegation,
} from './delegationStore.js';
import {
	deletePersistedDelegation,
	loadPersistedDelegations,
	persistDelegation,
} from './delegationPersistence.js';
import { DELEGATION_POSTPONE_MS } from './constants.js';
import { launchAgentOnTicket } from './workerDispatch.js';

/** Find a ticket's connector date_updated (epoch ms) in the current cache. */
function ticketUpdatedAt(ctx: ServerContext, ticketId: string): number | undefined {
	for (const group of ctx.clickupTickets) {
		for (const task of group.tasks) {
			if (task.id === ticketId) {
				const raw = (task as { dateUpdated?: string }).dateUpdated;
				const n = raw != null ? Number(raw) : NaN;
				return Number.isFinite(n) ? n : undefined;
			}
		}
	}
	return undefined;
}

/**
 * Rehydrate the in-memory delegation store from Postgres at boot. Restores the
 * "Awaiting delegation" popups that used to vanish on every restart.
 */
export async function loadDelegationsIntoStore(ctx: ServerContext): Promise<void> {
	try {
		const rows = await loadPersistedDelegations();
		for (const d of rows) addPendingDelegation(ctx.delegationStore, d);
		if (rows.length > 0) {
			console.log(`[Standalone] Restored ${rows.length} pending delegation(s) from DB`);
		}
	} catch (err) {
		console.error('[Standalone] Failed to load pending delegations:', err);
	}
}

/** Push the full current delegation list to every connected client. */
export function broadcastDelegations(ctx: ServerContext): void {
	ctx.broadcastSink.postMessage({
		type: 'delegationPending',
		delegations: getPendingDelegations(ctx.delegationStore),
	});
}

/**
 * Record Darryl's classification. Resolves the recommended agent so the popup
 * (and the eventual dispatch) has an authoritative name/role/workspace. Returns
 * a result the HTTP layer turns into 200/400.
 */
export function handleDarrylRecommendation(
	json: Record<string, unknown>,
	ctx: ServerContext,
): { success: boolean; error?: string } {
	const ticketId = typeof json.ticketId === 'string' ? json.ticketId : '';
	const ticketName = typeof json.ticketName === 'string' ? json.ticketName : '';
	const ticketUrl = typeof json.ticketUrl === 'string' ? json.ticketUrl : '';
	const recommendedAgentId = typeof json.recommendedAgentId === 'string' ? json.recommendedAgentId : '';
	const reasoning = typeof json.reasoning === 'string' ? json.reasoning.trim() : '';
	const brief = typeof json.brief === 'string' ? json.brief.trim() : '';

	if (!ticketId) return { success: false, error: 'Missing required field: ticketId' };
	if (!recommendedAgentId) return { success: false, error: 'Missing required field: recommendedAgentId' };

	const agent = ctx.persistentAgents.find(p => p.id === recommendedAgentId);
	if (!agent) return { success: false, error: `Recommended agent "${recommendedAgentId}" not found.` };
	if (!agent.workspacePath) return { success: false, error: `Recommended agent "${agent.name}" has no workspace path.` };

	// Preserve the original createdAt when re-classifying (ticket was updated),
	// but always refresh the evaluation timestamp + the ticket's date_updated.
	const now = Date.now();
	const existing = getPendingDelegation(ctx.delegationStore, ticketId);
	const delegation: PendingDelegation = {
		ticketId,
		ticketName,
		ticketUrl,
		recommendedAgentId: agent.id,
		recommendedAgentName: agent.name,
		recommendedAgentRole: agent.roleShort,
		recommendedWorkspacePath: agent.workspacePath,
		reasoning,
		brief,
		createdAt: existing?.createdAt ?? now,
		lastEvaluatedAt: now,
		ticketUpdatedAt: ticketUpdatedAt(ctx, ticketId),
		buildingId: ctx.activeBuilding?.id,
		// Re-evaluation clears any prior snooze — a fresh recommendation should
		// surface, not stay hidden behind a stale postpone.
	};

	addPendingDelegation(ctx.delegationStore, delegation);
	persistDelegation(delegation);
	console.log(`[Standalone] Darryl recommendation for ticket ${ticketId}: "${agent.name}" (${agent.id})`);
	broadcastDelegations(ctx);
	return { success: true };
}

/**
 * Human confirmed Darryl's pick. Dispatch the exact recommended worker on the
 * ticket, working on the currently checked-out branch, then drop the pending
 * record. On dispatch failure the record is kept so the human can retry.
 */
export async function handleConfirmDelegation(msg: Record<string, unknown>, ctx: ServerContext): Promise<void> {
	const ticketId = msg.ticketId as string;
	const delegation = getPendingDelegation(ctx.delegationStore, ticketId);
	if (!delegation) {
		console.log(`[Standalone] confirmDelegation: no pending delegation for ticket ${ticketId}`);
		return;
	}

	const result = await launchAgentOnTicket(
		delegation.recommendedWorkspacePath,
		delegation.ticketId,
		delegation.ticketName,
		delegation.ticketUrl,
		ctx,
		{
			agentId: delegation.recommendedAgentId,
			additionalPrompt: delegation.brief,
			currentBranch: true,
		},
	);

	if (result.success) {
		removePendingDelegation(ctx.delegationStore, ticketId);
		deletePersistedDelegation(ticketId);
		broadcastDelegations(ctx);
		console.log(`[Standalone] confirmDelegation: launched "${result.worker ?? delegation.recommendedAgentName}" for ticket ${ticketId}`);
	} else {
		console.log(`[Standalone] confirmDelegation: failed to launch for ticket ${ticketId}: ${result.error}`);
		ctx.broadcastSink.postMessage({ type: 'delegationError', ticketId, error: result.error ?? 'Failed to launch worker.' });
	}
}

/** Human dropped a recommendation — ticket becomes eligible for re-classification. */
export function handleDiscardDelegation(msg: Record<string, unknown>, ctx: ServerContext): void {
	const ticketId = msg.ticketId as string;
	if (removePendingDelegation(ctx.delegationStore, ticketId)) {
		deletePersistedDelegation(ticketId);
		console.log(`[Standalone] discardDelegation: dropped recommendation for ticket ${ticketId}`);
		broadcastDelegations(ctx);
	}
}

/**
 * Human hit Postpone — snooze the recommendation for DELEGATION_POSTPONE_MS.
 * The pick is kept (and persisted) but hidden from the popup until it expires;
 * the ticket is NOT re-classified in the meantime (it's still "decided").
 */
export function handlePostponeDelegation(msg: Record<string, unknown>, ctx: ServerContext): void {
	const ticketId = msg.ticketId as string;
	const until = Date.now() + DELEGATION_POSTPONE_MS;
	const updated = postponeDelegation(ctx.delegationStore, ticketId, until);
	if (updated) {
		persistDelegation(updated);
		console.log(`[Standalone] postponeDelegation: snoozed ticket ${ticketId} until ${new Date(until).toISOString()}`);
		broadcastDelegations(ctx);
	}
}
