import { describe, it, expect } from 'vitest';
import { selectDarrylPickups, selectJanPickups } from './pickupPlanner.js';
import type { ClickUpStatusGroup, ClickUpTask } from './clickupClient.js';

const DARRYL = 'Darryl Philbin';
const JAN = 'Jan Levinson';

function makeTask(overrides: Partial<ClickUpTask> & { id: string }): ClickUpTask {
	return {
		id: overrides.id,
		name: overrides.name ?? `Task ${overrides.id}`,
		url: overrides.url ?? `https://clickup.test/${overrides.id}`,
		parent: overrides.parent ?? null,
		assignees: overrides.assignees ?? [],
	};
}

function group(name: string, tasks: ClickUpTask[]): ClickUpStatusGroup {
	return { name, color: '#000', tasks };
}

describe('selectDarrylPickups', () => {
	it('returns empty when no tickets are assigned to Darryl', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('to do', [makeTask({ id: 'T-1', assignees: [{ username: 'someone-else' }] })]),
		];
		expect(selectDarrylPickups(tickets, new Set(), DARRYL, true)).toEqual([]);
	});

	it('picks up Darryl-assigned "to do" tickets', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('to do', [
				makeTask({ id: 'T-1', assignees: [{ username: DARRYL }] }),
				makeTask({ id: 'T-2', assignees: [{ username: 'someone-else' }] }),
			]),
		];
		const result = selectDarrylPickups(tickets, new Set(), DARRYL, true);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('T-1');
		expect(result[0].status).toBe('to do');
	});

	it('filters out tickets already in the in-flight registry', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('to do', [
				makeTask({ id: 'T-1', assignees: [{ username: DARRYL }] }),
				makeTask({ id: 'T-2', assignees: [{ username: DARRYL }] }),
			]),
		];
		const result = selectDarrylPickups(tickets, new Set(['T-1']), DARRYL, true);
		expect(result.map(t => t.id)).toEqual(['T-2']);
	});

	it('includes "ai review" tickets only when the flag is on', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('ai review', [makeTask({ id: 'T-ai', assignees: [{ username: DARRYL }] })]),
			group('to do', [makeTask({ id: 'T-1', assignees: [{ username: DARRYL }] })]),
		];
		expect(selectDarrylPickups(tickets, new Set(), DARRYL, false).map(t => t.id)).toEqual(['T-1']);
		expect(selectDarrylPickups(tickets, new Set(), DARRYL, true).map(t => t.id).sort()).toEqual(['T-1', 'T-ai']);
	});

	it('sorts ai-review before to-do when AI review is enabled', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('to do', [
				makeTask({ id: 'T-1', assignees: [{ username: DARRYL }] }),
				makeTask({ id: 'T-2', assignees: [{ username: DARRYL }] }),
			]),
			group('ai review', [
				makeTask({ id: 'T-ai-1', assignees: [{ username: DARRYL }] }),
			]),
		];
		const result = selectDarrylPickups(tickets, new Set(), DARRYL, true);
		expect(result[0].status).toBe('ai review');
		expect(result[0].id).toBe('T-ai-1');
	});

	it('ignores tickets in statuses other than "to do" / "ai review"', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('in progress', [makeTask({ id: 'T-1', assignees: [{ username: DARRYL }] })]),
			group('qa test', [makeTask({ id: 'T-2', assignees: [{ username: DARRYL }] })]),
			group('complete', [makeTask({ id: 'T-3', assignees: [{ username: DARRYL }] })]),
		];
		expect(selectDarrylPickups(tickets, new Set(), DARRYL, true)).toEqual([]);
	});

	it('is case-insensitive on the status name', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('TO DO', [makeTask({ id: 'T-1', assignees: [{ username: DARRYL }] })]),
			group('AI REVIEW', [makeTask({ id: 'T-ai', assignees: [{ username: DARRYL }] })]),
		];
		expect(selectDarrylPickups(tickets, new Set(), DARRYL, true)).toHaveLength(2);
	});
});

