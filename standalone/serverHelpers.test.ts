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

import { readJson, writeJson, getOfflineAgents } from './serverHelpers.js';

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
});
