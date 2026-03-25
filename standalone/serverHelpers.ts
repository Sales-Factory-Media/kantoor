import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { StandaloneAgentManager } from './standaloneAgentManager.js';
import type { PersistentAgent } from './agentStore.js';
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

	// Add persistent agents that aren't currently running
	for (const pa of persistentAgents) {
		if (pa.currentSessionId && liveSessionIds.has(pa.currentSessionId)) continue;
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
		});
	}

	return offline;
}
