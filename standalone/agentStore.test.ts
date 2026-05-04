import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PersistentAgent } from './agentStore.js';

// Mock fs and os before importing the module
vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: vi.fn(),
}));

vi.mock('os', () => ({
	homedir: () => '/mock-home',
}));

vi.mock('crypto', () => ({
	randomUUID: () => 'test-uuid-1234',
}));

const mockWriteJson = vi.fn();
vi.mock('./serverHelpers.js', () => ({
	writeJson: (...args: unknown[]) => mockWriteJson(...args),
}));

import * as fs from 'fs';
import {
	pickRandomName,
	getAgentMemoryPath,
	ensureMempalaceMcpConfig,
	mergeMcpConfigs,
} from './agentStore.js';
import {
	buildSystemPrompt,
	buildDarrylSystemPrompt,
} from './systemPrompts.js';
import type { RosterEntry } from './systemPrompts.js';

function makeAgent(overrides: Partial<PersistentAgent> = {}): PersistentAgent {
	return {
		id: 'agent-1',
		name: 'Michael',
		roleShort: 'Manager',
		roleFull: 'Regional Manager of the Scranton branch',
		workspacePath: '/projects/dunder-mifflin',
		...overrides,
	};
}

describe('pickRandomName', () => {
	it('returns a name not already used', () => {
		const existing = [makeAgent({ name: 'Michael' }), makeAgent({ name: 'Dwight' })];
		const name = pickRandomName(existing);
		expect(name).not.toBe('Michael');
		expect(name).not.toBe('Dwight');
		expect(typeof name).toBe('string');
		expect(name.length).toBeGreaterThan(0);
	});

	it('returns any available name when no agents exist', () => {
		const name = pickRandomName([]);
		expect(typeof name).toBe('string');
		expect(name.length).toBeGreaterThan(0);
	});

	it('appends a numeric suffix when all names are taken', () => {
		// Create agents with every name from the OFFICE_NAMES list
		const allNames = [
			'Michael', 'Dwight', 'Jim', 'Pam', 'Ryan', 'Andy', 'Stanley',
			'Kevin', 'Meredith', 'Angela', 'Oscar', 'Phyllis', 'Kelly',
			'Toby', 'Creed', 'Darryl', 'Jan', 'Holly', 'Erin', 'Gabe',
			'Clark', 'Pete', 'Nellie', 'Robert', 'Karen', 'Roy', 'Todd',
			'Devon', 'Madge', 'Lonny', 'Hank', 'Nate', 'Val', 'Cathy',
			'Jordan', 'Hannah', 'Troy', 'Nick', 'Sadiq', 'Hidetoshi',
		];
		const existing = allNames.map(name => makeAgent({ name }));
		const name = pickRandomName(existing);
		// Should be "SomeName 2"
		expect(name).toMatch(/^.+ \d+$/);
	});

	it('increments suffix if "Name 2" is also taken', () => {
		const allNames = [
			'Michael', 'Dwight', 'Jim', 'Pam', 'Ryan', 'Andy', 'Stanley',
			'Kevin', 'Meredith', 'Angela', 'Oscar', 'Phyllis', 'Kelly',
			'Toby', 'Creed', 'Darryl', 'Jan', 'Holly', 'Erin', 'Gabe',
			'Clark', 'Pete', 'Nellie', 'Robert', 'Karen', 'Roy', 'Todd',
			'Devon', 'Madge', 'Lonny', 'Hank', 'Nate', 'Val', 'Cathy',
			'Jordan', 'Hannah', 'Troy', 'Nick', 'Sadiq', 'Hidetoshi',
		];
		// Also add all "Name 2" variants
		const suffixedNames = allNames.map(n => `${n} 2`);
		const existing = [...allNames, ...suffixedNames].map(name => makeAgent({ name }));
		const name = pickRandomName(existing);
		// Should be "SomeName 3"
		expect(name).toMatch(/^.+ 3$/);
	});
});

