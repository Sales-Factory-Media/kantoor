import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadKnownProjects, removeKnownProjectByName, updateKnownProject } from '../src/projectStore.js';
import { focusItermSession, launchItermSession, launchAgentSession } from './itermFocus.js';
import {
	savePersistentAgents,
	deleteAgentData,
	expandHome,
	ensureMempalaceMcpConfig,
} from './agentStore.js';
import type { PersistentAgent, DesignConfig } from './agentStore.js';
import { DEFAULT_DESIGN_CONFIG } from './agentStore.js';
import { buildSystemPrompt } from './systemPrompts.js';
import { readJson, writeJson, getOfflineAgents } from './serverHelpers.js';
import { SEATS_FILE, SETTINGS_FILE } from './serverContext.js';
import type { ServerContext } from './serverContext.js';

// ── Launch helper (manual UI launches only) ──────────────────
// This helper is only used by the manual UI paths (handleLaunchAgent,
// handleSaveAgentIdentity → launch). Manual launches pass the system prompt
// with `includeSelfExit=false` because the user opened that tab themselves —
// auto-closing it after the work would be surprising. Automated dispatchers
// (Darryl/Jan orchestrators, workerDispatch) build their prompts directly
// and keep the default self-exit block.
export function launchPersistentAgent(pa: PersistentAgent, persistentAgents: PersistentAgent[], callInTask?: string, mempalaceHost?: string): boolean {
	const newSessionId = crypto.randomUUID();
	pa.currentSessionId = newSessionId;
	savePersistentAgents(persistentAgents);

	const knownProjects = loadKnownProjects();
	const project = knownProjects.find(p => p.workspacePath === pa.workspacePath);
	const prompt = buildSystemPrompt(pa, project?.description, false);
	const cwd = expandHome(pa.workspacePath || '~');
	const mcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	console.log(`[Standalone] Launching agent "${pa.name}" with session ${newSessionId} in ${cwd}${callInTask ? ` with task: ${callInTask}` : ''}`);
	return launchAgentSession(newSessionId, cwd, prompt, callInTask, { mcpConfigPath });
}

// ── Message handlers ─────────────────────────────────────────

export function handleFocusAgent(msg: Record<string, unknown>, ctx: ServerContext): void {
	const agentId = msg.id as number;
	const sessionId = ctx.agentManager.getSessionIdForAgent(agentId);
	if (sessionId) {
		const focused = focusItermSession(sessionId);
		if (!focused) {
			console.log(`[Standalone] Could not focus iTerm session for agent ${agentId}`);
		}
	}
}

export function handleSaveAgentSeats(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { agentManager, persistentAgents } = ctx;
	const seats = msg.seats as Record<string, Record<string, unknown>>;

	// Enrich with project info from live agents
	for (const agent of agentManager.agents.values()) {
		const entry = seats[agent.sessionId];
		if (entry) {
			entry.projectDir = agent.projectDir;
			entry.projectName = agent.projectName;
			if (agent.workspacePath) {
				entry.workspacePath = agent.workspacePath;
			}
		}
	}
	writeJson(SEATS_FILE, seats);

	// Sync persistent agent metadata from seat saves
	let changed = false;
	for (const agent of agentManager.agents.values()) {
		if (!agent.persistentAgentId) continue;
		const pa = persistentAgents.find(p => p.id === agent.persistentAgentId);
		const seatData = seats[agent.sessionId] as Record<string, unknown> | undefined;
		if (pa && seatData) {
			if (seatData.palette !== undefined) pa.palette = seatData.palette as number;
			if (seatData.hueShift !== undefined) pa.hueShift = seatData.hueShift as number;
			if (seatData.seatId !== undefined) pa.seatId = seatData.seatId as string;
			if (seatData.name !== undefined) pa.name = seatData.name as string;
			if (seatData.roleShort !== undefined) pa.roleShort = seatData.roleShort as string;
			if (seatData.roleFull !== undefined) pa.roleFull = seatData.roleFull as string;
			changed = true;
		}
	}
	if (changed) {
		savePersistentAgents(persistentAgents);
	}
}

