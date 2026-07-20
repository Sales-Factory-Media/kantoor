import { describe, it, expect } from 'vitest';
import {
	createDelegationStore,
	addPendingDelegation,
	getPendingDelegation,
	getPendingDelegations,
	removePendingDelegation,
	hasPendingDelegation,
	pendingDelegationIds,
	postponeDelegation,
	delegationExcludeSet,
	type PendingDelegation,
} from './delegationStore.js';

function makeDelegation(overrides: Partial<PendingDelegation> & { ticketId: string }): PendingDelegation {
	return {
		ticketId: overrides.ticketId,
		ticketName: overrides.ticketName ?? `Ticket ${overrides.ticketId}`,
		ticketUrl: overrides.ticketUrl ?? `https://clickup.test/${overrides.ticketId}`,
		recommendedAgentId: overrides.recommendedAgentId ?? 'agent-1',
		recommendedAgentName: overrides.recommendedAgentName ?? 'Pam',
		recommendedAgentRole: overrides.recommendedAgentRole ?? 'Frontend Dev',
		recommendedWorkspacePath: overrides.recommendedWorkspacePath ?? '~/Projects/foo',
		reasoning: overrides.reasoning ?? 'best fit',
		brief: overrides.brief ?? 'do the thing',
		createdAt: overrides.createdAt ?? 1000,
		lastEvaluatedAt: overrides.lastEvaluatedAt ?? overrides.createdAt ?? 1000,
		ticketUpdatedAt: overrides.ticketUpdatedAt,
		postponedUntil: overrides.postponedUntil,
	};
}

describe('delegationStore', () => {
	it('adds and reads back a delegation', () => {
		const store = createDelegationStore();
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-1' }));
		expect(hasPendingDelegation(store, 'T-1')).toBe(true);
		expect(getPendingDelegation(store, 'T-1')?.recommendedAgentName).toBe('Pam');
	});

	it('ignores an empty ticketId', () => {
		const store = createDelegationStore();
		addPendingDelegation(store, makeDelegation({ ticketId: '' }));
		expect(store.size).toBe(0);
	});

	it('replaces a delegation for the same ticket', () => {
		const store = createDelegationStore();
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-1', recommendedAgentName: 'Pam' }));
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-1', recommendedAgentName: 'Jim' }));
		expect(store.size).toBe(1);
		expect(getPendingDelegation(store, 'T-1')?.recommendedAgentName).toBe('Jim');
	});

	it('removes a delegation idempotently', () => {
		const store = createDelegationStore();
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-1' }));
		expect(removePendingDelegation(store, 'T-1')).toBe(true);
		expect(removePendingDelegation(store, 'T-1')).toBe(false);
		expect(hasPendingDelegation(store, 'T-1')).toBe(false);
	});

	it('lists delegations oldest first', () => {
		const store = createDelegationStore();
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-2', createdAt: 2000 }));
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-1', createdAt: 1000 }));
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-3', createdAt: 3000 }));
		expect(getPendingDelegations(store).map(d => d.ticketId)).toEqual(['T-1', 'T-2', 'T-3']);
	});

	it('snapshots pending ids for auto-pickup filtering', () => {
		const store = createDelegationStore();
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-1' }));
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-2' }));
		expect(pendingDelegationIds(store)).toEqual(new Set(['T-1', 'T-2']));
	});

	it('postpones an existing delegation and no-ops on a missing one', () => {
		const store = createDelegationStore();
		addPendingDelegation(store, makeDelegation({ ticketId: 'T-1' }));
		expect(postponeDelegation(store, 'T-1', 5000)?.postponedUntil).toBe(5000);
		expect(getPendingDelegation(store, 'T-1')?.postponedUntil).toBe(5000);
		expect(postponeDelegation(store, 'missing', 5000)).toBeUndefined();
	});

	describe('delegationExcludeSet', () => {
		it('excludes tickets that have not changed since evaluation', () => {
			const store = createDelegationStore();
			addPendingDelegation(store, makeDelegation({ ticketId: 'T-1', ticketUpdatedAt: 100 }));
			// live date_updated equals evaluated snapshot → still excluded.
			const exclude = delegationExcludeSet(store, () => 100);
			expect(exclude).toEqual(new Set(['T-1']));
		});

		it('drops a ticket updated after it was evaluated (eligible for re-eval)', () => {
			const store = createDelegationStore();
			addPendingDelegation(store, makeDelegation({ ticketId: 'T-1', ticketUpdatedAt: 100 }));
			addPendingDelegation(store, makeDelegation({ ticketId: 'T-2', ticketUpdatedAt: 100 }));
			const exclude = delegationExcludeSet(store, (id) => (id === 'T-1' ? 200 : 100));
			expect(exclude).toEqual(new Set(['T-2']));
		});

		it('keeps excluding when there is no live update signal', () => {
			const store = createDelegationStore();
			addPendingDelegation(store, makeDelegation({ ticketId: 'T-1', ticketUpdatedAt: 100 }));
			addPendingDelegation(store, makeDelegation({ ticketId: 'T-2' })); // no snapshot at all
			const exclude = delegationExcludeSet(store, () => undefined);
			expect(exclude).toEqual(new Set(['T-1', 'T-2']));
		});
	});
});