describe('buildSystemPrompt', () => {
	it('includes agent name', () => {
		const agent = makeAgent();
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain('You are Michael.');
	});

	it('includes roleFull when present', () => {
		const agent = makeAgent({ roleFull: 'Head of quality assurance' });
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain('Head of quality assurance');
	});

	it('falls back to roleShort when roleFull is empty', () => {
		const agent = makeAgent({ roleFull: '', roleShort: 'QA Lead' });
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain('Your role: QA Lead.');
		expect(prompt).not.toContain('Head of quality');
	});

	it('includes memory path and MemPalace instructions', () => {
		const agent = makeAgent();
		const prompt = buildSystemPrompt(agent);
		expect(prompt).toContain('MEMORY.md');
		expect(prompt).toContain('MemPalace');
		expect(prompt).toContain('mempalace_search');
	});

	it('omits role line when both roleShort and roleFull are empty', () => {
		const agent = makeAgent({ roleShort: '', roleFull: '' });
		const prompt = buildSystemPrompt(agent);
		expect(prompt).not.toContain('Your role:');
		// Name should still be there
		expect(prompt).toContain('You are Michael.');
	});

	it('includes Project Context section when projectDescription is provided', () => {
		const agent = makeAgent();
		const prompt = buildSystemPrompt(agent, 'A CRM application for managing customer relationships');
		expect(prompt).toContain('## Project Context');
		expect(prompt).toContain('A CRM application for managing customer relationships');
	});

	it('omits Project Context section when projectDescription is not provided', () => {
		const agent = makeAgent();
		const prompt = buildSystemPrompt(agent);
		expect(prompt).not.toContain('## Project Context');
	});

	it('omits Project Context section when projectDescription is undefined', () => {
		const agent = makeAgent();
		const prompt = buildSystemPrompt(agent, undefined);
		expect(prompt).not.toContain('## Project Context');
	});
});

describe('buildDarrylSystemPrompt', () => {
	const darryl = makeAgent({ name: 'Darryl', roleShort: 'Foreman' });

	function makeRoster(overrides: Partial<RosterEntry>[] = []): RosterEntry[] {
		const defaults: RosterEntry = {
			id: 'agent-2',
			name: 'Jim',
			roleShort: 'Developer',
			roleFull: 'Frontend developer',
			workspacePath: '/projects/frontend',
			isOnline: false,
		};
		if (overrides.length === 0) return [{ ...defaults }];
		return overrides.map(o => ({ ...defaults, ...o }));
	}

	it('identifies Darryl as the Foreman', () => {
		const prompt = buildDarrylSystemPrompt(darryl, makeRoster(), 3333);
		expect(prompt).toContain('You are Darryl, the Foreman');
	});

	it('includes HTTP API instructions with correct port', () => {
		const prompt = buildDarrylSystemPrompt(darryl, makeRoster(), 4444);
		expect(prompt).toContain('http://localhost:4444/api/launch-agent');
		expect(prompt).toContain('http://localhost:4444');
	});

	it('renders the workspaces Darryl can dispatch into', () => {
		// Post-unification, the prompt lists projects (workspaces), not named
		// agents — Darryl no longer picks a worker by id, the hub does. He
		// just supplies the workspacePath. Design-team roles are excluded so
		// Darryl doesn't try to dispatch UX/Visual Designers as dev workers.
		const roster = makeRoster([
			{ id: 'a1', name: 'Jim', roleShort: 'Developer', workspacePath: '/projects/frontend', isOnline: false },
			{ id: 'a2', name: 'Pam', roleShort: 'Visual Designer', workspacePath: '/projects/design', isOnline: true },
		]);
		const prompt = buildDarrylSystemPrompt(darryl, roster, 3333);
		expect(prompt).toContain('/projects/frontend');
		// Design-team workspace must be filtered out.
		expect(prompt).not.toContain('/projects/design');
	});

	it('includes project name and description for each dispatchable workspace', () => {
		const roster = makeRoster([
			{ id: 'a1', name: 'Jim', workspacePath: '/projects/crm', projectName: 'crm', projectDescription: 'Customer management app' },
		]);
		const prompt = buildDarrylSystemPrompt(darryl, roster, 3333);
		expect(prompt).toContain('crm');
		expect(prompt).toContain('Customer management app');
	});

	it('includes memory path and MemPalace instructions', () => {
		const prompt = buildDarrylSystemPrompt(darryl, makeRoster(), 3333);
		expect(prompt).toContain('MEMORY.md');
		expect(prompt).toContain('MemPalace');
		expect(prompt).toContain('mempalace_search');
	});

	it('includes prominent rules section', () => {
		const prompt = buildDarrylSystemPrompt(darryl, makeRoster(), 3333);
		expect(prompt).toContain('## RULES');
		expect(prompt).toContain('additionalPrompt');
	});
});

