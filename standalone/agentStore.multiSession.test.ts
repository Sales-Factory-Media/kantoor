import { describe, it, expect } from 'vitest';
import type { PersistentAgent } from './agentStore.js';

// agentStore imports fs/os/crypto at module load; stub them so the import is
// side-effect free. The helpers under test are pure (no fs/DB access).
import { vi } from 'vitest';
vi.mock('fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn(), rmSync: vi.fn() }));
vi.mock('os', () => ({ homedir: () => '/mock-home' }));
vi.mock('crypto', () => ({ randomUUID: () => 'test-uuid' }));

import {
	addAgentSession,
	removeAgentSession,
	pruneDeadSessions,
	agentSessionIds,
	agentSessionCount,
	findAgentBySessionId,
	isUnidentified,
} from './agentStore.js';

function makeAgent(overrides: Partial<PersistentAgent> = {}): PersistentAgent {
	return {
		id: 'agent-1',
		name: 'Pam',
		roleShort: 'Frontend Dev',
		roleFull: '',
		workspacePath: '/projects/brightmind',
		...overrides,
	};
}

describe('isUnidentified', () => {
	it('is true only when both role fields are empty', () => {
		expect(isUnidentified(makeAgent({ roleShort: '', roleFull: '' }))).toBe(true);
		expect(isUnidentified(makeAgent({ roleShort: '  ', roleFull: '\t' }))).toBe(true);
		expect(isUnidentified(makeAgent({ roleShort: 'Frontend Dev', roleFull: '' }))).toBe(false);
		expect(isUnidentified(makeAgent({ roleShort: '', roleFull: 'Builds UI' }))).toBe(false);
	});
});

describe('addAgentSession', () => {
	it('adds a session and mirrors it into the scalar fields', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1', ticketId: 't1', ticketName: 'Login', ticketUrl: 'http://x/1' });
		expect(pa.currentSessions).toEqual([{ sessionId: 's1', ticketId: 't1', ticketName: 'Login', ticketUrl: 'http://x/1' }]);
		expect(pa.currentSessionId).toBe('s1');
		expect(pa.currentTicketId).toBe('t1');
		expect(pa.currentTicketName).toBe('Login');
		expect(pa.currentTicketUrl).toBe('http://x/1');
	});

	it('keeps the FIRST session as the scalar mirror when several are added', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1', ticketId: 't1' });
		addAgentSession(pa, { sessionId: 's2', ticketId: 't2' });
		expect(agentSessionIds(pa)).toEqual(['s1', 's2']);
		// Mirror still points at the primary (first) session.
		expect(pa.currentSessionId).toBe('s1');
		expect(pa.currentTicketId).toBe('t1');
	});

	it('is idempotent on the same sessionId', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1' });
		addAgentSession(pa, { sessionId: 's1' });
		expect(agentSessionCount(pa)).toBe(1);
	});
});

describe('removeAgentSession', () => {
	it('removes the matching session and returns its entry', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1', ticketId: 't1' });
		addAgentSession(pa, { sessionId: 's2', ticketId: 't2' });
		const removed = removeAgentSession(pa, 's2');
		expect(removed).toEqual({ sessionId: 's2', ticketId: 't2' });
		expect(agentSessionIds(pa)).toEqual(['s1']);
	});

	it('re-points the scalar mirror to the surviving primary', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1', ticketId: 't1' });
		addAgentSession(pa, { sessionId: 's2', ticketId: 't2' });
		removeAgentSession(pa, 's1'); // remove the primary
		expect(pa.currentSessionId).toBe('s2');
		expect(pa.currentTicketId).toBe('t2');
	});

	it('clears the mirror when the last session is removed', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1', ticketId: 't1' });
		removeAgentSession(pa, 's1');
		expect(agentSessionCount(pa)).toBe(0);
		expect(pa.currentSessionId).toBeUndefined();
		expect(pa.currentTicketId).toBeUndefined();
	});

	it('handles a legacy scalar-only session (no currentSessions array)', () => {
		const pa = makeAgent({ currentSessionId: 'legacy', currentTicketId: 'lt' });
		const removed = removeAgentSession(pa, 'legacy');
		expect(removed?.sessionId).toBe('legacy');
		expect(removed?.ticketId).toBe('lt');
		expect(pa.currentSessionId).toBeUndefined();
	});

	it('returns undefined when the session is not present', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1' });
		expect(removeAgentSession(pa, 'nope')).toBeUndefined();
		expect(agentSessionCount(pa)).toBe(1);
	});
});

describe('agentSessionIds / agentSessionCount', () => {
	it('reads from the array form', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1' });
		addAgentSession(pa, { sessionId: 's2' });
		expect(agentSessionIds(pa)).toEqual(['s1', 's2']);
		expect(agentSessionCount(pa)).toBe(2);
	});

	it('falls back to the legacy scalar when no array is present', () => {
		const pa = makeAgent({ currentSessionId: 'legacy' });
		expect(agentSessionIds(pa)).toEqual(['legacy']);
		expect(agentSessionCount(pa)).toBe(1);
	});

	it('returns empty for an idle agent', () => {
		const pa = makeAgent();
		expect(agentSessionIds(pa)).toEqual([]);
		expect(agentSessionCount(pa)).toBe(0);
	});
});

describe('findAgentBySessionId', () => {
	it('finds an agent by a NON-primary session in its array', () => {
		const a = makeAgent({ id: 'a' });
		const b = makeAgent({ id: 'b' });
		addAgentSession(b, { sessionId: 's1' });
		addAgentSession(b, { sessionId: 's2' }); // s2 is not the mirror/primary
		expect(findAgentBySessionId([a, b], 's2')?.id).toBe('b');
	});

	it('finds an agent via the legacy scalar', () => {
		const a = makeAgent({ id: 'a', currentSessionId: 'legacy' });
		expect(findAgentBySessionId([a], 'legacy')?.id).toBe('a');
	});

	it('returns undefined when no agent owns the session', () => {
		const a = makeAgent({ id: 'a' });
		expect(findAgentBySessionId([a], 'ghost')).toBeUndefined();
	});
});

describe('pruneDeadSessions', () => {
	it('drops sessions not in the live set and reports a change', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1' });
		addAgentSession(pa, { sessionId: 's2' });
		const changed = pruneDeadSessions(pa, new Set(['s2']));
		expect(changed).toBe(true);
		expect(agentSessionIds(pa)).toEqual(['s2']);
		expect(pa.currentSessionId).toBe('s2');
	});

	it('returns false when every session is still live', () => {
		const pa = makeAgent();
		addAgentSession(pa, { sessionId: 's1' });
		expect(pruneDeadSessions(pa, new Set(['s1']))).toBe(false);
		expect(agentSessionCount(pa)).toBe(1);
	});

	it('clears a legacy scalar-only dead session', () => {
		const pa = makeAgent({ currentSessionId: 'legacy' });
		const changed = pruneDeadSessions(pa, new Set());
		expect(changed).toBe(true);
		expect(pa.currentSessionId).toBeUndefined();
		expect(agentSessionCount(pa)).toBe(0);
	});
});
