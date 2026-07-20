/**
 * Pending-delegation store — the hub's record of "Darryl has classified this
 * ticket and it's waiting for a human to confirm the worker".
 *
 * Part of Auto Mode (see AUTO_MODE_ASSIGNEE_USERNAME): when a "to do" ticket
 * assigned to the auto-mode user is detected, Darryl is dispatched to pick the
 * best worker. Instead of launching the worker himself, he POSTs a
 * recommendation to /api/darryl-recommendation, which lands here. The kantoor
 * shows a confirmation popup; the human clicks Start (→ confirmDelegation) or
 * Discard (→ discardDelegation).
 *
 * Why a dedicated store (not the dispatch registry):
 *   - The dispatch registry tracks tickets that are ACTIVELY being worked (a
 *     worker session holds the claim). A pending delegation is NOT in flight —
 *     no worker is running yet, it's waiting on a human decision.
 *   - Auto-pickup filters out both sets so a ticket isn't re-classified while
 *     its recommendation is still waiting (that's the "once classified, leave
 *     it waiting" requirement).
 *
 * In-memory, hub-only. A server restart drops pending recommendations and the
 * affected tickets get re-classified on the next poll — acceptable, same
 * durability model as the dispatch registry.
 */

export interface PendingDelegation {
	ticketId: string;
	ticketName: string;
	ticketUrl: string;
	/** The specific worker Darryl recommends (a real PersistentAgent). */
	recommendedAgentId: string;
	recommendedAgentName: string;
	recommendedAgentRole: string;
	/** Workspace the recommended worker runs in — used at dispatch time. */
	recommendedWorkspacePath: string;
	/** Darryl's one-liner on WHY this worker — shown in the popup. */
	reasoning: string;
	/** The work Brief Darryl wrote — passed to the worker on Start. */
	brief: string;
	/** epoch ms */
	createdAt: number;
}

export type DelegationStore = Map<string, PendingDelegation>;

export function createDelegationStore(): DelegationStore {
	return new Map();
}

/** Add (or replace) a pending delegation for a ticket. */
export function addPendingDelegation(store: DelegationStore, delegation: PendingDelegation): void {
	if (!delegation.ticketId) return;
	store.set(delegation.ticketId, delegation);
}

/** Remove a pending delegation. Idempotent — returns true if one was removed. */
export function removePendingDelegation(store: DelegationStore, ticketId: string): boolean {
	if (!ticketId) return false;
	return store.delete(ticketId);
}

export function getPendingDelegation(store: DelegationStore, ticketId: string): PendingDelegation | undefined {
	return store.get(ticketId);
}

export function hasPendingDelegation(store: DelegationStore, ticketId: string): boolean {
	return store.has(ticketId);
}

/** All pending delegations, oldest first (stable tab order in the popup). */
export function getPendingDelegations(store: DelegationStore): PendingDelegation[] {
	return Array.from(store.values()).sort((a, b) => a.createdAt - b.createdAt);
}

/** Snapshot of ticket IDs with a pending recommendation — for auto-pickup filtering. */
export function pendingDelegationIds(store: DelegationStore): Set<string> {
	return new Set(store.keys());
}