describe('getAgentMemoryPath', () => {
	it('returns correct path for agent ID', () => {
		const memPath = getAgentMemoryPath('abc-123');
		expect(memPath).toBe('/mock-home/.pixel-agents/agents/abc-123/MEMORY.md');
	});
});

describe('ensureMempalaceMcpConfig', () => {
	beforeEach(() => {
		mockWriteJson.mockClear();
	});

	it('defaults to localhost when no host provided', () => {
		ensureMempalaceMcpConfig();
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.stringContaining('mempalace-mcp-config.json'),
			expect.objectContaining({
				mcpServers: {
					mempalace: { type: 'sse', url: 'http://localhost:3334/sse' },
				},
			}),
		);
	});

	it('uses provided IPv4 host as-is', () => {
		ensureMempalaceMcpConfig('192.168.1.10');
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				mcpServers: {
					mempalace: { type: 'sse', url: 'http://192.168.1.10:3334/sse' },
				},
			}),
		);
	});

	it('wraps bare IPv6 address in brackets', () => {
		ensureMempalaceMcpConfig('::1');
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				mcpServers: {
					mempalace: { type: 'sse', url: 'http://[::1]:3334/sse' },
				},
			}),
		);
	});

	it('wraps full IPv6 address in brackets', () => {
		ensureMempalaceMcpConfig('fe80::1');
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				mcpServers: {
					mempalace: { type: 'sse', url: 'http://[fe80::1]:3334/sse' },
				},
			}),
		);
	});

	it('does not double-bracket already-bracketed IPv6', () => {
		ensureMempalaceMcpConfig('[::1]');
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				mcpServers: {
					mempalace: { type: 'sse', url: 'http://[::1]:3334/sse' },
				},
			}),
		);
	});

	it('returns the config file path', () => {
		const result = ensureMempalaceMcpConfig();
		expect(result).toBe('/mock-home/.pixel-agents/mempalace-mcp-config.json');
	});
});

describe('mergeMcpConfigs', () => {
	beforeEach(() => {
		mockWriteJson.mockClear();
		vi.mocked(fs.readFileSync).mockReset();
	});

	it('merges servers from multiple config files', () => {
		vi.mocked(fs.readFileSync)
			.mockReturnValueOnce(JSON.stringify({ mcpServers: { serverA: { url: 'a' } } }))
			.mockReturnValueOnce(JSON.stringify({ mcpServers: { serverB: { url: 'b' } } }));

		mergeMcpConfigs('/path/a.json', '/path/b.json');
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.stringContaining('merged-mcp-config.json'),
			{
				mcpServers: {
					serverA: { url: 'a' },
					serverB: { url: 'b' },
				},
			},
		);
	});

	it('later configs override earlier ones for same server name', () => {
		vi.mocked(fs.readFileSync)
			.mockReturnValueOnce(JSON.stringify({ mcpServers: { srv: { url: 'first' } } }))
			.mockReturnValueOnce(JSON.stringify({ mcpServers: { srv: { url: 'second' } } }));

		mergeMcpConfigs('/a.json', '/b.json');
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.any(String),
			{ mcpServers: { srv: { url: 'second' } } },
		);
	});

	it('logs warning and continues when a config file is invalid JSON', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.mocked(fs.readFileSync)
			.mockReturnValueOnce('not valid json')
			.mockReturnValueOnce(JSON.stringify({ mcpServers: { good: { url: 'ok' } } }));

		mergeMcpConfigs('/bad.json', '/good.json');
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('/bad.json'),
			expect.anything(),
		);
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.any(String),
			{ mcpServers: { good: { url: 'ok' } } },
		);
		warnSpy.mockRestore();
	});

	it('handles configs without mcpServers key', () => {
		vi.mocked(fs.readFileSync)
			.mockReturnValueOnce(JSON.stringify({ otherKey: 'value' }))
			.mockReturnValueOnce(JSON.stringify({ mcpServers: { srv: { url: 'a' } } }));

		mergeMcpConfigs('/empty.json', '/valid.json');
		expect(mockWriteJson).toHaveBeenCalledWith(
			expect.any(String),
			{ mcpServers: { srv: { url: 'a' } } },
		);
	});

	it('returns the merged config file path', () => {
		vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ mcpServers: {} }));
		const result = mergeMcpConfigs('/a.json');
		expect(result).toBe('/mock-home/.pixel-agents/merged-mcp-config.json');
	});
});