export function handleSaveAgentIdentity(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, broadcastSink, agentManager, setPersistentAgents } = ctx;
	const agentData = msg.agent as { id?: string; name: string; roleShort: string; roleFull: string; workspacePath: string; palette?: number; hueShift?: number; seatId?: string; currentSessionId?: string };
	const shouldLaunch = msg.launch as boolean | undefined;
	const isNew = !agentData.id;
	const agentId = agentData.id || crypto.randomUUID();

	const existing = persistentAgents.find(p => p.id === agentId);
	if (existing) {
		existing.name = agentData.name;
		existing.roleShort = agentData.roleShort;
		existing.roleFull = agentData.roleFull;
		existing.workspacePath = agentData.workspacePath;
		if (agentData.palette !== undefined) existing.palette = agentData.palette;
		if (agentData.hueShift !== undefined) existing.hueShift = agentData.hueShift;
		if (agentData.seatId !== undefined) existing.seatId = agentData.seatId;
	} else {
		const newAgent: PersistentAgent = {
			id: agentId,
			name: agentData.name,
			roleShort: agentData.roleShort,
			roleFull: agentData.roleFull,
			workspacePath: agentData.workspacePath,
			palette: agentData.palette,
			hueShift: agentData.hueShift,
			seatId: agentData.seatId,
			currentSessionId: agentData.currentSessionId,
		};
		persistentAgents.push(newAgent);
	}

	savePersistentAgents(persistentAgents);
	setPersistentAgents(persistentAgents);
	console.log(`[Standalone] ${isNew ? 'Created' : 'Updated'} persistent agent: ${agentData.name} (${agentId})`);

	broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
	broadcastSink.postMessage({ type: 'agentIdentitySaved', agentId, agent: persistentAgents.find(p => p.id === agentId) });

	if (shouldLaunch) {
		const pa = persistentAgents.find(p => p.id === agentId)!;
		if (!launchPersistentAgent(pa, persistentAgents)) {
			console.log(`[Standalone] Failed to launch agent session for ${pa.name}`);
		}
	}
}

export function handleDeleteAgentIdentity(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, broadcastSink, agentManager, setPersistentAgents } = ctx;
	const agentId = msg.agentId as string;
	console.log(`[Standalone] Deleting persistent agent ${agentId}`);
	// Drop the live session first (broadcasts agentClosed so the webview removes
	// the character without waiting for the stale-process check). Has no effect
	// when the persistent agent isn't currently running.
	agentManager.removeSessionByPersistentAgentId(agentId);
	const updated = persistentAgents.filter(p => p.id !== agentId);
	savePersistentAgents(updated);
	setPersistentAgents(updated);
	deleteAgentData(agentId);
	broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, updated) });
}

export function handleLaunchAgent(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents } = ctx;
	const agentId = msg.agentId as string;
	const callInTask = msg.callInTask as string | undefined;
	const useTeam = msg.useTeam as boolean | undefined;
	const pa = persistentAgents.find(p => p.id === agentId);
	if (!pa) {
		console.log(`[Standalone] Persistent agent ${agentId} not found`);
		return;
	}
	// Manual call-in from the UI — no self-exit reminder. The user launched
	// this tab and will decide when to close it; automated dispatchers handle
	// the auto-close path themselves (see workerDispatch / orchestratorDispatch).
	const task = useTeam && callInTask
		? `${callInTask}\n\nCreate an agent team to work on this. Break the work into parallel tasks and spawn teammates to handle them.`
		: callInTask;
	if (!launchPersistentAgent(pa, persistentAgents, task)) {
		console.log(`[Standalone] Failed to launch agent session for ${pa.name}`);
	}
}

export function handleRestartAgent(msg: Record<string, unknown>): void {
	const sessionId = msg.sessionId as string;
	const workspacePath = msg.workspacePath as string | undefined;
	console.log(`[Standalone] Restarting session ${sessionId} in ${workspacePath || '~'}`);
	const launched = launchItermSession(sessionId, workspacePath);
	if (!launched) {
		console.log(`[Standalone] Failed to launch iTerm session for ${sessionId}`);
	}
}

