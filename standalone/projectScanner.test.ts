import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readdirSync: vi.fn(),
	statSync: vi.fn(),
}));

vi.mock('os', () => ({
	homedir: () => '/mock-home',
}));

vi.mock('child_process', () => ({
	execSync: vi.fn(),
}));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { getLiveSessionIds, decodeProjectHash } from './projectScanner.js';

const mockFs = vi.mocked(fs);
const mockExecSync = vi.mocked(execSync);

describe('getLiveSessionIds', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns empty set when no claude processes are running', () => {
		mockExecSync.mockImplementation(() => { throw new Error('no matches'); });
		const ids = getLiveSessionIds();
		expect(ids.size).toBe(0);
	});

	it('extracts session IDs from ps output', () => {
		mockExecSync.mockReturnValue(
			'user  1234 0.5 1.0 ... claude --session-id abc12345-1234-1234-1234-123456789012 ...\n' +
			'user  5678 0.3 0.8 ... claude --session-id def67890-5678-5678-5678-567890123456 ...\n'
		);
		const ids = getLiveSessionIds();
		expect(ids.size).toBe(2);
		expect(ids.has('abc12345-1234-1234-1234-123456789012')).toBe(true);
		expect(ids.has('def67890-5678-5678-5678-567890123456')).toBe(true);
	});

	it('returns empty set on empty output', () => {
		mockExecSync.mockReturnValue('');
		const ids = getLiveSessionIds();
		expect(ids.size).toBe(0);
	});

	it('ignores lines without valid session IDs', () => {
		mockExecSync.mockReturnValue(
			'user  1234 0.5 1.0 ... claude --session-id not-a-valid-uuid\n' +
			'user  5678 0.3 0.8 ... claude --session-id abc12345-1234-1234-1234-123456789012\n'
		);
		const ids = getLiveSessionIds();
		expect(ids.size).toBe(1);
		expect(ids.has('abc12345-1234-1234-1234-123456789012')).toBe(true);
	});
});

describe('decodeProjectHash', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns null for hashes not starting with dash', () => {
		expect(decodeProjectHash('Users-jasper-Projects')).toBeNull();
	});

	it('decodes a simple path when all segments exist as directories', () => {
		// Hash: -Users-jasper-Projects-myapp
		// Should resolve to /Users/jasper/Projects/myapp
		mockFs.statSync.mockImplementation((p: unknown) => {
			const validPaths = ['/Users', '/Users/jasper', '/Users/jasper/Projects', '/Users/jasper/Projects/myapp'];
			if (validPaths.includes(p as string)) {
				return { isDirectory: () => true } as fs.Stats;
			}
			throw new Error('ENOENT');
		});

		const result = decodeProjectHash('-Users-jasper-Projects-myapp');
		expect(result).toBe('/Users/jasper/Projects/myapp');
	});

	it('returns null when the path does not exist on disk', () => {
		mockFs.statSync.mockImplementation(() => {
			throw new Error('ENOENT');
		});

		const result = decodeProjectHash('-nonexistent-path');
		expect(result).toBeNull();
	});

	it('handles hyphenated directory names by probing longer segments', () => {
		// Hash: -Users-jasper-Projects-my-cool-app
		// Where the actual directory is /Users/jasper/Projects/my-cool-app
		mockFs.statSync.mockImplementation((p: unknown) => {
			const validPaths = ['/Users', '/Users/jasper', '/Users/jasper/Projects', '/Users/jasper/Projects/my-cool-app'];
			if (validPaths.includes(p as string)) {
				return { isDirectory: () => true } as fs.Stats;
			}
			throw new Error('ENOENT');
		});

		const result = decodeProjectHash('-Users-jasper-Projects-my-cool-app');
		expect(result).toBe('/Users/jasper/Projects/my-cool-app');
	});

	it('recursively decodes inner hash for meta-project paths', () => {
		// If decoded path is inside ~/.claude/projects/, it tries to decode the inner hash
		const projectsDir = path.join('/mock-home', '.claude', 'projects');

		mockFs.statSync.mockImplementation((p: unknown) => {
			const validPaths = [
				'/mock-home',
				'/mock-home/.claude',
				'/mock-home/.claude/projects',
				'/mock-home/.claude/projects/-Users-jasper-Projects-actual',
				// The inner hash decodes to:
				'/Users',
				'/Users/jasper',
				'/Users/jasper/Projects',
				'/Users/jasper/Projects/actual',
			];
			if (validPaths.includes(p as string)) {
				return { isDirectory: () => true } as fs.Stats;
			}
			throw new Error('ENOENT');
		});

		// The outer hash decodes to ~/.claude/projects/-Users-jasper-Projects-actual
		// which is a meta-project, so it should recursively decode the inner hash
		const result = decodeProjectHash('-mock-home--claude-projects--Users-jasper-Projects-actual');
		expect(result).toBe('/Users/jasper/Projects/actual');
	});
});
