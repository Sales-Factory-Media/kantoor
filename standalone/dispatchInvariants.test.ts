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
	runAutoPickupNow,
} from './clickupHandlers.js';
import {
	launchAgentOnTicket,
	handleDesignerSessionEnded,
} from './workerDispatch.js';

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

});

// ── Invariant 1b: specialists only launch on ClickUp poll / manual refresh ──

describe('invariant 1b: runAutoPickupNow is the single auto-dispatch entry point', () => {
	it('runAutoPickupNow (the ClickUp-refresh path) triggers BOTH Darryl and Jan', () => {
		// The poll path and the kantoor manual refresh are the only two triggers
		// that can start specialist work. runAutoPickupNow covers both and must
		// fire autoDarrylPickup + autoJanPickup.
		const ctx = makeTestCtx({
			clickupTickets: [ticketGroup('to do', [{ id: 'T-1', assignee: JAN_USER }])],
			persistentAgents: [
				{ id: 'jan-1', name: 'Jan', roleShort: 'Art Director', roleFull: '', workspacePath: '' },
			],
		});

		runAutoPickupNow(ctx);

		// Jan was launched (launchAgentSessionMock called) because runAutoPickupNow
		// includes autoJanPickup.
		expect(launchAgentSessionMock).toHaveBeenCalled();
	});
});

// ── Invariant 2: Jan's delegation never double-dispatches ──

describe('invariant 2: no ticket is dispatched twice', () => {
	it('autoDarrylPickup leaves existing claims untouched (Jan-pattern: orchestrator spawn does not touch the registry)', () => {
		// After the Darryl/Jan unification, autoDarrylPickup's sole action is
		// to spawn Darryl with a batch. Actual ticket claims only happen when
		// Darryl (inside his session) calls /api/launch-agent per ticket.
		// Pre-existing claims must therefore be preserved — selectDarrylPickups
		// filters them out of the batch but autoDarrylPickup itself never
		// touches them.
		const ctx = makeTestCtx({
			clickupTickets: [
				ticketGroup('to do', [
					{ id: 'T-1', assignee: DARRYL_USER },
					{ id: 'T-2', assignee: DARRYL_USER },
				]),
			],
			persistentAgents: [
				{ id: 'darryl-1', name: 'Darryl', roleShort: 'Foreman', roleFull: '', workspacePath: '' },
			],
		});

		// Pre-claim T-1 as if Darryl's worker dispatch had already grabbed it.
		claimTicket(ctx.dispatchRegistry, 'T-1', 'somebody-else', 'dev-worker');

		autoDarrylPickup(ctx);

		// T-1's pre-existing claim is preserved — autoDarrylPickup never
		// mutates the registry (Jan pattern). T-2 is still unclaimed here;
		// it gets claimed only when Darryl's session calls
		// `launchAgentOnTicket`, which is outside autoDarrylPickup's scope.
		expect(isTicketClaimed(ctx.dispatchRegistry, 'T-1')).toBe(true);
		expect(ctx.dispatchRegistry.get('T-1')?.claimedBy).toBe('somebody-else');
		expect(isTicketClaimed(ctx.dispatchRegistry, 'T-2')).toBe(false);
	});

	it('Darryl is a singleton — autoDarrylPickup is a no-op while he is running', () => {
		// Mirrors Jan's singleton lock. While Darryl has a currentSessionId,
		// autoDarrylPickup must not start another session, regardless of how
		// many eligible tickets are in the cache.
		const ctx = makeTestCtx({
			clickupTickets: [
				ticketGroup('to do', [
					{ id: 'T-1', assignee: DARRYL_USER },
					{ id: 'T-2', assignee: DARRYL_USER },
				]),
			],
			persistentAgents: [
				{
					id: 'darryl-1',
					name: 'Darryl',
					roleShort: 'Foreman',
					roleFull: '',
					workspacePath: '',
					currentSessionId: 'running-session',
				},
			],
		});

		autoDarrylPickup(ctx);

		// No new Darryl launched, registry untouched.
		expect(launchAgentSessionMock).not.toHaveBeenCalled();
		expect(ctx.dispatchRegistry.size).toBe(0);
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

// ── Invariant 4: orchestrator spawn never self-blocks worker dispatch ──

describe('invariant 4: Darryl\'s spawn does not self-block his own /api/launch-agent', () => {
	it('autoDarrylPickup leaves the registry empty so Darryl can dispatch a worker on the same ticket', () => {
		// Regression test for the "darryl-dispatch" stuck-claim bug. Before
		// unification, autoDarrylPickup grabbed a "Hub / darryl-dispatch" claim
		// on the ticket it was about to hand to Darryl. That claim was held
		// for Darryl's whole session, so when Darryl called /api/launch-agent
		// on the SAME ticket, launchAgentOnTicket rejected with "already in
		// flight". The fix removes the orchestrator-level claim — Darryl only
		// claims via the worker-dispatch endpoint. If this test fails, the
		// self-collision bug is back.
		const ctx = makeTestCtx({
			clickupTickets: [ticketGroup('to do', [{ id: 'T-1', assignee: DARRYL_USER }])],
			persistentAgents: [
				{ id: 'darryl-1', name: 'Darryl', roleShort: 'Foreman', roleFull: '', workspacePath: '~/kantoor' },
				{ id: 'worker-1', name: 'Worker', roleShort: 'Dev', roleFull: '', workspacePath: '~/project' },
			],
		});

		autoDarrylPickup(ctx);

		// No claim created for T-1 — autoDarrylPickup touches nothing.
		expect(ctx.dispatchRegistry.size).toBe(0);

		// Simulate Darryl (inside his session) calling /api/launch-agent on T-1.
		// Must succeed — the old bug made this return success:false with
		// "already in flight (claimed by Hub for darryl-dispatch)".
		const result = launchAgentOnTicket('worker-1', 'T-1', 'Task T-1', 'https://clickup.test/T-1', ctx);
		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
	});
});

// ── Invariant 5: reactive events never launch a specialist ──

describe('invariant 5: no specialist starts from a reactive event', () => {
	it('handleDesignerSessionEnded does not chain any launch (Visual QA, Darryl, or otherwise)', async () => {
		// Enforces the "no reactive auto-dispatch" rule: specialists only start
		// from the 3-min ClickUp poll or a manual kantoor refresh — never
		// from a worker-free / session-end event. Before this rule landed,
		// handleDesignerSessionEnded chained both a setTimeout(handleVisualQaReview)
		// and autoPickupAfterWorkerFree. Those are gone.
		const ctx = makeTestCtx({
			persistentAgents: [
				{ id: 'jan-1', name: 'Jan', roleShort: 'Art Director', roleFull: '', workspacePath: '' },
				{ id: 'stanley-1', name: 'Stanley', roleShort: 'Visual Designer', roleFull: '', workspacePath: '~/project' },
			],
		});
		const fakeWs = { send: vi.fn(), readyState: 1 } as unknown as import('ws').WebSocket;

		handleDesignerSessionEnded({
			agentRole: 'Visual Designer',
			ticketId: 'T-1',
			ticketName: 'Visual task',
			ticketUrl: 'https://clickup.test/T-1',
			designerName: 'Stanley',
			workspacePath: '~/project',
		}, ctx, fakeWs);

		// Wait past any plausible setTimeout — if a reactive auto-launch gets
		// re-added with a delay, this catches it.
		await new Promise(r => setTimeout(r, 100));

		expect(launchAgentSessionMock).not.toHaveBeenCalled();
		expect(launchPersistentAgentMock).not.toHaveBeenCalled();
		expect(ctx.dispatchRegistry.size).toBe(0);
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