describe('selectJanPickups', () => {
	it('buckets Jan-owned tickets by status', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('to refine', [makeTask({ id: 'R-1', assignees: [{ username: JAN }] })]),
			group('to do', [makeTask({ id: 'T-1', assignees: [{ username: JAN }] })]),
			group('ai review', [makeTask({ id: 'A-1', assignees: [{ username: JAN }] })]),
			group('revision needed', [makeTask({ id: 'V-1', assignees: [{ username: JAN }] })]),
		];
		const buckets = selectJanPickups(tickets, new Set(), JAN, true);
		expect(buckets.refine.map(t => t.id)).toEqual(['R-1']);
		expect(buckets.todo.map(t => t.id)).toEqual(['T-1']);
		expect(buckets.aiReview.map(t => t.id)).toEqual(['A-1']);
		expect(buckets.revision.map(t => t.id)).toEqual(['V-1']);
	});

	it('includes sub-tickets whose parent Jan is assigned to', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('in progress', [makeTask({ id: 'PARENT', assignees: [{ username: JAN }] })]),
			group('to do', [makeTask({ id: 'SUB-1', parent: 'PARENT', assignees: [] })]),
		];
		const buckets = selectJanPickups(tickets, new Set(), JAN, true);
		expect(buckets.todo.map(t => t.id)).toEqual(['SUB-1']);
	});

	it('filters out tickets in the in-flight registry from every bucket', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('to do', [
				makeTask({ id: 'T-1', assignees: [{ username: JAN }] }),
				makeTask({ id: 'T-2', assignees: [{ username: JAN }] }),
			]),
			group('ai review', [
				makeTask({ id: 'A-1', assignees: [{ username: JAN }] }),
			]),
		];
		const buckets = selectJanPickups(tickets, new Set(['T-1', 'A-1']), JAN, true);
		expect(buckets.todo.map(t => t.id)).toEqual(['T-2']);
		expect(buckets.aiReview).toEqual([]);
	});

	it('omits ai-review tickets when the flag is off', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('ai review', [makeTask({ id: 'A-1', assignees: [{ username: JAN }] })]),
		];
		const buckets = selectJanPickups(tickets, new Set(), JAN, false);
		expect(buckets.aiReview).toEqual([]);
	});

	it('skips tickets Jan is not assigned to, even if they have her ID as a parent through chaining', () => {
		// Only direct-parent is inherited — not transitive chains.
		const tickets: ClickUpStatusGroup[] = [
			group('in progress', [makeTask({ id: 'GRANDPARENT', assignees: [{ username: JAN }] })]),
			group('in progress', [makeTask({ id: 'PARENT', parent: 'GRANDPARENT', assignees: [] })]),
			group('to do', [makeTask({ id: 'CHILD', parent: 'PARENT', assignees: [] })]),
		];
		const buckets = selectJanPickups(tickets, new Set(), JAN, true);
		// CHILD's parent PARENT is not in janTicketIds, so CHILD is excluded.
		expect(buckets.todo).toEqual([]);
	});

	it('returns an empty janTicketIds set when Jan has no tickets', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('to do', [makeTask({ id: 'T-1', assignees: [{ username: 'Someone Else' }] })]),
		];
		const buckets = selectJanPickups(tickets, new Set(), JAN, true);
		expect(buckets.janTicketIds.size).toBe(0);
	});

	it('exposes every Jan-assigned ticket ID via janTicketIds regardless of status', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('in progress', [makeTask({ id: 'IP-1', assignees: [{ username: JAN }] })]),
			group('complete', [makeTask({ id: 'C-1', assignees: [{ username: JAN }] })]),
			group('to do', [makeTask({ id: 'T-1', assignees: [{ username: JAN }] })]),
		];
		const buckets = selectJanPickups(tickets, new Set(), JAN, true);
		expect(buckets.janTicketIds).toEqual(new Set(['IP-1', 'C-1', 'T-1']));
	});

	it('is case-insensitive on the status name', () => {
		const tickets: ClickUpStatusGroup[] = [
			group('TO DO', [makeTask({ id: 'T-1', assignees: [{ username: JAN }] })]),
			group('REVISION NEEDED', [makeTask({ id: 'V-1', assignees: [{ username: JAN }] })]),
		];
		const buckets = selectJanPickups(tickets, new Set(), JAN, true);
		expect(buckets.todo.map(t => t.id)).toEqual(['T-1']);
		expect(buckets.revision.map(t => t.id)).toEqual(['V-1']);
	});
});

describe('selectJanPickups + registry integration (the double-dispatch fix)', () => {
	it('a concurrent cycle sees no candidates once the first cycle has claimed everything', () => {
		// Simulates the bug the refactor fixes: two autoJanPickup cycles race.
		// Cycle 1 claims T-1 and T-2 (by dispatching them). Cycle 2 then fires
		// against the same stale ClickUp cache — it must see zero candidates.
		const tickets: ClickUpStatusGroup[] = [
			group('to do', [
				makeTask({ id: 'T-1', assignees: [{ username: JAN }] }),
				makeTask({ id: 'T-2', assignees: [{ username: JAN }] }),
			]),
		];

		// Cycle 1 picks both, then claims both (simulated by adding to inFlight).
		const cycle1 = selectJanPickups(tickets, new Set(), JAN, true);
		expect(cycle1.todo).toHaveLength(2);
		const inFlightAfterCycle1 = new Set(cycle1.todo.map(t => t.id));

		// Cycle 2 must see zero candidates.
		const cycle2 = selectJanPickups(tickets, inFlightAfterCycle1, JAN, true);
		expect(cycle2.todo).toEqual([]);
		expect(cycle2.refine).toEqual([]);
		expect(cycle2.aiReview).toEqual([]);
		expect(cycle2.revision).toEqual([]);
	});
});
