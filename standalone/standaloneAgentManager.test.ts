import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MessageSink } from '../src/types.js';

vi.mock('fs', () => ({
	existsSync: vi.fn(() => false),
	statSync: vi.fn(),
	openSync: vi.fn(),
	readSync: vi.fn(),
	closeSync: vi.fn(),
	watchFile: vi.fn(),
	unwatchFile: vi.fn(),
	watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
}));

vi.mock('os', () => ({
	homedir: () => '/mock-home',
}));

vi.mock('../src/fileWatcher.js', () => ({
	startFileWatching: vi.fn(),
}));

vi.mock('../src/timerManager.js', () => ({
	cancelWaitingTimer: vi.fn(),
	cancelPermissionTimer: vi.fn(),
}));

import { StandaloneAgentManager } from './standaloneAgentManager.js';
import { startFileWatching } from '../src/fileWatcher.js';
import { cancelWaitingTimer, cancelPermissionTimer } from '../src/timerManager.js';

function makeMockSink(): MessageSink & { messages: unknown[] } {
	const messages: unknown[] = [];
	return {
		messages,
		postMessage(msg: unknown) { messages.push(msg); },
	};
}

describe('StandaloneAgentManager', () => {
	let manager: StandaloneAgentManager;
	let sink: ReturnType<typeof makeMockSink>;

	beforeEach(() => {
		vi.clearAllMocks();
		manager = new StandaloneAgentManager();
		sink = makeMockSink();
		manager.setSink(sink);
	});

	describe('addSession', () => {
		it('creates an agent with incrementing IDs', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/session1.jsonl', 'my-project');
			manager.addSession('/projects/hash2', '/projects/hash2/session2.jsonl', 'other-project');

			expect(manager.agents.size).toBe(2);
			expect(manager.getExistingAgentIds()).toEqual([1, 2]);
		});

		it('sends agentCreated message to sink', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/abc-123.jsonl', 'my-project');

			const msg = sink.messages.find((m: any) => m.type === 'agentCreated') as any;
			expect(msg).toBeDefined();
			expect(msg.id).toBe(1);
			expect(msg.sessionId).toBe('abc-123');
			expect(msg.folderName).toBe('my-project');
		});

		it('does not add duplicate sessions for the same file', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/session.jsonl', 'proj');
			manager.addSession('/projects/hash1', '/projects/hash1/session.jsonl', 'proj');

			expect(manager.agents.size).toBe(1);
		});

		it('starts file watching on the jsonl file', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/session.jsonl', 'proj');

			expect(startFileWatching).toHaveBeenCalledWith(
				1,
				'/projects/hash1/session.jsonl',
				manager.agents,
				manager.fileWatchers,
				manager.pollingTimers,
				manager.waitingTimers,
				manager.permissionTimers,
				expect.anything(), // delegating sink
			);
		});

		it('stores workspace path and persistent agent ID when provided', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/s.jsonl', 'proj', '/actual/workspace', 'persistent-id-1');

			const agent = manager.agents.get(1);
			expect(agent?.workspacePath).toBe('/actual/workspace');
			expect(agent?.persistentAgentId).toBe('persistent-id-1');
		});

		it('includes agent meta in agentCreated message', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/s.jsonl', 'proj', undefined, undefined, {
				name: 'Dwight',
				roleShort: 'Dev',
			});

			const msg = sink.messages.find((m: any) => m.type === 'agentCreated') as any;
			expect(msg.name).toBe('Dwight');
			expect(msg.roleShort).toBe('Dev');
		});
	});

	describe('removeSession', () => {
		it('removes agent and sends agentClosed message', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/session.jsonl', 'proj');
			expect(manager.agents.size).toBe(1);

			manager.removeSession('/projects/hash1/session.jsonl');

			expect(manager.agents.size).toBe(0);
			const msg = sink.messages.find((m: any) => m.type === 'agentClosed') as any;
			expect(msg).toBeDefined();
			expect(msg.id).toBe(1);
		});

		it('does nothing for unknown files', () => {
			manager.removeSession('/unknown/file.jsonl');
			expect(sink.messages).toHaveLength(0);
		});

		it('cancels waiting and permission timers', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/session.jsonl', 'proj');
			manager.removeSession('/projects/hash1/session.jsonl');

			expect(cancelWaitingTimer).toHaveBeenCalledWith(1, manager.waitingTimers);
			expect(cancelPermissionTimer).toHaveBeenCalledWith(1, manager.permissionTimers);
		});
	});

	describe('hasSession', () => {
		it('returns true for tracked files', () => {
			manager.addSession('/projects/hash1', '/projects/hash1/session.jsonl', 'proj');
			expect(manager.hasSession('/projects/hash1/session.jsonl')).toBe(true);
		});

		it('returns false for untracked files', () => {
			expect(manager.hasSession('/unknown/file.jsonl')).toBe(false);
		});
	});

	describe('getSessionIds', () => {
		it('returns map of agent ID to session ID', () => {
			manager.addSession('/p/h1', '/p/h1/aaa-111.jsonl', 'proj1');
			manager.addSession('/p/h2', '/p/h2/bbb-222.jsonl', 'proj2');

			const ids = manager.getSessionIds();
			expect(ids).toEqual({ 1: 'aaa-111', 2: 'bbb-222' });
		});
	});

	describe('getSessionIdForAgent', () => {
		it('returns session ID for a valid agent', () => {
			manager.addSession('/p/h1', '/p/h1/abc-123.jsonl', 'proj');
			expect(manager.getSessionIdForAgent(1)).toBe('abc-123');
		});

		it('returns null for unknown agent ID', () => {
			expect(manager.getSessionIdForAgent(999)).toBeNull();
		});
	});

	describe('getLiveSessionIds', () => {
		it('returns all tracked session IDs as a Set', () => {
			manager.addSession('/p/h1', '/p/h1/aaa.jsonl', 'proj1');
			manager.addSession('/p/h2', '/p/h2/bbb.jsonl', 'proj2');

			const ids = manager.getLiveSessionIds();
			expect(ids).toBeInstanceOf(Set);
			expect(ids.size).toBe(2);
			expect(ids.has('aaa')).toBe(true);
			expect(ids.has('bbb')).toBe(true);
		});

		it('returns empty set when no agents are tracked', () => {
			const ids = manager.getLiveSessionIds();
			expect(ids.size).toBe(0);
		});
	});

	describe('sendAgentStatuses', () => {
		it('sends waiting status for waiting agents', () => {
			manager.addSession('/p/h1', '/p/h1/session.jsonl', 'proj');
			const agent = manager.agents.get(1)!;
			agent.isWaiting = true;

			const clientSink = makeMockSink();
			manager.sendAgentStatuses(clientSink);

			const waitingMsg = clientSink.messages.find((m: any) => m.type === 'agentStatus') as any;
			expect(waitingMsg).toBeDefined();
			expect(waitingMsg.id).toBe(1);
			expect(waitingMsg.status).toBe('waiting');
		});

		it('sends active tool statuses', () => {
			manager.addSession('/p/h1', '/p/h1/session.jsonl', 'proj');
			const agent = manager.agents.get(1)!;
			agent.activeToolStatuses.set('tool-1', 'Reading file...');

			const clientSink = makeMockSink();
			manager.sendAgentStatuses(clientSink);

			const toolMsg = clientSink.messages.find((m: any) => m.type === 'agentToolStart') as any;
			expect(toolMsg).toBeDefined();
			expect(toolMsg.id).toBe(1);
			expect(toolMsg.toolId).toBe('tool-1');
			expect(toolMsg.status).toBe('Reading file...');
		});
	});

	describe('setSink', () => {
		it('broadcasts to newly set sink', () => {
			const newSink = makeMockSink();
			manager.setSink(newSink);
			manager.addSession('/p/h1', '/p/h1/s.jsonl', 'proj');

			expect(newSink.messages.length).toBeGreaterThan(0);
		});

		it('stops broadcasting to old sink after replacement', () => {
			const oldSink = makeMockSink();
			const newSink = makeMockSink();
			manager.setSink(oldSink);
			manager.setSink(newSink);
			manager.addSession('/p/h1', '/p/h1/s.jsonl', 'proj');

			expect(newSink.messages.length).toBeGreaterThan(0);
			// Old sink should not receive new messages after being replaced
			expect(oldSink.messages).toHaveLength(0);
		});
	});
});
