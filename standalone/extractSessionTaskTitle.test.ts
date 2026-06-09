import { describe, it, expect, vi, beforeEach } from 'vitest';

// Feed JSONL content to the extractor through a mocked fs. `readSync` copies the
// current `fileContent` into the caller's buffer (head-read at offset 0).
let fileContent = '';
let fileExists = true;

vi.mock('fs', () => ({
	existsSync: vi.fn(() => fileExists),
	statSync: vi.fn(() => ({ size: Buffer.byteLength(fileContent) })),
	openSync: vi.fn(() => 1),
	closeSync: vi.fn(),
	readSync: vi.fn((_fd: number, buf: Buffer, _off: number, len: number) => {
		const src = Buffer.from(fileContent, 'utf-8');
		const n = Math.min(len, src.length);
		src.copy(buf, 0, 0, n);
		return n;
	}),
	// Pulled in transitively by other imports in the module graph.
	watchFile: vi.fn(),
	unwatchFile: vi.fn(),
	watch: vi.fn(() => ({ close: vi.fn(), on: vi.fn() })),
}));

vi.mock('../src/fileWatcher.js', () => ({ startFileWatching: vi.fn() }));
vi.mock('../src/timerManager.js', () => ({ cancelWaitingTimer: vi.fn(), cancelPermissionTimer: vi.fn() }));

import { extractSessionTaskTitle } from './standaloneAgentManager.js';

function jsonl(...records: unknown[]): string {
	return records.map(r => JSON.stringify(r)).join('\n') + '\n';
}

describe('extractSessionTaskTitle', () => {
	beforeEach(() => {
		fileExists = true;
		fileContent = '';
	});

	it('returns the first user string prompt', () => {
		fileContent = jsonl(
			{ type: 'user', message: { role: 'user', content: 'Fix the login redirect bug' } },
		);
		expect(extractSessionTaskTitle('/x.jsonl')).toBe('Fix the login redirect bug');
	});

	it('extracts the text block from array-form content', () => {
		fileContent = jsonl(
			{ type: 'user', message: { content: [{ type: 'text', text: 'Refactor the nav bar' }] } },
		);
		expect(extractSessionTaskTitle('/x.jsonl')).toBe('Refactor the nav bar');
	});

	it('skips tool_result-only user turns', () => {
		fileContent = jsonl(
			{ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
			{ type: 'user', message: { content: 'The real task' } },
		);
		expect(extractSessionTaskTitle('/x.jsonl')).toBe('The real task');
	});

	it('skips slash-command wrappers and local-command caveats', () => {
		fileContent = jsonl(
			{ type: 'user', message: { content: '<command-name>/compact</command-name>' } },
			{ type: 'user', message: { content: 'Caveat: messages below were generated...' } },
			{ type: 'user', message: { content: 'Add a dark-mode toggle' } },
		);
		expect(extractSessionTaskTitle('/x.jsonl')).toBe('Add a dark-mode toggle');
	});

	it('collapses whitespace and truncates very long prompts with an ellipsis', () => {
		const long = 'A'.repeat(250);
		fileContent = jsonl({ type: 'user', message: { content: long } });
		const out = extractSessionTaskTitle('/x.jsonl')!;
		expect(out.length).toBeLessThanOrEqual(100);
		expect(out.endsWith('…')).toBe(true);
	});

	it('returns undefined when the file is missing', () => {
		fileExists = false;
		expect(extractSessionTaskTitle('/x.jsonl')).toBeUndefined();
	});

	it('returns undefined when there is no user text yet', () => {
		fileContent = jsonl(
			{ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
		);
		expect(extractSessionTaskTitle('/x.jsonl')).toBeUndefined();
	});
});
