import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import type { PersistentAgent } from './agentStore.js';
import type { StandaloneAgentManager } from './standaloneAgentManager.js';

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock('os', () => ({
	homedir: () => '/mock-home',
}));

import { readJson, writeJson, getOfflineAgents, buildNewWorkerPopup, buildIdentityPrompt } from './serverHelpers.js';

const mockFs = vi.mocked(fs);

function makeAgent(overrides: Partial<PersistentAgent> = {}): PersistentAgent {
	return {
		id: 'agent-1',
		name: 'Dwight',
		roleShort: 'Assistant',
		roleFull: 'Assistant to the Regional Manager',
		workspacePath: '/projects/beets',
		...overrides,
	};
}

function makeMockAgentManager(liveSessionIds: string[]): StandaloneAgentManager {
	return {
		getLiveSessionIds: () => new Set(liveSessionIds),
	} as unknown as StandaloneAgentManager;
}

describe('readJson', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns null when file does not exist', () => {
		mockFs.existsSync.mockReturnValue(false);
		expect(readJson('/some/path.json')).toBeNull();
	});

	it('returns parsed JSON when file exists', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('{"key": "value"}');
		const result = readJson('/some/path.json');
		expect(result).toEqual({ key: 'value' });
	});

	it('returns null on invalid JSON', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue('not valid json');
		expect(readJson('/some/path.json')).toBeNull();
	});

	it('returns null on read error', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation(() => { throw new Error('read error'); });
		expect(readJson('/some/path.json')).toBeNull();
	});
});

describe('writeJson', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('creates settings directory if it does not exist', () => {
		mockFs.existsSync.mockReturnValue(false);
		writeJson('/mock-home/.pixel-agents/test.json', { foo: 'bar' });
		expect(mockFs.mkdirSync).toHaveBeenCalledWith('/mock-home/.pixel-agents', { recursive: true, mode: 0o700 });
	});

	it('does not create directory if it already exists', () => {
		mockFs.existsSync.mockReturnValue(true);
		writeJson('/mock-home/.pixel-agents/test.json', { foo: 'bar' });
		expect(mockFs.mkdirSync).not.toHaveBeenCalled();
	});

	it('writes formatted JSON to file', () => {
		mockFs.existsSync.mockReturnValue(true);
		const data = { hello: 'world', num: 42 };
		writeJson('/some/file.json', data);
		expect(mockFs.writeFileSync).toHaveBeenCalledWith(
			'/some/file.json',
			JSON.stringify(data, null, 2),
			{ encoding: 'utf-8', mode: 0o600 },
		);
	});

	it('does not throw on write error', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.writeFileSync.mockImplementation(() => { throw new Error('write error'); });
		// Should not throw
		expect(() => writeJson('/some/file.json', {})).not.toThrow();
	});
});

describe('getOfflineAgents', () => {
	it('returns all persistent agents when none are live', () => {
		const agents = [
			makeAgent({ id: 'a1', name: 'Dwight', currentSessionId: 'session-1' }),
			makeAgent({ id: 'a2', name: 'Jim', currentSessionId: 'session-2' }),
		];
		const manager = makeMockAgentManager([]);
		const offline = getOfflineAgents(manager, agents);
		expect(offline).toHaveLength(2);
		expect(offline.map(a => a.name)).toEqual(['Dwight', 'Jim']);
	});

	it('excludes agents whose session is currently live', () => {
		const agents = [
			makeAgent({ id: 'a1', name: 'Dwight', currentSessionId: 'session-1' }),
			makeAgent({ id: 'a2', name: 'Jim', currentSessionId: 'session-2' }),
		];
		const manager = makeMockAgentManager(['session-1']);
		const offline = getOfflineAgents(manager, agents);
		expect(offline).toHaveLength(1);
		expect(offline[0].name).toBe('Jim');
	});

	it('returns empty array when all agents are live', () => {
		const agents = [
			makeAgent({ id: 'a1', currentSessionId: 'session-1' }),
			makeAgent({ id: 'a2', currentSessionId: 'session-2' }),
		];
		const manager = makeMockAgentManager(['session-1', 'session-2']);
		const offline = getOfflineAgents(manager, agents);
		expect(offline).toHaveLength(0);
	});

	it('includes agents without a currentSessionId', () => {
		const agents = [
			makeAgent({ id: 'a1', name: 'Pam', currentSessionId: undefined }),
		];
		const manager = makeMockAgentManager(['session-1']);
		const offline = getOfflineAgents(manager, agents);
		expect(offline).toHaveLength(1);
		expect(offline[0].name).toBe('Pam');
	});

	it('maps persistent agent fields to offline agent format', () => {
		const agents = [
			makeAgent({
				id: 'a1',
				name: 'Stanley',
				workspacePath: '/projects/crosswords',
				palette: 3,
				hueShift: 45,
				roleShort: 'Salesman',
				roleFull: 'Senior Sales Representative',
			}),
		];
		const manager = makeMockAgentManager([]);
		const offline = getOfflineAgents(manager, agents);
		expect(offline[0]).toEqual({
			sessionId: 'a1',
			name: 'Stanley',
			projectName: 'crosswords',
			workspacePath: '/projects/crosswords',
			palette: 3,
			hueShift: 45,
			isPersistent: true,
			roleShort: 'Salesman',
			roleFull: 'Senior Sales Representative',
		});
	});

	it('sets projectName to undefined when workspacePath is empty', () => {
		const agents = [makeAgent({ id: 'a1', workspacePath: '' })];
		const manager = makeMockAgentManager([]);
		const offline = getOfflineAgents(manager, agents);
		expect(offline[0].projectName).toBeUndefined();
	});

	it('treats a multi-session agent as ONLINE when any of its sessions is live', () => {
		// Primary scalar mirror points at session-1, but the live one is the
		// second concurrent session — the agent must still count as online.
		const agents = [
			makeAgent({
				id: 'a1',
				name: 'Pam',
				currentSessionId: 'session-1',
				currentSessions: [
					{ sessionId: 'session-1' },
					{ sessionId: 'session-2' },
				],
			}),
		];
		const manager = makeMockAgentManager(['session-2']);
		expect(getOfflineAgents(manager, agents)).toHaveLength(0);
	});

	it('lists a multi-session agent as offline once ALL its sessions are gone', () => {
		const agents = [
			makeAgent({
				id: 'a1',
				name: 'Pam',
				currentSessionId: 'session-1',
				currentSessions: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }],
			}),
		];
		const manager = makeMockAgentManager(['session-9']);
		expect(getOfflineAgents(manager, agents)).toHaveLength(1);
	});
});

