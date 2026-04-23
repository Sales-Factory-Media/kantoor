/**
 * In-flight ticket dispatch registry — the single source of truth for
 * "is this ticket currently being worked on?"
 *
 * Why this exists
 * ---------------
 * Before this registry, dispatch paths composed their own notion of "is this
 * ticket in flight" from several fields (ClickUp cached status, worker
 * currentTicketId, persistent-agent currentSessionId, workerAssignments list).
 * That composition was:
 *   - stale (ClickUp poll runs every 3 min — status can be minutes behind),
 *   - split across roles (dev / design) with different rules,
 *   - incomplete (autoDarrylPickup never consulted workerAssignments, etc).
 *
 * Concrete bugs it solves:
 *   1. A freshly-completed worker firing autoPickupAfterWorkerFree while the
 *      ClickUp cache still shows the just-completed ticket as "to do" — the
 *      ticket would be picked up a second time.
 *   2. Two auto-pickup cycles (e.g. ClickUp poll + worker-free event) racing
 *      to dispatch the same ticket because neither saw the other's in-flight
 *      state.
 *   3. Jan dispatching a batch ticket that a human (or Jan herself in a prior
 *      session) already dispatched, because the cached status hadn't caught up.
 *   4. autoDesignerRevisionPickup matching two designers to the same revision
 *      ticket via `lastTicketId`.
 *
 * Semantics
 * ---------
 *   - claimTicket(registry, ticketId, ...) is an atomic check-and-set. First
 *     caller wins; subsequent callers for the same ticket see false until the
 *     original claim is released.
 *   - releaseTicket is idempotent. Safe to call from multiple session-end
 *     paths without coordination.
 *   - The registry lives in memory on the hub only. Worker processes don't
 *     need one — they're dispatch endpoints, not auto-pickup initiators.
 *
 * What NOT to use the registry for
 * --------------------------------
 *   - Role-level locks (is Darryl/Jan running?) — those still use
 *     `pa.currentSessionId` because the question is "is THIS ROLE occupied",
 *     not "is THIS TICKET in flight".
 *   - Per-machine visual slot lock — still uses `findBusyVisualSlot`,
 *     because it's a per-machine resource lock, not a ticket-level claim.
 */

export interface TicketClaim {
	ticketId: string;
	/** Who holds the claim — a worker name, "hub", or a role name. */
	claimedBy: string;
	/** epoch ms */
	claimedAt: number;
	/** Human-readable reason the claim exists. Used for logs/diagnostics. */
	purpose: string;
}

export type DispatchRegistry = Map<string, TicketClaim>;

export function createDispatchRegistry(): DispatchRegistry {
	return new Map();
}

/**
 * Atomically try to claim a ticket. Returns true if the claim was granted and
 * the caller now owns the dispatch; returns false if someone else already
 * holds the claim (the caller should skip).
 */
export function claimTicket(
	registry: DispatchRegistry,
	ticketId: string,
	claimedBy: string,
	purpose: string,
): boolean {
	if (!ticketId) return false;
	if (registry.has(ticketId)) return false;
	registry.set(ticketId, {
		ticketId,
		claimedBy,
		claimedAt: Date.now(),
		purpose,
	});
	return true;
}

/** Release a claim. Idempotent — returns true if something was released. */
export function releaseTicket(registry: DispatchRegistry, ticketId: string): boolean {
	if (!ticketId) return false;
	return registry.delete(ticketId);
}

export function isTicketClaimed(registry: DispatchRegistry, ticketId: string): boolean {
	return registry.has(ticketId);
}

export function getTicketClaim(registry: DispatchRegistry, ticketId: string): TicketClaim | undefined {
	return registry.get(ticketId);
}

/**
 * Snapshot the currently-claimed ticket IDs — for filtering tickets out of
 * auto-pickup candidates without mutating the registry.
 */
export function claimedTicketIds(registry: DispatchRegistry): Set<string> {
	return new Set(registry.keys());
}

export function allClaims(registry: DispatchRegistry): TicketClaim[] {
	return Array.from(registry.values());
}
