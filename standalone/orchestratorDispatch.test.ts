/**
 * Direct tests for the shared orchestrator batch dispatch helper.
 *
 * These tests hit `dispatchOrchestratorBatch` with a fake `OrchestratorBatchSpec`
 * and assert its contract: when the spec's callbacks get invoked, in what order,
 * with what arguments. The existing dispatchInvariants tests cover the helper
 * transitively via Darryl/Jan wrappers; this file locks in the helper's internal
 * contract so it can evolve independently from the wrappers.
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

// Mock the launch pipeline at the launchHelpers boundary — the helper's
// contract is "build prompt + task, then call launchPersistentAgentSession
// with these specific args". Mocking one level deeper (itermFocus) would
// have us asserting launchPersistentAgentSession's internals, not the
// helper's.
const launchPersistentAgentSessionMock = vi.fn(() => ({ success: true as const }));
vi.mock('./launchHelpers.js', async () => {
	const actual = await vi.importActual<typeof import('./launchHelpers.js')>('./launchHelpers.js');
	return {
		...actual,
		launchPersistentAgentSession: (...args: unknown[]) => launchPersistentAgentSessionMock(...args),
	};
});

vi.mock('./agentHandlers.js', () => ({
	launchPersistentAgent: vi.fn(() => true),
	getJanDesignConfig: () => ({ figmaUrl: 'x', clickupDocUrl: 'x', examplesUrl: 'x' }),
}));

vi.mock('./serverHelpers.js', () => ({
	writeJson: vi.fn(),
	readJson: vi.fn(() => null),
	getOfflineAgents: vi.fn(() => []),
}));

vi.mock('../src/projectStore.js', () => ({
	loadKnownProjects: vi.fn(() => [
		{ name: 'known-project', description: 'a test project' },
	]),
	addKnownProject: vi.fn(),
}));

import type { ServerContext } from './serverContext.js';
import type { PersistentAgent } from './agentStore.js';
import {
	dispatchOrchestratorBatch,
	buildRoster,
	findOrCreatePersistentAgent,
	type OrchestratorBatchSpec,
} from './orchestratorDispatch.js';
import { createDispatchRegistry } from './dispatchRegistry.js';
import { EXIT_REMINDER } from './launchHelpers.js';
import type { TicketInfo } from './launchHelpers.js';

function makeCtx(persistentAgents: PersistentAgent[] = []): ServerContext {
	const ctx: ServerContext = {
		agentManager: {} as ServerContext['agentManager'],
		assets: {} as ServerContext['assets'],
		broadcastSink: { postMessage: vi.fn() },
		persistentAgents,
		setPersistentAgents(updated) { ctx.persistentAgents = updated; },
		clickupConfig: null,
		clickupTickets: [],
		clickupNextFetchAt: null,
		clickupTimer: null,
		isWorkerMode: false,
		workerIdentity: { name: 'Hub', color: '#000', roles: ['dev', 'designer'] },
		noLocalDev: false,
		workers: new Map(),
		workerAssignments: [],
		pendingWorkerRequests: new Map(),
		mempalaceServerUrl: null,
		hubWs: null,
		dispatchRegistry: createDispatchRegistry(),
	};
	return ctx;
}

function makeBatch(
	ids: string[],
): Array<TicketInfo & { status: 'to do' }> {
	return ids.map(id => ({
		ticketId: id,
		ticketName: `Task ${id}`,
		ticketUrl: `https://clickup.test/${id}`,
		status: 'to do' as const,
	}));
}

function makeSpec(overrides: Partial<OrchestratorBatchSpec<'to do'>> = {}): {
	spec: OrchestratorBatchSpec<'to do'>;
	agent: PersistentAgent;
	ensureAgentMock: ReturnType<typeof vi.fn>;
	buildSystemPromptMock: ReturnType<typeof vi.fn>;
	buildInitialTaskMock: ReturnType<typeof vi.fn>;
} {
	const agent: PersistentAgent = {
		id: 'agent-under-test',
		name: 'Testo',
		roleShort: 'Tester',
		roleFull: 'Runs the test suite',
		workspacePath: '~/whatever',
	};
	const ensureAgentMock = vi.fn(() => agent);
	const buildSystemPromptMock = vi.fn(() => 'SYSTEM_PROMPT_BODY');
	const buildInitialTaskMock = vi.fn(() => 'INITIAL_TASK_BODY');
	const spec: OrchestratorBatchSpec<'to do'> = {
		name: 'Testo',
		ensureAgent: ensureAgentMock,
		buildSystemPrompt: buildSystemPromptMock,
		buildInitialTask: buildInitialTaskMock,
		...overrides,
	};
	return { spec, agent, ensureAgentMock, buildSystemPromptMock, buildInitialTaskMock };
}

beforeEach(() => {
	launchPersistentAgentSessionMock.mockClear();
	launchPersistentAgentSessionMock.mockReturnValue({ success: true });
});

// ── dispatchOrchestratorBatch ──────────────────────────────

describe('dispatchOrchestratorBatch', () => {
	it('is a no-op on an empty batch — none of the spec callbacks fire', () => {
		const { spec, ensureAgentMock, buildSystemPromptMock, buildInitialTaskMock } = makeSpec();
		const ctx = makeCtx();

		dispatchOrchestratorBatch(spec, [], ctx);

		expect(ensureAgentMock).not.toHaveBeenCalled();
		expect(buildSystemPromptMock).not.toHaveBeenCalled();
		expect(buildInitialTaskMock).not.toHaveBeenCalled();
		expect(launchPersistentAgentSessionMock).not.toHaveBeenCalled();
	});

	it('bails when the orchestrator already has a currentSessionId — does NOT call build* or launch', () => {
		const { spec, agent, ensureAgentMock, buildSystemPromptMock, buildInitialTaskMock } = makeSpec();
		agent.currentSessionId = 'already-running';
		const ctx = makeCtx([agent]);

		dispatchOrchestratorBatch(spec, makeBatch(['T-1']), ctx);

		expect(ensureAgentMock).toHaveBeenCalledOnce();
		// Singleton gate fires BEFORE any build work — these must not run.
		expect(buildSystemPromptMock).not.toHaveBeenCalled();
		expect(buildInitialTaskMock).not.toHaveBeenCalled();
		expect(launchPersistentAgentSessionMock).not.toHaveBeenCalled();
	});

	it('on happy path calls spec callbacks in the contract order: ensureAgent → buildSystemPrompt → buildInitialTask → launch', () => {
		const callOrder: string[] = [];
		const { spec, agent } = makeSpec({
			ensureAgent: vi.fn((pa) => {
				callOrder.push('ensureAgent');
				const a: PersistentAgent = {
					id: 'agent-under-test', name: 'Testo', roleShort: 'Tester',
					roleFull: 'Runs the test suite', workspacePath: '~/whatever',
				};
				pa.push(a);
				return a;
			}),
			buildSystemPrompt: vi.fn(() => { callOrder.push('buildSystemPrompt'); return 'SP'; }),
			buildInitialTask: vi.fn(() => { callOrder.push('buildInitialTask'); return 'IT'; }),
		});
		launchPersistentAgentSessionMock.mockImplementation(() => {
			callOrder.push('launch');
			return { success: true };
		});
		const ctx = makeCtx();
		void agent; // agent object used only for typing; ensureAgent builds its own inside

		dispatchOrchestratorBatch(spec, makeBatch(['T-1']), ctx);

		expect(callOrder).toEqual(['ensureAgent', 'buildSystemPrompt', 'buildInitialTask', 'launch']);
	});

	it('maps batch TicketInfo keys to the shape buildInitialTask expects (id/name/url/status)', () => {
		const { spec, buildInitialTaskMock } = makeSpec();
		const ctx = makeCtx();

		dispatchOrchestratorBatch(spec, makeBatch(['T-1', 'T-2']), ctx);

		expect(buildInitialTaskMock).toHaveBeenCalledWith([
			{ id: 'T-1', name: 'Task T-1', url: 'https://clickup.test/T-1', status: 'to do' },
			{ id: 'T-2', name: 'Task T-2', url: 'https://clickup.test/T-2', status: 'to do' },
		]);
	});

	it('appends EXIT_REMINDER to the initial-task body produced by the spec', () => {
		const { spec, buildInitialTaskMock } = makeSpec();
		buildInitialTaskMock.mockReturnValueOnce('BODY_OUT');
		const ctx = makeCtx();

		dispatchOrchestratorBatch(spec, makeBatch(['T-1']), ctx);

		const [, , initialTaskArg] = launchPersistentAgentSessionMock.mock.calls[0];
		expect(initialTaskArg).toBe('BODY_OUT' + EXIT_REMINDER);
	});

	it('passes the first batch ticket (NOT a later one) to launchPersistentAgentSession for UI-label tracking', () => {
		const { spec } = makeSpec();
		const ctx = makeCtx();

		dispatchOrchestratorBatch(spec, makeBatch(['T-1', 'T-2', 'T-3']), ctx);

		const [, , , firstArg] = launchPersistentAgentSessionMock.mock.calls[0];
		expect(firstArg).toEqual({
			ticketId: 'T-1',
			ticketName: 'Task T-1',
			ticketUrl: 'https://clickup.test/T-1',
			status: 'to do',
		});
	});

	it('passes the agent returned by ensureAgent + the output of buildSystemPrompt to launch', () => {
		const { spec, agent, buildSystemPromptMock } = makeSpec();
		buildSystemPromptMock.mockReturnValueOnce('CUSTOM_PROMPT');
		const ctx = makeCtx();

		dispatchOrchestratorBatch(spec, makeBatch(['T-1']), ctx);

		const [agentArg, promptArg] = launchPersistentAgentSessionMock.mock.calls[0];
		expect(agentArg).toBe(agent);
		expect(promptArg).toBe('CUSTOM_PROMPT');
	});

	it('never claims tickets in the dispatch registry — claim ownership belongs to worker dispatch endpoints', () => {
		// This is the architectural invariant that unblocked Darryl from
		// self-colliding with his own /api/launch-agent. If this ever starts
		// failing, someone has reintroduced an orchestrator-level claim inside
		// the shared helper.
		const { spec } = makeSpec();
		const ctx = makeCtx();

		dispatchOrchestratorBatch(spec, makeBatch(['T-1', 'T-2']), ctx);

		expect(ctx.dispatchRegistry.size).toBe(0);
	});

	it('logs a failure message but does NOT throw when launch returns success:false', () => {
		const { spec } = makeSpec();
		const ctx = makeCtx();
		launchPersistentAgentSessionMock.mockReturnValueOnce({ success: false });
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		expect(() => dispatchOrchestratorBatch(spec, makeBatch(['T-1']), ctx)).not.toThrow();
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to launch Testo batch of 1'));

		logSpy.mockRestore();
	});
});

// ── buildRoster ────────────────────────────────────────────

describe('buildRoster', () => {
	it('excludes the given agent id and marks the rest by isOnline based on currentSessionId', () => {
		const agents: PersistentAgent[] = [
			{ id: 'a', name: 'A', roleShort: 'Alpha', roleFull: '', workspacePath: '~/known-project' },
			{ id: 'b', name: 'B', roleShort: 'Beta', roleFull: '', workspacePath: '~/unknown-project', currentSessionId: 'session-b' },
			{ id: 'c', name: 'C', roleShort: 'Gamma', roleFull: '', workspacePath: '~/known-project' },
		];

		const roster = buildRoster(agents, 'b');

		expect(roster.map(r => r.id).sort()).toEqual(['a', 'c']);
		expect(roster.find(r => r.id === 'a')?.isOnline).toBe(false);
		// All entries missing from the result set (like 'b') are correctly excluded.
	});

	it('enriches entries with the known-project description when the workspace basename matches', () => {
		const agents: PersistentAgent[] = [
			{ id: 'a', name: 'A', roleShort: 'Alpha', roleFull: '', workspacePath: '/abs/path/known-project' },
			{ id: 'b', name: 'B', roleShort: 'Beta', roleFull: '', workspacePath: '~/Projects/mystery' },
		];

		const roster = buildRoster(agents, 'z');

		expect(roster.find(r => r.id === 'a')?.projectDescription).toBe('a test project');
		expect(roster.find(r => r.id === 'b')?.projectDescription).toBeUndefined();
		expect(roster.find(r => r.id === 'b')?.projectName).toBe('mystery');
	});
});

// ── findOrCreatePersistentAgent ────────────────────────────

describe('findOrCreatePersistentAgent', () => {
	it('returns the existing agent when one with the given name is already in the list', () => {
		const existing: PersistentAgent = {
			id: 'existing', name: 'Darryl', roleShort: 'Foreman',
			roleFull: 'The Foreman', workspacePath: '~/kantoor',
		};
		const agents = [existing];

		const result = findOrCreatePersistentAgent(agents, 'Darryl', 'Foreman', 'The Foreman', '~/kantoor');

		expect(result).toBe(existing);
		expect(agents).toHaveLength(1);
	});

	it('creates a new agent (appended to the list) when none exists with that name', () => {
		const agents: PersistentAgent[] = [];

		const result = findOrCreatePersistentAgent(agents, 'Jan', 'Art Director', 'The Art Director', '~/office');

		expect(result.name).toBe('Jan');
		expect(result.roleShort).toBe('Art Director');
		expect(result.workspacePath).toBe('~/office');
		expect(agents).toHaveLength(1);
		expect(agents[0]).toBe(result);
	});
});
