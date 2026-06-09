import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { StandaloneAgentManager } from './standaloneAgentManager.js';
import type { PersistentAgent } from './agentStore.js';
import { agentSessionIds, agentSessionCount, isUnidentified, expandHome } from './agentStore.js';
import type { OfflineAgent } from './types.js';

const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');

// ── Persistence helpers ──────────────────────────────────────
export function readJson(filePath: string): Record<string, unknown> | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
	} catch { return null; }
}

export function writeJson(filePath: string, data: unknown): void {
	try {
		if (!fs.existsSync(SETTINGS_DIR)) {
			fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
		}
		fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
	} catch (err) {
		console.error(`[Standalone] Failed to write ${filePath}:`, err);
	}
}

// ── Offline agents ───────────────────────────────────────────
export function getOfflineAgents(agentManager: StandaloneAgentManager, persistentAgents: PersistentAgent[]): OfflineAgent[] {
	const liveSessionIds = agentManager.getLiveSessionIds();
	const offline: OfflineAgent[] = [];

	// Add persistent agents that aren't currently running. An agent is "online"
	// (and thus excluded here) if ANY of its concurrent sessions is live.
	for (const pa of persistentAgents) {
		if (agentSessionIds(pa).some(sid => liveSessionIds.has(sid))) continue;
		offline.push({
			sessionId: pa.id,
			name: pa.name,
			projectName: pa.workspacePath ? path.basename(pa.workspacePath) : undefined,
			workspacePath: pa.workspacePath,
			palette: pa.palette,
			hueShift: pa.hueShift,
			isPersistent: true,
			roleShort: pa.roleShort,
			roleFull: pa.roleFull,
			lastSessionEnd: pa.lastSessionEnd,
			sessionCount: pa.sessionCount,
			avatarConfig: pa.avatarConfig,
		});
	}

	return offline;
}

/** The popup payload the webview's "who's this?" modal consumes. */
export interface NewWorkerPopup {
	type: 'newWorkerIdentified';
	sessionId: string;
	provisionalAgentId: string;
	provisionalName: string;
	workspacePath: string;
	projectName: string;
	candidates: Array<{
		id: string;
		name: string;
		roleShort: string;
		lastSessionEnd?: string;
		sessionCount?: number;
		avatarConfig?: string;
		activeTaskCount: number;
	}>;
}

/**
 * Build the "who's this?" popup payload for a session attached to an
 * unidentified (provisional) agent `pa`. Candidates are real, identified
 * offline employees at the same workspace — busy-first, then by recency — so the
 * user can fold this task into someone already working, mark it as a returning
 * hire, or name a brand-new one. Shared by the live-discovery path
 * (onNewSession), the reconnect replay (handleWebviewReady), and the explicit
 * reassign action so the popup survives a restart / reload that happened before
 * it was answered.
 */
export function buildNewWorkerPopup(
	persistentAgents: PersistentAgent[],
	sessionId: string,
	pa: PersistentAgent,
	projectName: string,
	workspacePath: string,
): NewWorkerPopup {
	let candidates: PersistentAgent[] = [];
	if (workspacePath) {
		const targetWp = expandHome(workspacePath);
		candidates = persistentAgents.filter(p =>
			p.id !== pa.id
			&& !p.retired
			&& !isUnidentified(p)
			&& p.workspacePath
			&& expandHome(p.workspacePath) === targetWp,
		);
		candidates.sort((a, b) => {
			const aBusy = agentSessionCount(a) > 0 ? 1 : 0;
			const bBusy = agentSessionCount(b) > 0 ? 1 : 0;
			if (aBusy !== bBusy) return bBusy - aBusy;
			return (b.lastSessionEnd ?? '').localeCompare(a.lastSessionEnd ?? '');
		});
	}
	return {
		type: 'newWorkerIdentified',
		sessionId,
		provisionalAgentId: pa.id,
		provisionalName: pa.name,
		workspacePath: workspacePath || '',
		projectName,
		candidates: candidates.map(c => ({
			id: c.id,
			name: c.name,
			roleShort: c.roleShort,
			lastSessionEnd: c.lastSessionEnd,
			sessionCount: c.sessionCount,
			avatarConfig: c.avatarConfig,
			activeTaskCount: agentSessionCount(c),
		})),
	};
}

/**
 * The text the user copy-pastes into an agent's iTerm session right after
 * (re)assigning it, so the live Claude process knows which employee it now is
 * and which project it's working in. Kept deliberately short and paste-friendly.
 * Intentionally does NOT name a specific MemPalace room — the session's own
 * system prompt already points it at its memory; this just establishes identity.
 */
export function buildIdentityPrompt(pa: PersistentAgent, projectName?: string): string {
	const role = pa.roleShort?.trim();
	const project = projectName?.trim() || (pa.workspacePath ? path.basename(pa.workspacePath) : '');
	const lines = [
		`You are ${pa.name}${role ? `, ${role}` : ''}.`,
	];
	if (pa.roleFull?.trim()) lines.push(pa.roleFull.trim());
	if (project) lines.push(`You're working in the ${project} project.`);
	lines.push(`Read your MemPalace memory at the start of work and record your learnings there as ${pa.name}.`);
	return lines.join('\n');
}
