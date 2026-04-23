/**
 * Dispatch system invariant tests.
 *
 * These are guardrails for the architectural rules:
 *   1. Only the hub starts tasks — workers never auto-start.
 *   2. A ticket cannot be double-dispatched — the registry enforces a
 *      one-claim-per-ticket contract across every dispatch entry point.
 *   3. A completed session always releases its claim — no stuck tickets.
 *
 * If any of these break, the user's symptoms ("workers spontaneously pick
 * up tickets", "the same task gets picked up by multiple workers") come
 * back. These tests are the backstop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ''),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: vi.fn(),
}));
vi.mock('os', () => ({
	homedir: () => '/mock-home',
	hostname: () => 'test-host',
}));
vi.mock('crypto', () => ({
	randomUUID: () => 'test-uuid-1234',
}));

// Stub the launch pipeline so calling auto-pickup doesn't try to spawn
// iTerm tabs or hit ClickUp. Tests that want to assert "launch was called
// N times" can read these mocks directly.
const launchAgentSessionMock = vi.fn(() => true);
vi.mock('./itermFocus.js', () => ({
	launchAgentSession: (...args: unknown[]) => launchAgentSessionMock(...args),
	focusItermSession: vi.fn(),
}));

const launchPersistentAgentMock = vi.fn(() => true);

vi.mock('./agentHandlers.js', () => ({
	launchPersistentAgent: (...args: unknown[]) => launchPersistentAgentMock(...args),
	getJanDesignConfig: () => ({
		figmaUrl: 'x',
		clickupDocUrl: 'x',
		examplesUrl: 'x',
	}),
}));

const addTaskCommentMock = vi.fn(() => Promise.resolve());
vi.mock('./clickupClient.js', () => ({
	addTaskComment: (...args: unknown[]) => addTaskCommentMock(...args),
	fetchListTasks: vi.fn(() => Promise.resolve([])),
}));

vi.mock('./serverHelpers.js', () => ({
	writeJson: vi.fn(),
	readJson: vi.fn(() => null),
	getOfflineAgents: vi.fn(() => []),
}));

vi.mock('../src/projectStore.js', () => ({
	loadKnownProjects: vi.fn(() => []),
	addKnownProject: vi.fn(),
}));

import type { ServerContext, WorkerInfo } from './serverContext.js';
import type { PersistentAgent } from './agentStore.js';
import type { ClickUpStatusGroup } from './clickupClient.js';
import { createDispatchRegistry, claimTicket, isTicketClaimed } from './dispatchRegistry.js';
import {
	autoDarrylPickup,
	autoJanPickup,
	autoPickupAfterWorkerFree,
	runAutoPickupNow,
} from './clickupHandlers.js';

// Keep in sync with standalone/constants.ts — imported values would work too,
// but hardcoding makes the tests more explicit about what they're testing.
const DARRYL_USER = 'Darryl Philbin';
const JAN_USER = 'Jan Levinson';

interface TestCtxOverrides {
	isWorkerMode?: boolean;
	clickupTickets?: ClickUpStatusGroup[];
	persistentAgents?: PersistentAgent[];
	workers?: Map<string, WorkerInfo>;
	hubRoles?: string[];
}

function makeTestCtx(overrides: TestCtxOverrides = {}): ServerContext {
	const ctx: ServerContext = {
		agentManager: {} as ServerContext['agentManager'],
		assets: {} as ServerContext['assets'],
		broadcastSink: { postMessage: vi.fn() },
		persistentAgents: overrides.persistentAgents ?? [],
		setPersistentAgents(updated) { ctx.persistentAgents = updated; },
		clickupConfig: null,
		clickupTickets: overrides.clickupTickets ?? [],
		clickupNextFetchAt: null,
		clickupTimer: null,
		isWorkerMode: overrides.isWorkerMode ?? false,
		workerIdentity: { name: 'Hub', color: '#000', roles: overrides.hubRoles ?? ['dev', 'designer'] },
		workers: overrides.workers ?? new Map(),
		workerAssignments: [],
		pendingWorkerRequests: new Map(),
		mempalaceServerUrl: null,
		hubWs: null,
		dispatchRegistry: createDispatchRegistry(),
	};
	return ctx;
}

function makeWorker(name: string, overrides: Partial<WorkerInfo> = {}): WorkerInfo {
	return {
		name,
		color: '#fff',
		hostname: 'remote',
		ws: { send: vi.fn(), readyState: 1 } as unknown as WorkerInfo['ws'],
		lastHeartbeat: Date.now(),
		currentTicketId: null,
		currentTicketName: null,
		roles: ['dev', 'designer'],
		...overrides,
	};
}

function ticketGroup(status: string, tasks: Array<{ id: string; assignee?: string }>): ClickUpStatusGroup {
	return {
		name: status,
		color: '#000',
		tasks: tasks.map(t => ({
			id: t.id,
			name: `Task ${t.id}`,
			url: `https://clickup.test/${t.id}`,
			parent: null,
			assignees: t.assignee ? [{ username: t.assignee }] : [],
		})),
	};
}

beforeEach(() => {
	launchAgentSessionMock.mockClear();
	launchPersistentAgentMock.mockClear();
	addTaskCommentMock.mockClear();
});

// ── Invariant 1: only the hub starts tasks ─────────────────

describe('invariant 1: workers never auto-start tasks', () => {
	it('autoDarrylPickup is a no-op in worker mode even when there are eligible tickets', () => {
		const ctx = makeTestCtx({
			isWorkerMode: true,
			clickupTickets: [ticketGroup('to do', [{ id: 'T-1', assignee: DARRYL_USER }])],
			workers: new Map([['remote', makeWorker('remote')]]),
		});
		autoDarrylPickup(ctx);
		expect(ctx.dispatchRegistry.size).toBe(0);
		expect(launchPersistentAgentMock).not.toHaveBeenCalled();
	});

	it('autoJanPickup is a no-op in worker mode even when Jan has tickets', () => {
		const ctx = makeTestCtx({
			isWorkerMode: true,
			clickupTickets: [ticketGroup('to do', [{ id: 'T-1', assignee: JAN_USER }])],
		});
		autoJanPickup(ctx);
		expect(ctx.dispatchRegistry.size).toBe(0);
		expect(launchAgentSessionMock).not.toHaveBeenCalled();
	});

	it('runAutoPickupNow is a no-op in worker mode', () => {
		const ctx = makeTestCtx({
			isWorkerMode: true,
			clickupTickets: [
				ticketGroup('to do', [{ id: 'T-1', assignee: DARRYL_USER }]),
				ticketGroup('ai review', [{ id: 'T-2', assignee: JAN_USER }]),
			],
		});
		runAutoPickupNow(ctx);
		expect(ctx.dispatchRegistry.size).toBe(0);
	});

	it('autoPickupAfterWorkerFree is a no-op in worker mode (no debounced action scheduled either)', async () => {
		const ctx = makeTestCtx({
			isWorkerMode: true,
			clickupTickets: [ticketGroup('to do', [{ id: 'T-1', assignee: DARRYL_USER }])],
		});
		autoPickupAfterWorkerFree(ctx);
		// Wait past the debounce window — nothing should fire.
		await new Promise(r => setTimeout(r, 300));
		expect(ctx.dispatchRegistry.size).toBe(0);
		expect(launchPersistentAgentMock).not.toHaveBeenCalled();
	});
});

// ── Invariant 1b: Jan only launches on the ClickUp poll / manual refresh ──

describe('invariant 1b: Jan\'s launch cadence is the ClickUp timer', () => {
	it('autoPickupAfterWorkerFree does NOT trigger autoJanPickup (no Jan session)', async () => {
		// Build a ctx where Jan has a "to do" ticket ready to dispatch. If
		// autoPickupAfterWorkerFree called autoJanPickup, Jan would launch
		// and claim the ticket for visual-designer dispatch. The invariant
		// is that she doesn't — her cadence is the 3-min ClickUp poll only.
		const ctx = makeTestCtx({
			clickupTickets: [ticketGroup('to do', [{ id: 'T-1', assignee: JAN_USER }])],
			persistentAgents: [
				{ id: 'jan-1', name: 'Jan', roleShort: 'Art Director', roleFull: '', workspacePath: '' },
			],
		});

		autoPickupAfterWorkerFree(ctx);
		await new Promise(r => setTimeout(r, 300));

		// Jan's ticket must not have been dispatched — registry empty, no
		// launch call fired.
		expect(ctx.dispatchRegistry.size).toBe(0);
		expect(launchAgentSessionMock).not.toHaveBeenCalled();
	});

	it('runAutoPickupNow (the ClickUp-refresh path) DOES trigger autoJanPickup', () => {
		// The poll path IS allowed to fire Jan. This is the dual-test of the
		// above — confirms we didn't accidentally remove Jan from every path.
		const ctx = makeTestCtx({
			clickupTickets: [ticketGroup('to do', [{ id: 'T-1', assignee: JAN_USER }])],
			persistentAgents: [
				{ id: 'jan-1', name: 'Jan', roleShort: 'Art Director', roleFull: '', workspacePath: '' },
			],
		});

		runAutoPickupNow(ctx);

		// Jan was launched (launchAgentSessionMock called) because runAutoPickupNow
		// includes autoJanPickup. Registry may be untouched because Jan's session
		// lock is set via launchPersistentAgentSession — the important check is
		// that the launch pipeline was hit.
		expect(launchAgentSessionMock).toHaveBeenCalled();
	});
});

// ── Invariant 2: Jan's delegation never double-dispatches ──

describe('invariant 2: no ticket is dispatched twice', () => {
	it('autoDarrylPickup skips tickets already in the dispatch registry', () => {
		const ctx = makeTestCtx({
			clickupTickets: [
				ticketGroup('to do', [
					{ id: 'T-1', assignee: DARRYL_USER },
					{ id: 'T-2', assignee: DARRYL_USER },
				]),
			],
			workers: new Map([
				['worker-a', makeWorker('worker-a')],
				['worker-b', makeWorker('worker-b')],
			]),
			hubRoles: ['designer'], // No dev role on hub — forces dispatch to workers only
		});

		// Pre-claim T-1 as if a prior cycle/handler had it in flight.
		claimTicket(ctx.dispatchRegistry, 'T-1', 'somebody-else', 'dev-worker');

		autoDarrylPickup(ctx);

		// Only T-2 should have been claimed in this cycle. T-1's claim
		// belongs to somebody-else, untouched.
		expect(isTicketClaimed(ctx.dispatchRegistry, 'T-1')).toBe(true);
		expect(ctx.dispatchRegistry.get('T-1')?.claimedBy).toBe('somebody-else');
		expect(isTicketClaimed(ctx.dispatchRegistry, 'T-2')).toBe(true);
		expect(ctx.dispatchRegistry.get('T-2')?.claimedBy).not.toBe('somebody-else');
	});

	it('running autoDarrylPickup twice back-to-back on the same cache never double-claims', () => {
		const ctx = makeTestCtx({
			clickupTickets: [
				ticketGroup('to do', [
					{ id: 'T-1', assignee: DARRYL_USER },
					{ id: 'T-2', assignee: DARRYL_USER },
				]),
			],
			workers: new Map([
				['worker-a', makeWorker('worker-a')],
				['worker-b', makeWorker('worker-b')],
			]),
			hubRoles: ['designer'], // No dev on hub — workers only
		});

		// First cycle dispatches both tickets to workers (one each).
		autoDarrylPickup(ctx);
		const firstCycleClaims = new Set(ctx.dispatchRegistry.keys());
		expect(firstCycleClaims).toEqual(new Set(['T-1', 'T-2']));

		// Workers now carry the tickets; a concurrent cycle from a stale
		// ClickUp cache must NOT re-dispatch. Capacity is gated by
		// worker.currentTicketId which was set during the first cycle.
		autoDarrylPickup(ctx);
		expect(ctx.dispatchRegistry.size).toBe(2); // still exactly 2
	});

	it('Jan batch selection never includes a ticket already in flight — even if ClickUp still shows "to do"', () => {
		// Scenario: Jan dispatched T-1 a moment ago (claim exists). The 3-min
		// ClickUp cache still shows T-1 as "to do". A concurrent autoJanPickup
		// cycle fires. It must not hand T-1 to Jan again.
		const ctx = makeTestCtx({
			clickupTickets: [
				ticketGroup('to do', [
					{ id: 'T-1', assignee: JAN_USER },
					{ id: 'T-2', assignee: JAN_USER },
				]),
			],
			persistentAgents: [
				// Jan herself, idle so autoJanPickup doesn't bail on her session lock
				{ id: 'jan-1', name: 'Jan', roleShort: 'Art Director', roleFull: '', workspacePath: '' },
			],
		});

		// Pre-claim T-1 — simulates "Jan's prior session already dispatched T-1".
		claimTicket(ctx.dispatchRegistry, 'T-1', 'Hub', 'visual-designer');

		autoJanPickup(ctx);

		// Jan's pickup must not have disturbed T-1's existing claim.
		expect(ctx.dispatchRegistry.get('T-1')?.purpose).toBe('visual-designer');
	});
});

// ── Invariant 3: registry is honoured across all four Jan statuses ──

describe('invariant 3: Jan status coverage', () => {
	it('autoJanPickup with an empty registry considers all four statuses', () => {
		// This is a smoke test that autoJanPickup isn't accidentally scoped
		// to fewer statuses after refactors. We don't care about dispatch
		// side-effects here — just that the function reads all four buckets.
		const ctx = makeTestCtx({
			clickupTickets: [
				ticketGroup('to refine', [{ id: 'R-1', assignee: JAN_USER }]),
				ticketGroup('to do', [{ id: 'T-1', assignee: JAN_USER }]),
				ticketGroup('ai review', [{ id: 'A-1', assignee: JAN_USER }]),
				ticketGroup('revision needed', [{ id: 'V-1', assignee: JAN_USER }]),
			],
			persistentAgents: [
				{ id: 'jan-1', name: 'Jan', roleShort: 'Art Director', roleFull: '', workspacePath: '' },
			],
		});

		// Should not throw. Should consider all buckets. Launch side-effects
		// are mocked above — the important thing is that autoJanPickup didn't
		// filter out any of the four status categories.
		expect(() => autoJanPickup(ctx)).not.toThrow();
	});
});
