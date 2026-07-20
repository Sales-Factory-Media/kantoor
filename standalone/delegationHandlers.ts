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
	removePendingDelegation,
	type PendingDelegation,
} from './delegationStore.js';
import { launchAgentOnTicket } from './workerDispatch.js';

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
		createdAt: Date.now(),
	};

	addPendingDelegation(ctx.delegationStore, delegation);
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
		console.log(`[Standalone] discardDelegation: dropped recommendation for ticket ${ticketId}`);
		broadcastDelegations(ctx);
	}
}
