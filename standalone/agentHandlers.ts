import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadKnownProjects, removeKnownProjectByName, updateKnownProject } from '../src/projectStore.js';
import { focusItermSession, launchItermSession, launchAgentSession } from './itermFocus.js';
import {
	savePersistentAgents,
	addAgentSession,
	removeAgentSession,
	findAgentBySessionId,
	agentSessionCount,
	isUnidentified,
	deleteAgentData,
	expandHome,
	ensureMempalaceMcpConfig,
} from './agentStore.js';
import type { PersistentAgent, DesignConfig } from './agentStore.js';
import { DEFAULT_DESIGN_CONFIG } from './agentStore.js';
import { buildSystemPrompt } from './systemPrompts.js';
import { getOfflineAgents, buildIdentityPrompt, buildNewWorkerPopup } from './serverHelpers.js';
import type { ServerContext } from './serverContext.js';
import { loadSeats, saveSeats } from '../src/db/seatStore.js';
import { getAppSetting, setAppSetting } from '../src/db/settingsStore.js';

// ── Launch helper (manual UI launches only) ──────────────────
// This helper is only used by the manual UI paths (handleLaunchAgent,
// handleSaveAgentIdentity → launch). Manual launches pass the system prompt
// with `includeSelfExit=false` because the user opened that tab themselves —
// auto-closing it after the work would be surprising. Automated dispatchers
// (Darryl/Jan orchestrators, workerDispatch) build their prompts directly
// and keep the default self-exit block.
export function launchPersistentAgent(pa: PersistentAgent, persistentAgents: PersistentAgent[], callInTask?: string, mempalaceHost?: string, agentManager?: ServerContext['agentManager']): boolean {
	const newSessionId = crypto.randomUUID();
	addAgentSession(pa, { sessionId: newSessionId });
	savePersistentAgents(persistentAgents);

	const knownProjects = loadKnownProjects();
	const project = knownProjects.find(p => p.workspacePath === pa.workspacePath);
	// Manual UI launch ("Start new job" / new-hire kickoff): work on the
	// current branch in a shared checkout where other sessions may be active —
	// not the ticket-based Gitflow "create a feature branch" convention.
	const prompt = buildSystemPrompt(pa, project?.description, false, true);
	const cwd = expandHome(pa.workspacePath || '~');
	const mcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	console.log(`[Standalone] Launching agent "${pa.name}" with session ${newSessionId} in ${cwd}${callInTask ? ` with task: ${callInTask}` : ''}`);
	const launched = launchAgentSession(newSessionId, cwd, prompt, callInTask, { mcpConfigPath });

	// We know the opening prompt right now — stash it so the session's card shows
	// the real task immediately instead of "Tab N" while the JSONL is still being
	// flushed (a race that longer prompts lose more often). Set only on a
	// successful launch so failed attempts don't leak entries the consumer
	// (addSession) will never see.
	if (launched && callInTask && agentManager) agentManager.setPendingTaskTitle(newSessionId, callInTask);

	return launched;
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
	saveSeats(seats);

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
	const agentData = msg.agent as { id?: string; name: string; roleShort: string; roleFull: string; workspacePath: string; palette?: number; hueShift?: number; seatId?: string; currentSessionId?: string; avatarConfig?: string };
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
		if (agentData.avatarConfig !== undefined) existing.avatarConfig = agentData.avatarConfig;
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
			avatarConfig: agentData.avatarConfig,
		};
		if (agentData.currentSessionId) {
			addAgentSession(newAgent, { sessionId: agentData.currentSessionId });
		}
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

/**
 * Push the agent's identity into its live iTerm session as a copy-pasteable
 * prompt. We can't type into the user's terminal for them, so the webview shows
 * the text with a Copy button (`agentIdentityPrompt`); the user pastes it so the
 * running Claude process knows who it now is and which project it's in.
 */
function emitIdentityPrompt(ctx: ServerContext, sessionId: string, pa: PersistentAgent): void {
	const liveId = ctx.agentManager.getAgentIdBySessionId(sessionId);
	const projectName = liveId !== null ? ctx.agentManager.agents.get(liveId)?.projectName : undefined;
	ctx.broadcastSink.postMessage({
		type: 'agentIdentityPrompt',
		sessionId,
		agentId: pa.id,
		name: pa.name,
		roleShort: pa.roleShort,
		prompt: buildIdentityPrompt(pa, projectName),
	});
}