describe('buildNewWorkerPopup', () => {
	const provisional = makeAgent({ id: 'prov', name: 'Spork', roleShort: '', roleFull: '', workspacePath: '/projects/beets' });

	it('offers only identified, same-workspace employees as candidates', () => {
		const agents = [
			provisional,
			makeAgent({ id: 'a', name: 'Pam', workspacePath: '/projects/beets' }),
			makeAgent({ id: 'b', name: 'Jim', workspacePath: '/projects/other' }), // wrong workspace
			makeAgent({ id: 'c', name: 'Ghost', roleShort: '', roleFull: '', workspacePath: '/projects/beets' }), // unidentified
			makeAgent({ id: 'd', name: 'Robert', retired: true, workspacePath: '/projects/beets' }), // retired
		];
		const popup = buildNewWorkerPopup(agents, 'session-1', provisional, 'Beets', '/projects/beets');
		expect(popup.type).toBe('newWorkerIdentified');
		expect(popup.provisionalAgentId).toBe('prov');
		expect(popup.candidates.map(c => c.id)).toEqual(['a']);
	});

	it('never offers the provisional agent itself', () => {
		const self = makeAgent({ id: 'prov', name: 'Spork', roleShort: 'Dev', workspacePath: '/projects/beets' });
		const popup = buildNewWorkerPopup([self], 'session-1', self, 'Beets', '/projects/beets');
		expect(popup.candidates).toHaveLength(0);
	});

	it('sorts busy employees first, then by recency', () => {
		const agents = [
			provisional,
			makeAgent({ id: 'idle-old', name: 'A', workspacePath: '/projects/beets', lastSessionEnd: '2026-01-01' }),
			makeAgent({ id: 'idle-new', name: 'B', workspacePath: '/projects/beets', lastSessionEnd: '2026-06-01' }),
			makeAgent({ id: 'busy', name: 'C', workspacePath: '/projects/beets', currentSessions: [{ sessionId: 's' }] }),
		];
		const popup = buildNewWorkerPopup(agents, 'session-1', provisional, 'Beets', '/projects/beets');
		expect(popup.candidates.map(c => c.id)).toEqual(['busy', 'idle-new', 'idle-old']);
		expect(popup.candidates[0].activeTaskCount).toBe(1);
	});

	it('returns no candidates when the workspace is unknown', () => {
		const agents = [provisional, makeAgent({ id: 'a', name: 'Pam', workspacePath: '/projects/beets' })];
		const popup = buildNewWorkerPopup(agents, 'session-1', provisional, 'Beets', '');
		expect(popup.candidates).toHaveLength(0);
	});
});

describe('buildIdentityPrompt', () => {
	it('names the employee, role, and the project — never a MemPalace room', () => {
		const pa = makeAgent({ id: 'uuid-123', name: 'Pam', roleShort: 'Frontend Dev', roleFull: 'Builds the UI.' });
		const prompt = buildIdentityPrompt(pa, 'Brightmind');
		expect(prompt).toContain('You are Pam, Frontend Dev.');
		expect(prompt).toContain('Builds the UI.');
		expect(prompt).toContain('working in the Brightmind project');
		expect(prompt).not.toContain('uuid-123'); // no specific room reference
		expect(prompt).not.toContain('room');
	});

	it('falls back to the workspace folder name when no project is passed', () => {
		const pa = makeAgent({ id: 'uuid-2', name: 'Jim', roleShort: 'Dev', workspacePath: '/projects/beets' });
		const prompt = buildIdentityPrompt(pa);
		expect(prompt).toContain('working in the beets project');
	});

	it('omits the role clause when there is no short role', () => {
		const pa = makeAgent({ id: 'uuid-1', name: 'Spork', roleShort: '', roleFull: '', workspacePath: '' });
		const prompt = buildIdentityPrompt(pa);
		expect(prompt).toContain('You are Spork.');
		expect(prompt).not.toContain(', .');
	});
});