export function handleForgetAgent(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, broadcastSink, agentManager } = ctx;
	const sessionId = msg.sessionId as string;
	console.log(`[Standalone] Forgetting agent ${sessionId}`);
	// Drop the live session first (broadcasts agentClosed so the webview removes
	// the character without waiting for the stale-process check). Has no effect
	// when the agent is no longer running.
	agentManager.removeSessionBySessionId(sessionId);
	const seats = readJson(SEATS_FILE) as Record<string, unknown> | null;
	if (seats && sessionId in seats) {
		delete seats[sessionId];
		writeJson(SEATS_FILE, seats);
	}
	broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
}

export function handleRemoveRoom(msg: Record<string, unknown>, ctx: ServerContext): void {
	const roomName = msg.roomName as string;
	if (!roomName) return;
	console.log(`[Standalone] Removing room: ${roomName}`);
	removeKnownProjectByName(roomName);

	// Remove persistent agents belonging to this project so they don't recreate the room
	const toRemove = ctx.persistentAgents.filter(
		(pa) => pa.workspacePath && path.basename(pa.workspacePath) === roomName,
	);
	if (toRemove.length > 0) {
		const updated = ctx.persistentAgents.filter(
			(pa) => !toRemove.some((r) => r.id === pa.id),
		);
		for (const pa of toRemove) {
			deleteAgentData(pa.id);
		}
		savePersistentAgents(updated);
		ctx.setPersistentAgents(updated);
	}

	ctx.broadcastSink.postMessage({ type: 'knownProjects', projects: loadKnownProjects() });
	ctx.broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(ctx.agentManager, ctx.persistentAgents) });
}

export function handleSetSoundEnabled(msg: Record<string, unknown>): void {
	const settings = readJson(SETTINGS_FILE) ?? {};
	writeJson(SETTINGS_FILE, { ...settings, soundEnabled: msg.enabled });
}

export function getJanDesignConfig(): DesignConfig {
	const settings = readJson(SETTINGS_FILE) as Record<string, unknown> | null;
	const saved = settings?.janDesignConfig as Partial<DesignConfig> | undefined;
	return {
		figmaUrl: saved?.figmaUrl || DEFAULT_DESIGN_CONFIG.figmaUrl,
		clickupDocUrl: saved?.clickupDocUrl || DEFAULT_DESIGN_CONFIG.clickupDocUrl,
		examplesUrl: saved?.examplesUrl || DEFAULT_DESIGN_CONFIG.examplesUrl,
	};
}

export function handleSetJanDesignConfig(msg: Record<string, unknown>, ctx: ServerContext): void {
	const figmaUrl = typeof msg.figmaUrl === 'string' ? msg.figmaUrl.trim() : '';
	const clickupDocUrl = typeof msg.clickupDocUrl === 'string' ? msg.clickupDocUrl.trim() : '';
	const examplesUrl = typeof msg.examplesUrl === 'string' ? msg.examplesUrl.trim() : '';

	const config: DesignConfig = {
		figmaUrl: figmaUrl || DEFAULT_DESIGN_CONFIG.figmaUrl,
		clickupDocUrl: clickupDocUrl || DEFAULT_DESIGN_CONFIG.clickupDocUrl,
		examplesUrl: examplesUrl || DEFAULT_DESIGN_CONFIG.examplesUrl,
	};

	const settings = readJson(SETTINGS_FILE) ?? {};
	writeJson(SETTINGS_FILE, { ...settings, janDesignConfig: config });
	ctx.broadcastSink.postMessage({ type: 'janDesignConfigLoaded', config });
}

export function handleUpdateProjectDescription(msg: Record<string, unknown>, ctx: ServerContext): void {
	const workspacePath = msg.workspacePath;
	const description = msg.description;

	if (typeof workspacePath !== 'string' || workspacePath.trim().length === 0) {
		console.warn('[Standalone] Invalid project description update: workspacePath must be a non-empty string');
		return;
	}

	if (typeof description !== 'string') {
		console.warn('[Standalone] Invalid project description update: description must be a string');
		return;
	}

	updateKnownProject(workspacePath.trim(), { description });
	ctx.broadcastSink.postMessage({ type: 'knownProjects', projects: loadKnownProjects() });
}