/**
 * Move a live session onto `target`, lifting it off whoever currently owns it.
 * Handles both first-time identification (the previous owner is the throwaway
 * provisional, which gets deleted once empty) and reassignment between real
 * employees (the previous owner keeps its other tasks). Re-syncs the live
 * character via `agentReidentified` and surfaces the copy-paste identity prompt.
 */
function bindSessionToAgent(ctx: ServerContext, sessionId: string, target: PersistentAgent): PersistentAgent[] {
	const { agentManager, setPersistentAgents, broadcastSink } = ctx;
	let persistentAgents = ctx.persistentAgents;

	// Lift the session off its previous owner (if any, and not already target),
	// carrying its ticket so the task keeps its context.
	const prevOwner = findAgentBySessionId(persistentAgents, sessionId);
	if (prevOwner && prevOwner.id !== target.id) {
		const moved = removeAgentSession(prevOwner, sessionId);
		addAgentSession(target, { sessionId, ticketId: moved?.ticketId, ticketName: moved?.ticketName, ticketUrl: moved?.ticketUrl });
		// A now-empty, still-unidentified previous owner is a throwaway provisional
		// — drop it. A real employee (named) or one with other live tasks is kept.
		if (agentSessionCount(prevOwner) === 0 && isUnidentified(prevOwner)) {
			persistentAgents = persistentAgents.filter(p => p.id !== prevOwner.id);
			deleteAgentData(prevOwner.id);
		}
	} else {
		addAgentSession(target, { sessionId });
	}

	savePersistentAgents(persistentAgents);
	setPersistentAgents(persistentAgents);

	const liveId = agentManager.rebindSession(sessionId, target.id);
	if (liveId !== null) {
		broadcastSink.postMessage({
			type: 'agentReidentified',
			id: liveId,
			name: target.name,
			roleShort: target.roleShort,
			roleFull: target.roleFull,
			workspacePath: target.workspacePath,
			palette: target.palette,
			hueShift: target.hueShift,
			persistentAgentId: target.id,
			avatarConfig: target.avatarConfig,
		});
	}
	emitIdentityPrompt(ctx, sessionId, target);
	broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
	return persistentAgents;
}

/**
 * Resolve the "who's this?" popup for a session (a freshly-discovered one, or an
 * explicit reassignment). The session runs under some PersistentAgent already
 * (the provisional minted in onNewSession, or its current real owner); this
 * handler either:
 *  - choice 'existing': re-binds the live session to an existing employee, and
 *  - choice 'new': mints/stamps a fresh employee and binds to that.
 * Either way the live character is updated in place via `agentReidentified`
 * (keeping its numeric id / file watching) and a copy-paste identity prompt is
 * surfaced so the user can make the running session self-aware.
 */
