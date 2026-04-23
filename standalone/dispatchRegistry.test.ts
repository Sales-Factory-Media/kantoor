import { describe, it, expect } from 'vitest';
import {
	createDispatchRegistry,
	claimTicket,
	releaseTicket,
	isTicketClaimed,
	getTicketClaim,
	claimedTicketIds,
	allClaims,
} from './dispatchRegistry.js';

describe('dispatchRegistry', () => {
	describe('claimTicket', () => {
		it('grants a first-time claim', () => {
			const registry = createDispatchRegistry();
			const granted = claimTicket(registry, 'T-1', 'worker-a', 'darryl-dispatch');
			expect(granted).toBe(true);
			expect(registry.size).toBe(1);
		});

		it('rejects a second claim on the same ticket even from the same claimer', () => {
			const registry = createDispatchRegistry();
			expect(claimTicket(registry, 'T-1', 'worker-a', 'darryl-dispatch')).toBe(true);
			expect(claimTicket(registry, 'T-1', 'worker-a', 'darryl-dispatch')).toBe(false);
			expect(registry.size).toBe(1);
		});

		it('rejects a second claim on the same ticket from a different claimer', () => {
			const registry = createDispatchRegistry();
			expect(claimTicket(registry, 'T-1', 'worker-a', 'darryl-dispatch')).toBe(true);
			expect(claimTicket(registry, 'T-1', 'worker-b', 'visual-designer')).toBe(false);
			// First claimer retains ownership.
			expect(getTicketClaim(registry, 'T-1')?.claimedBy).toBe('worker-a');
		});

		it('allows concurrent claims on different tickets', () => {
			const registry = createDispatchRegistry();
			expect(claimTicket(registry, 'T-1', 'worker-a', 'dev-worker')).toBe(true);
			expect(claimTicket(registry, 'T-2', 'worker-b', 'dev-worker')).toBe(true);
			expect(claimTicket(registry, 'T-3', 'worker-a', 'dev-worker')).toBe(true);
			expect(registry.size).toBe(3);
		});

		it('refuses claims on empty ticket IDs', () => {
			const registry = createDispatchRegistry();
			expect(claimTicket(registry, '', 'worker-a', 'darryl-dispatch')).toBe(false);
			expect(registry.size).toBe(0);
		});

		it('stamps the claim with claimedAt, claimedBy, and purpose', () => {
			const registry = createDispatchRegistry();
			const before = Date.now();
			claimTicket(registry, 'T-1', 'worker-a', 'ux-designer');
			const after = Date.now();
			const claim = getTicketClaim(registry, 'T-1');
			expect(claim).toBeDefined();
			expect(claim!.ticketId).toBe('T-1');
			expect(claim!.claimedBy).toBe('worker-a');
			expect(claim!.purpose).toBe('ux-designer');
			expect(claim!.claimedAt).toBeGreaterThanOrEqual(before);
			expect(claim!.claimedAt).toBeLessThanOrEqual(after);
		});
	});

	describe('releaseTicket', () => {
		it('releases a held claim', () => {
			const registry = createDispatchRegistry();
			claimTicket(registry, 'T-1', 'worker-a', 'darryl-dispatch');
			expect(releaseTicket(registry, 'T-1')).toBe(true);
			expect(registry.size).toBe(0);
		});

		it('is idempotent — releasing twice does not throw', () => {
			const registry = createDispatchRegistry();
			claimTicket(registry, 'T-1', 'worker-a', 'darryl-dispatch');
			expect(releaseTicket(registry, 'T-1')).toBe(true);
			expect(releaseTicket(registry, 'T-1')).toBe(false); // already gone
			expect(registry.size).toBe(0);
		});

		it('is a no-op for an unknown ticket ID', () => {
			const registry = createDispatchRegistry();
			expect(releaseTicket(registry, 'T-unknown')).toBe(false);
		});

		it('allows a new claim after release', () => {
			const registry = createDispatchRegistry();
			claimTicket(registry, 'T-1', 'worker-a', 'darryl-dispatch');
			releaseTicket(registry, 'T-1');
			expect(claimTicket(registry, 'T-1', 'worker-b', 'visual-designer')).toBe(true);
			expect(getTicketClaim(registry, 'T-1')?.claimedBy).toBe('worker-b');
		});

		it('ignores empty ticket IDs', () => {
			const registry = createDispatchRegistry();
			expect(releaseTicket(registry, '')).toBe(false);
		});
	});

	describe('isTicketClaimed / getTicketClaim', () => {
		it('reports not-claimed for unknown tickets', () => {
			const registry = createDispatchRegistry();
			expect(isTicketClaimed(registry, 'T-1')).toBe(false);
			expect(getTicketClaim(registry, 'T-1')).toBeUndefined();
		});

		it('reports claimed after claimTicket succeeds', () => {
			const registry = createDispatchRegistry();
			claimTicket(registry, 'T-1', 'worker-a', 'darryl-dispatch');
			expect(isTicketClaimed(registry, 'T-1')).toBe(true);
			expect(getTicketClaim(registry, 'T-1')).toBeDefined();
		});
	});

	describe('claimedTicketIds / allClaims', () => {
		it('returns an empty set / array for a fresh registry', () => {
			const registry = createDispatchRegistry();
			expect(claimedTicketIds(registry).size).toBe(0);
			expect(allClaims(registry)).toEqual([]);
		});

		it('includes every active claim', () => {
			const registry = createDispatchRegistry();
			claimTicket(registry, 'T-1', 'worker-a', 'dev-worker');
			claimTicket(registry, 'T-2', 'worker-b', 'dev-worker');
			claimTicket(registry, 'T-3', 'worker-c', 'visual-designer');

			expect(claimedTicketIds(registry)).toEqual(new Set(['T-1', 'T-2', 'T-3']));
			expect(allClaims(registry).map(c => c.ticketId).sort()).toEqual(['T-1', 'T-2', 'T-3']);
		});

		it('returns a snapshot — mutating the returned Set does not affect the registry', () => {
			const registry = createDispatchRegistry();
			claimTicket(registry, 'T-1', 'worker-a', 'dev-worker');
			const snapshot = claimedTicketIds(registry);
			snapshot.delete('T-1');
			expect(isTicketClaimed(registry, 'T-1')).toBe(true);
		});

		it('reflects releases', () => {
			const registry = createDispatchRegistry();
			claimTicket(registry, 'T-1', 'worker-a', 'dev-worker');
			claimTicket(registry, 'T-2', 'worker-b', 'dev-worker');
			releaseTicket(registry, 'T-1');
			expect(claimedTicketIds(registry)).toEqual(new Set(['T-2']));
		});
	});

	describe('concurrent-claim semantics (the race that matters)', () => {
		it('guarantees exactly one winner when two cycles race to claim the same ticket', () => {
			// Simulating the real bug: two autoPickup cycles see the same ClickUp
			// cache and both try to dispatch ticket T-1 in the same tick. The
			// registry must ensure exactly one of them "wins" the claim.
			const registry = createDispatchRegistry();

			const cycleA = claimTicket(registry, 'T-1', 'cycle-A', 'darryl-dispatch');
			const cycleB = claimTicket(registry, 'T-1', 'cycle-B', 'darryl-dispatch');

			expect([cycleA, cycleB].filter(Boolean).length).toBe(1);
			expect(registry.size).toBe(1);
			expect(getTicketClaim(registry, 'T-1')?.claimedBy).toBe('cycle-A');
		});
	});
});