export function handleIdentifyWorker(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, agentManager, setPersistentAgents, broadcastSink } = ctx;
	const sessionId = msg.sessionId as string;
	const provisionalAgentId = msg.provisionalAgentId as string;
	const choice = msg.choice as 'existing' | 'new';
	// Reassign = the session already belongs to a real (identified) employee and
	// the user is moving it to someone else. For a 'new' choice this means we mint
	// a brand-new employee instead of renaming the current owner in place.
	const reassign = msg.reassign === true;
	const provisional = persistentAgents.find(p => p.id === provisionalAgentId);

	if (choice === 'existing') {
		const existingAgentId = msg.existingAgentId as string;
		const target = persistentAgents.find(p => p.id === existingAgentId);
		if (!target) {
			console.log(`[Standalone] identifyWorker: existing agent ${existingAgentId} not found`);
			return;
		}
		bindSessionToAgent(ctx, sessionId, target);
		console.log(`[Standalone] identifyWorker: session ${sessionId} assigned to "${target.name}" (${target.id})`);
		return;
	}

	// choice === 'new'. Reassign-to-new mints a fresh employee; first-time
	// identification stamps the provisional that already holds this session.
	const name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : (provisional?.name || 'New hire');
	const roleShort = typeof msg.roleShort === 'string' ? msg.roleShort.trim() : '';
	const roleFull = typeof msg.roleFull === 'string' ? msg.roleFull.trim() : '';
	const avatarConfig = typeof msg.avatarConfig === 'string' ? msg.avatarConfig : undefined;

	if (reassign || !provisional) {
		const target: PersistentAgent = {
			id: crypto.randomUUID(),
			name,
			roleShort,
			roleFull,
			workspacePath: provisional?.workspacePath
				|| (agentManager.agents.get(agentManager.getAgentIdBySessionId(sessionId) ?? -1)?.workspacePath ?? ''),
			avatarConfig,
		};
		persistentAgents.push(target);
		setPersistentAgents(persistentAgents);
		bindSessionToAgent(ctx, sessionId, target);
		console.log(`[Standalone] identifyWorker: session ${sessionId} reassigned to new hire "${target.name}" (${target.id})`);
		return;
	}

	// First-time identification: stamp the provisional in place (keeps its id, so
	// the session it already owns stays put — no rebind needed).
	provisional.name = name;
	provisional.roleShort = roleShort;
	provisional.roleFull = roleFull;
	if (avatarConfig !== undefined) provisional.avatarConfig = avatarConfig;
	savePersistentAgents(persistentAgents);
	setPersistentAgents(persistentAgents);
	console.log(`[Standalone] identifyWorker: session ${sessionId} named new hire "${provisional.name}" (${provisional.id})`);

	const liveId = agentManager.getAgentIdBySessionId(sessionId);
	if (liveId !== null) {
		broadcastSink.postMessage({
			type: 'agentReidentified',
			id: liveId,
			name: provisional.name,
			roleShort: provisional.roleShort,
			roleFull: provisional.roleFull,
			workspacePath: provisional.workspacePath,
			palette: provisional.palette,
			hueShift: provisional.hueShift,
			persistentAgentId: provisional.id,
			avatarConfig: provisional.avatarConfig,
		});
	}
	emitIdentityPrompt(ctx, sessionId, provisional);
	broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
}

/**
 * Open the "who's this?" picker for an already-running, already-identified
 * session so the user can reassign it to a different employee. Reuses the same
 * popup the new-session flow uses; the `reassign` flag tells the resolver to
 * move (not rename) when a new hire is chosen.
 */
export function handleReassignTask(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, agentManager, broadcastSink } = ctx;
	const sessionId = msg.sessionId as string;
	const owner = findAgentBySessionId(persistentAgents, sessionId);
	if (!owner) {
		console.log(`[Standalone] reassignTask: no owner for session ${sessionId}`);
		return;
	}
	const liveId = agentManager.getAgentIdBySessionId(sessionId);
	const live = liveId !== null ? agentManager.agents.get(liveId) : undefined;
	const projectName = live?.projectName ?? '';
	const workspacePath = live?.workspacePath || owner.workspacePath || '';
	const popup = buildNewWorkerPopup(persistentAgents, sessionId, owner, projectName, workspacePath);
	broadcastSink.postMessage({ ...popup, reassign: true });
}

export function handleLaunchAgent(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, agentManager } = ctx;
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
	if (!launchPersistentAgent(pa, persistentAgents, task, undefined, agentManager)) {
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
	const seats = { ...loadSeats() };
	if (sessionId in seats) {
		delete seats[sessionId];
		saveSeats(seats);
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
	setAppSetting('soundEnabled', msg.enabled);
}

// ── Auto Mode ────────────────────────────────────────────────
// Global toggle for the human-gated Darryl delegation flow (see
// AUTO_MODE_ASSIGNEE_USERNAME). Off by default — an unset setting reads false.

export function getAutoModeEnabled(): boolean {
	return getAppSetting<boolean>('autoMode') === true;
}

export function handleSetAutoMode(msg: Record<string, unknown>, ctx: ServerContext): void {
	const enabled = msg.enabled === true;
	setAppSetting('autoMode', enabled);
	ctx.broadcastSink.postMessage({ type: 'autoModeLoaded', enabled });
	// Turning Auto Mode ON should pick up any waiting ticket promptly instead of
	// waiting up to a full poll interval. Fire a refresh (best-effort).
	if (enabled) {
		import('./clickupHandlers.js')
			.then(({ handleClickupRefresh }) => handleClickupRefresh(ctx).catch(() => {}))
			.catch(() => {});
	}
}

export function getJanDesignConfig(): DesignConfig {
	const saved = getAppSetting<Partial<DesignConfig>>('janDesignConfig');
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

	setAppSetting('janDesignConfig', config);
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
