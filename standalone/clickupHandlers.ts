/**
 * ClickUp integration: polling, ticket pickup, and dispatch for Darryl / Jan /
 * the design fleet. The giant prompt strings live in ./initialTasks.ts, the
 * launch boilerplate lives in ./launchHelpers.ts, and capacity accounting
 * lives in ./capacity.ts — this file is orchestration only.
 */

import * as path from 'path';
import {
	CLICKUP_POLL_INTERVAL_MS,
	DARRYL_ROLE_SHORT,
	DARRYL_CLICKUP_USERNAME,
	DARRYL_WORKSPACE,
	JAN_ROLE_SHORT,
	JAN_CLICKUP_USERNAME,
	JAN_WORKSPACE,
	DESIGNER_ROLE_SHORT,
	VISUAL_DESIGNER_ROLE_SHORT,
	VISUAL_QA_ROLE_SHORT,
	TEAM_UX_ID,
	TEAM_VISUAL_ID,
	SERVER_PORT,
	WORKER_ROLE_DEV,
	WORKER_ROLE_DESIGNER,
	DEFAULT_WORKER_ROLES,
	AI_REVIEW_AUTO_ESCALATE,
	AI_REVIEW_PICKUP_ENABLED,
	REVIEW_TRIGGER_DELAY_MS,
} from './constants.js';
import {
	savePersistentAgents,
	ensureAgentMemory,
	generateAgentId,
} from './agentStore.js';
import type { PersistentAgent } from './agentStore.js';
import {
	buildDarrylSystemPrompt,
	buildJanSystemPrompt,
	buildDesignerSystemPrompt,
	buildVisualDesignerSystemPrompt,
	buildVisualQaSystemPrompt,
	buildVisualQaInitialTask,
	buildJanReviewPrompt,
} from './systemPrompts.js';
import type { RosterEntry } from './systemPrompts.js';
import { getJanDesignConfig } from './agentHandlers.js';
import { launchPersistentAgent } from './agentHandlers.js';
import { fetchListTasks, addTaskComment } from './clickupClient.js';
import type { ClickUpConfig } from './clickupClient.js';
import { readJson, writeJson } from './serverHelpers.js';
import { SETTINGS_FILE } from './serverContext.js';
import type { ServerContext } from './serverContext.js';
import {
	getAvailableCapacity,
	getIdleWorkers,
	getIdleWorkersWithRole,
	addAssignment,
	collectAgentMemories,
	broadcastWorkerStatus,
	sendWorkerRequest,
	clearWorkerTicket,
	saveAgentMemoryFromWorker,
} from './workerRegistry.js';
import { loadKnownProjects } from '../src/projectStore.js';

import {
	findFigmaLockHolder,
	getDesignerMachineCapacity,
	computeDesignFleetCapacity,
} from './capacity.js';
import {
	EXIT_REMINDER,
	launchPersistentAgentSession,
	type TicketInfo,
} from './launchHelpers.js';
import {
	buildWorkerAiReviewInitialTask,
	buildWorkerStandardInitialTask,
	buildDarrylAiReviewInitialTask,
	buildDarrylStandardInitialTask,
	buildJanRefineInitialTask,
	buildJanSingleTodoInitialTask,
	buildJanBatchInitialTask,
	buildUxDesignerInitialTask,
	buildVisualDesignerInitialTask,
} from './initialTasks.js';

// ── Small utilities ──────────────────────────────────────────

/** Build the roster passed into system prompts — every persistent agent except
 *  the one being launched, enriched with known-project metadata. */
function buildRoster(persistentAgents: PersistentAgent[], excludeAgentId: string): RosterEntry[] {
	const knownProjects = loadKnownProjects();
	return persistentAgents
		.filter(p => p.id !== excludeAgentId)
		.map(p => {
			const projName = path.basename(p.workspacePath);
			const proj = knownProjects.find(k => k.name === projName);
			return {
				id: p.id,
				name: p.name,
				roleShort: p.roleShort,
				roleFull: p.roleFull,
				workspacePath: p.workspacePath,
				projectName: proj?.name ?? projName,
				projectDescription: proj?.description,
				isOnline: !!p.currentSessionId,
			};
		});
}

/** Idempotent find-or-create for a well-known agent (Jan / Darryl). */
function findOrCreatePersistentAgent(
	persistentAgents: PersistentAgent[],
	name: string,
	roleShort: string,
	roleFull: string,
	workspacePath: string,
): PersistentAgent {
	let agent = persistentAgents.find(p => p.name === name);
	if (!agent) {
		agent = { id: generateAgentId(), name, roleShort, roleFull, workspacePath };
		persistentAgents.push(agent);
		savePersistentAgents(persistentAgents);
	}
	return agent;
}

// ── Polling ──────────────────────────────────────────────────

export function startClickupPolling(ctx: ServerContext): void {
	if (ctx.clickupTimer) return;
	if (!ctx.clickupConfig) return;
	console.log('[Standalone] Starting ClickUp polling...');
	ctx.clickupTimer = setInterval(() => { handleClickupRefresh(ctx).catch(() => {}); }, CLICKUP_POLL_INTERVAL_MS);
}

// ── Refresh & auto-pickup ────────────────────────────────────

let clickupRefreshInFlight = false;

export async function handleClickupRefresh(ctx: ServerContext): Promise<void> {
	if (!ctx.clickupConfig) return;
	if (clickupRefreshInFlight) return;
	clickupRefreshInFlight = true;
	try {
		const statuses = await fetchListTasks(ctx.clickupConfig);
		ctx.clickupTickets = statuses;
		ctx.clickupNextFetchAt = Date.now() + CLICKUP_POLL_INTERVAL_MS;
		ctx.broadcastSink.postMessage({ type: 'clickupTickets', statuses, nextFetchAt: ctx.clickupNextFetchAt });
		autoDarrylPickup(ctx);
		autoJanPickup(ctx);
		autoVisualQaPickup(ctx);
	} catch (err) {
		console.error('[Standalone] ClickUp fetch error:', err);
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: String(err) });
	} finally {
		clickupRefreshInFlight = false;
	}
}

export function autoDarrylPickup(ctx: ServerContext): void {
	// Workers don't auto-pickup — they receive tickets from the hub
	if (ctx.isWorkerMode) return;

	// Collect TODO (and AI REVIEW, if enabled) tickets assigned to Darryl
	const todoTickets: Array<{ id: string; name: string; url: string; status: string }> = [];
	for (const group of ctx.clickupTickets) {
		const statusLower = group.name.toLowerCase();
		if (statusLower !== 'to do' && !(AI_REVIEW_PICKUP_ENABLED && statusLower === 'ai review')) continue;
		for (const task of group.tasks) {
			if (task.assignees.some(a => a.username === DARRYL_CLICKUP_USERNAME)) {
				todoTickets.push({ id: task.id, name: task.name, url: task.url, status: statusLower });
			}
		}
	}

	if (todoTickets.length === 0) return;

	// When AI Review pickup is enabled, prioritize ai-review tickets over to-do
	if (AI_REVIEW_PICKUP_ENABLED) {
		todoTickets.sort((a, b) => {
			if (a.status === 'ai review' && b.status !== 'ai review') return -1;
			if (a.status !== 'ai review' && b.status === 'ai review') return 1;
			return 0;
		});
	}

	const capacity = getAvailableCapacity(ctx, WORKER_ROLE_DEV);
	if (capacity === 0) return;

	const ticketsToAssign = todoTickets.slice(0, capacity);
	const idleWorkers = getIdleWorkers(ctx, WORKER_ROLE_DEV);

	const hubHasDevRole = (ctx.workerIdentity?.roles ?? [...DEFAULT_WORKER_ROLES]).includes(WORKER_ROLE_DEV);
	const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
	const hubAvailable = hubHasDevRole && !darryl?.currentSessionId;

	const slots: Array<{ type: 'hub' } | { type: 'worker'; worker: typeof idleWorkers[0] }> = [];
	if (hubAvailable) slots.push({ type: 'hub' });
	for (const w of idleWorkers) slots.push({ type: 'worker', worker: w });

	const hasRemoteAssignment = ticketsToAssign.length > (hubAvailable ? 1 : 0);
	const memories = hasRemoteAssignment ? collectAgentMemories(ctx.persistentAgents) : {};

	for (let i = 0; i < ticketsToAssign.length && i < slots.length; i++) {
		const ticket = ticketsToAssign[i];
		const slot = slots[i];

		if (slot.type === 'hub') {
			console.log(`[Hub] Assigning ticket ${ticket.id} to local hub (${ctx.workerIdentity?.name || 'Hub'})`);
			if (ctx.workerIdentity) {
				addAssignment(ctx, ticket.id, ticket.name, ctx.workerIdentity.name, 'localhost');
			}
			if (ctx.clickupConfig && ctx.workerIdentity) {
				addTaskComment(ctx.clickupConfig, ticket.id, `Assigned to worker: ${ctx.workerIdentity.name}`).catch(err => {
					console.error(`[Hub] Failed to comment on ticket ${ticket.id}:`, err);
				});
			}
			handleDarrylHandleTicket(
				{ ticketId: ticket.id, ticketName: ticket.name, ticketUrl: ticket.url, ticketStatus: ticket.status },
				ctx,
			);
		} else {
			const { worker } = slot;
			console.log(`[Hub] Assigning ticket ${ticket.id} to worker "${worker.name}" (${worker.hostname}) [${ticket.status}]`);
			addAssignment(ctx, ticket.id, ticket.name, worker.name, worker.hostname);

			worker.ws.send(JSON.stringify({
				type: 'handleTicket',
				ticketId: ticket.id,
				ticketName: ticket.name,
				ticketUrl: ticket.url,
				ticketStatus: ticket.status,
				agentMemories: memories,
			}));

			if (ctx.clickupConfig) {
				addTaskComment(ctx.clickupConfig, ticket.id, `Assigned to worker: ${worker.name}`).catch(err => {
					console.error(`[Hub] Failed to comment on ticket ${ticket.id}:`, err);
				});
			}

			worker.currentTicketId = ticket.id;
			worker.currentTicketName = ticket.name;
		}
	}

	broadcastWorkerStatus(ctx);
}

export function autoJanPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;

	// IDs of every ticket Jan is an assignee on (used to recognise sub-tickets
	// even when they're unassigned).
	const janTicketIds = new Set<string>();
	for (const group of ctx.clickupTickets) {
		for (const task of group.tasks) {
			if (task.assignees.some(a => a.username === JAN_CLICKUP_USERNAME)) {
				janTicketIds.add(task.id);
			}
		}
	}

	// Split Jan's pending tickets by status.
	const refineTickets: TicketInfo[] = [];
	const todoTickets: TicketInfo[] = [];
	const aiReviewTickets: TicketInfo[] = [];
	for (const group of ctx.clickupTickets) {
		const statusLower = group.name.toLowerCase();
		if (statusLower !== 'to refine' && statusLower !== 'to do' && statusLower !== 'ai review') continue;
		if (statusLower === 'ai review' && !AI_REVIEW_PICKUP_ENABLED) continue;
		for (const task of group.tasks) {
			if (!janTicketIds.has(task.id)) continue;
			const ticket: TicketInfo = { ticketId: task.id, ticketName: task.name, ticketUrl: task.url };
			if (statusLower === 'to refine') refineTickets.push(ticket);
			else if (statusLower === 'to do') todoTickets.push(ticket);
			else aiReviewTickets.push(ticket);
		}
	}

	if (refineTickets.length === 0 && todoTickets.length === 0 && aiReviewTickets.length === 0) return;

	// Jan is a single agent — one session at a time.
	const jan = ctx.persistentAgents.find(p => p.name === 'Jan');
	if (jan?.currentSessionId) return;

	// Refine tickets are still single-ticket: one refine ticket spawns 5 UX
	// designers, already saturating the UX team.
	if (refineTickets.length > 0) {
		const ticket = refineTickets[0];
		console.log(`[Standalone] Auto-pickup: Jan taking refine ticket ${ticket.ticketId}`);
		handleJanDesignBriefing(
			{ ...ticket, ticketStatus: 'to refine' },
			ctx,
		);
		return;
	}

	// Unified machine-slot capacity: every machine can run one visual task.
	const cap = computeDesignFleetCapacity(ctx, janTicketIds);

	// Combined batch: fill available slots with whatever's waiting.
	// ai-review first (reviews are quick and drain the queue faster).
	const combined: Array<TicketInfo & { status: 'to do' | 'ai review' }> = [
		...aiReviewTickets.map(t => ({ ...t, status: 'ai review' as const })),
		...todoTickets.map(t => ({ ...t, status: 'to do' as const })),
	];
	const batch = combined.slice(0, cap.available);

	if (batch.length === 0) {
		console.log(`[Standalone] Jan pickup gated: ${cap.active}/${cap.total} machines active (${cap.inProgressCount} in-progress + ${cap.pendingDispatches} pending-dispatch); ${todoTickets.length} todo + ${aiReviewTickets.length} ai-review waiting`);
		return;
	}

	const todoInBatch = batch.filter(b => b.status === 'to do').length;
	const reviewInBatch = batch.filter(b => b.status === 'ai review').length;
	console.log(`[Standalone] Auto-pickup: Jan batch of ${batch.length} (${todoInBatch} to-do, ${reviewInBatch} ai-review) — ${cap.active}/${cap.total} machines already active`);
	handleJanBatchDispatch(batch, ctx);
}

// ── Ticket work ──────────────────────────────────────────────

export function launchAgentOnTicket(
	agentId: string,
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
	ctx: ServerContext,
	options?: { useTeam?: boolean; additionalPrompt?: string; aiReviewMode?: boolean },
): { success: boolean; error?: string } {
	const { persistentAgents } = ctx;
	const pa = persistentAgents.find(p => p.id === agentId);
	if (!pa) return { success: false, error: `Agent not found: ${agentId}` };

	const brief = options?.additionalPrompt?.trim();
	const briefBlock = brief
		? `${brief}\n\n`
		: `⚠ No Brief was passed by Darryl — you'll need to read the ticket yourself.\n\n`;

	let callInTask = options?.aiReviewMode
		? buildWorkerAiReviewInitialTask(ticketId, ticketName, ticketUrl, briefBlock)
		: buildWorkerStandardInitialTask(ticketId, ticketName, ticketUrl, briefBlock);

	const knownProjects = loadKnownProjects();
	const project = knownProjects.find(p => p.workspacePath === pa.workspacePath);
	if (project?.description) {
		callInTask += `\n\n## Project\n${project.description}`;
	}

	if (options?.useTeam) {
		callInTask += '\n\nUse team mode: spawn sub-agents for parallel work.';
	}

	callInTask += EXIT_REMINDER;

	ensureAgentMemory(agentId);
	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}
	if (!launchPersistentAgent(pa, persistentAgents, callInTask, mempalaceHost)) {
		return { success: false, error: 'Failed to launch agent session' };
	}
	return { success: true };
}

export function handleClickupStartWork(msg: Record<string, unknown>, ctx: ServerContext): void {
	const agentId = msg.agentId as string;
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const useTeam = msg.useTeam as boolean | undefined;
	const additionalPrompt = msg.additionalPrompt as string | undefined;

	const result = launchAgentOnTicket(agentId, ticketId, ticketName, ticketUrl, ctx, { useTeam, additionalPrompt });
	if (!result.success) {
		ctx.broadcastSink.postMessage({ type: 'clickupStartWorkError', error: result.error });
	}
}

// ── Configure ────────────────────────────────────────────────

export function handleClickupConfigure(msg: Record<string, unknown>, ctx: ServerContext): void {
	const settings = (readJson(SETTINGS_FILE) ?? {}) as { apiToken?: string; listId?: string };

	const apiToken = msg.apiToken as string | undefined;
	const listId = msg.listId as string | undefined;

	if (apiToken !== undefined) settings.apiToken = apiToken;
	if (listId !== undefined) settings.listId = listId;

	writeJson(SETTINGS_FILE, settings);

	if (!settings.apiToken || !settings.listId) {
		ctx.clickupConfig = null;
		ctx.broadcastSink.postMessage({ type: 'clickupConfigured', configured: false });
		return;
	}

	const config: ClickUpConfig = { apiToken: settings.apiToken, listId: settings.listId };
	ctx.clickupConfig = config;
	ctx.broadcastSink.postMessage({ type: 'clickupConfigured', configured: true, listId: config.listId });

	startClickupPolling(ctx);
	handleClickupRefresh(ctx).catch(() => {});
}

// ── Darryl orchestration ─────────────────────────────────────

export function handleDarrylHandleTicket(msg: Record<string, unknown>, ctx: ServerContext): void {
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const ticketStatus = ((msg.ticketStatus as string | undefined) ?? 'to do').toLowerCase();
	const isAiReviewMode = ticketStatus === 'ai review';
	const { persistentAgents } = ctx;

	const darryl = findOrCreatePersistentAgent(
		persistentAgents,
		'Darryl',
		DARRYL_ROLE_SHORT,
		'The Foreman. Assesses tickets, decides which agents should work on them, and launches them.',
		DARRYL_WORKSPACE,
	);

	if (darryl.currentSessionId) {
		console.log(`[Standalone] Darryl already has an active session ${darryl.currentSessionId}, skipping relaunch for ticket ${ticketId}`);
		return;
	}

	const roster = buildRoster(persistentAgents, darryl.id);
	const systemPrompt = buildDarrylSystemPrompt(darryl, roster, SERVER_PORT);
	const initialTask = (isAiReviewMode
		? buildDarrylAiReviewInitialTask(ticketId, ticketName, ticketUrl)
		: buildDarrylStandardInitialTask(ticketId, ticketName, ticketUrl)
	) + EXIT_REMINDER;

	const result = launchPersistentAgentSession(
		darryl,
		systemPrompt,
		initialTask,
		{ ticketId, ticketName, ticketUrl },
		ctx,
		persistentAgents,
	);
	if (!result.success) {
		console.log(`[Standalone] Failed to launch Darryl for ticket ${ticketId}`);
	}
}

// ── Jan (Art Director) orchestration ────────────────────────

function ensureJan(persistentAgents: PersistentAgent[]): PersistentAgent {
	return findOrCreatePersistentAgent(
		persistentAgents,
		'Jan',
		JAN_ROLE_SHORT,
		'The Art Director. Receives design briefings, delegates to PM and designers, reviews output, and maintains design quality standards.',
		JAN_WORKSPACE,
	);
}

export function handleJanDesignBriefing(msg: Record<string, unknown>, ctx: ServerContext): void {
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const ticketStatus = (msg.ticketStatus as string | undefined) ?? 'to do';
	const { persistentAgents } = ctx;

	const jan = ensureJan(persistentAgents);
	if (jan.currentSessionId) {
		console.log(`[Standalone] Jan already has an active session ${jan.currentSessionId}, skipping relaunch for ticket ${ticketId}`);
		return;
	}

	const roster = buildRoster(persistentAgents, jan.id);
	const systemPrompt = buildJanSystemPrompt(jan, roster, SERVER_PORT);
	const initialTask = (ticketStatus === 'to refine'
		? buildJanRefineInitialTask(ticketId, ticketName, ticketUrl)
		: buildJanSingleTodoInitialTask(ticketId, ticketName, ticketUrl)
	) + EXIT_REMINDER;

	const result = launchPersistentAgentSession(
		jan,
		systemPrompt,
		initialTask,
		{ ticketId, ticketName, ticketUrl },
		ctx,
		persistentAgents,
	);
	if (!result.success) {
		console.log(`[Standalone] Failed to launch Jan for ticket ${ticketId}`);
	}
}

/**
 * Launch Jan with a batch of tickets. She processes them sequentially in one
 * session, firing a curl per ticket; the dispatched agents then run in parallel
 * on their own machines.
 */
export function handleJanBatchDispatch(
	batch: Array<TicketInfo & { status: 'to do' | 'ai review' }>,
	ctx: ServerContext,
): void {
	if (batch.length === 0) return;
	const { persistentAgents } = ctx;

	const jan = ensureJan(persistentAgents);
	if (jan.currentSessionId) {
		console.log(`[Standalone] Jan already has an active session ${jan.currentSessionId}, skipping batch dispatch`);
		return;
	}

	const roster = buildRoster(persistentAgents, jan.id);
	const systemPrompt = buildJanSystemPrompt(jan, roster, SERVER_PORT);
	// Map to the shape buildJanBatchInitialTask expects.
	const initialTask = buildJanBatchInitialTask(
		batch.map(t => ({ id: t.ticketId, name: t.ticketName, url: t.ticketUrl, status: t.status })),
	) + EXIT_REMINDER;

	// Track only the first ticket on the persistent-agent record (used for UI
	// labels); the rest are listed in the initial task.
	const first = batch[0];
	const result = launchPersistentAgentSession(
		jan,
		systemPrompt,
		initialTask,
		first,
		ctx,
		persistentAgents,
	);
	if (!result.success) {
		console.log(`[Standalone] Failed to launch Jan batch of ${batch.length}`);
	}
}

// ── Jan review of designer output ───────────────────────────

export function handleJanReviewDesigner(
	completedTicket: { ticketId: string; ticketName: string; ticketUrl: string; designerName: string; workspacePath: string },
	ctx: ServerContext,
): void {
	const { ticketId, ticketName, ticketUrl, designerName } = completedTicket;
	const { persistentAgents } = ctx;

	const jan = ensureJan(persistentAgents);
	if (jan.currentSessionId) {
		console.log(`[Standalone] Jan already has an active session ${jan.currentSessionId}, skipping review for ticket ${ticketId}`);
		return;
	}

	const roster = buildRoster(persistentAgents, jan.id);
	const systemPrompt = buildJanSystemPrompt(jan, roster, SERVER_PORT);
	const initialTask = buildJanReviewPrompt({ ticketId, ticketName, ticketUrl, designerName }) + EXIT_REMINDER;

	const result = launchPersistentAgentSession(
		jan,
		systemPrompt,
		initialTask,
		{ ticketId, ticketName, ticketUrl },
		ctx,
		persistentAgents,
		{ withPeers: true },
	);
	if (!result.success) {
		console.log(`[Standalone] Failed to launch Jan for review of ticket ${ticketId}`);
	}
}

// ── Fleet dispatch (hub-only) ───────────────────────────────
// Figma lock is PER DEVICE. Jan can have one designer or QA running on the hub
// AND one on each remote worker simultaneously — this dispatcher cascades a
// dispatch request to a free remote worker when the local Figma is busy.

async function dispatchToFleet(
	msg: Record<string, unknown>,
	ctx: ServerContext,
	rpcType: 'launchDesigner' | 'launchVisualDesigner' | 'launchVisualQa',
	localError?: string,
): Promise<{ success: boolean; error?: string; worker?: string }> {
	const ticketId = msg.ticketId as string | undefined;
	const ticketName = msg.ticketName as string | undefined;
	const remoteWorkers = getIdleWorkersWithRole(ctx, WORKER_ROLE_DESIGNER);
	if (remoteWorkers.length === 0) {
		return { success: false, error: localError
			? `${localError} No idle remote designer workers connected — wait and retry.`
			: 'Local Figma busy and no remote designer workers connected — wait and retry.' };
	}

	// Ship agent memories so the agent spawned on the worker has up-to-date context
	const agentMemories = collectAgentMemories(ctx.persistentAgents);
	const rpcPayload = { ...msg, agentMemories };

	const failures: string[] = [];
	for (const worker of remoteWorkers) {
		console.log(`[Hub] Trying to dispatch ${rpcType} for ticket ${ticketId} → worker "${worker.name}" (${worker.hostname})`);
		const resp = await sendWorkerRequest(ctx, worker, { type: rpcType, payload: rpcPayload });
		if (resp.success) {
			if (ticketId) {
				worker.currentTicketId = ticketId;
				worker.currentTicketName = ticketName ?? ticketId;
			}
			broadcastWorkerStatus(ctx);
			console.log(`[Hub] Worker "${worker.name}" accepted ${rpcType} for ticket ${ticketId}`);
			return { success: true, worker: worker.name };
		}
		failures.push(`${worker.name}: ${resp.error ?? 'declined'}`);
	}

	return { success: false, error: localError
		? `${localError} Tried ${failures.length} remote worker(s) — all busy or unreachable (${failures.join('; ')}).`
		: `All ${failures.length} remote designer worker(s) busy or unreachable (${failures.join('; ')}).` };
}

// ── UX Designer ─────────────────────────────────────────────

/**
 * Launch a UX designer on a briefing ticket. Tries the local Figma slot first,
 * cascades to any idle remote designer worker when busy.
 */
export async function handleLaunchDesigner(msg: Record<string, unknown>, ctx: ServerContext): Promise<{ success: boolean; error?: string; worker?: string }> {
	const local = tryLaunchDesignerLocal(msg, ctx);
	if (local.success) return { ...local, worker: ctx.workerIdentity?.name };
	if (!ctx.isWorkerMode && local.figmaBusy) {
		return dispatchToFleet(msg, ctx, 'launchDesigner', local.error);
	}
	return local;
}

function tryLaunchDesignerLocal(msg: Record<string, unknown>, ctx: ServerContext): { success: boolean; error?: string; figmaBusy?: boolean } {
	const workspacePath = msg.workspacePath as string;
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const revisionMode = msg.revisionMode as boolean | undefined;
	const brief = typeof msg.additionalPrompt === 'string' ? msg.additionalPrompt.trim() : '';

	if (!workspacePath) return { success: false, error: 'Missing required field: workspacePath' };
	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	const { persistentAgents } = ctx;

	const activeFigma = findFigmaLockHolder(persistentAgents);
	if (activeFigma) {
		return { success: false, figmaBusy: true, error: `Local Figma busy: "${activeFigma.name}" (${activeFigma.roleShort}) is already running.` };
	}

	const knownProjects = loadKnownProjects();
	const projName = path.basename(workspacePath);
	const project = knownProjects.find(k => k.name === projName);
	const projectDescription = project?.description;

	const designer = persistentAgents.find(
		p => p.roleShort === DESIGNER_ROLE_SHORT
			&& p.teamId === TEAM_UX_ID
			&& !p.currentSessionId
			&& !p.retired,
	);
	if (!designer) return { success: false, error: 'No free UX Designers available — all team members are busy.' };

	designer.workspacePath = workspacePath;
	const systemPrompt = buildDesignerSystemPrompt(designer, projectDescription);

	const briefBlock = brief
		? `${brief}\n\n`
		: `⚠ No Brief was passed by Jan — you will need to read the ticket description yourself.\n\n`;

	const initialTask = buildUxDesignerInitialTask(ticketId, ticketName, ticketUrl, briefBlock, !!revisionMode) + EXIT_REMINDER;

	const result = launchPersistentAgentSession(
		designer,
		systemPrompt,
		initialTask,
		{ ticketId, ticketName, ticketUrl },
		ctx,
		persistentAgents,
	);
	if (result.success) {
		console.log(`[Standalone] Launched designer "${designer.name}" for ticket ${ticketId}`);
	} else {
		console.log(`[Standalone] Failed to launch designer "${designer.name}" for ticket ${ticketId}`);
	}
	return result;
}

// ── Visual Designer (Phase 2) ───────────────────────────────

export async function handleLaunchVisualDesigner(msg: Record<string, unknown>, ctx: ServerContext): Promise<{ success: boolean; error?: string; worker?: string }> {
	const local = tryLaunchVisualDesignerLocal(msg, ctx);
	if (local.success) return { ...local, worker: ctx.workerIdentity?.name };
	if (!ctx.isWorkerMode && local.figmaBusy) {
		return dispatchToFleet(msg, ctx, 'launchVisualDesigner', local.error);
	}
	return local;
}

function tryLaunchVisualDesignerLocal(msg: Record<string, unknown>, ctx: ServerContext): { success: boolean; error?: string; figmaBusy?: boolean } {
	const workspacePath = msg.workspacePath as string;
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const revisionMode = msg.revisionMode as boolean | undefined;
	const brief = typeof msg.additionalPrompt === 'string' ? msg.additionalPrompt.trim() : '';

	if (!workspacePath) return { success: false, error: 'Missing required field: workspacePath' };
	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	const { persistentAgents } = ctx;

	const activeFigma = findFigmaLockHolder(persistentAgents);
	if (activeFigma) {
		return { success: false, figmaBusy: true, error: `Local Figma busy: "${activeFigma.name}" (${activeFigma.roleShort}) is already running.` };
	}

	const knownProjects = loadKnownProjects();
	const projName = path.basename(workspacePath);
	const project = knownProjects.find(k => k.name === projName);
	const projectDescription = project?.description;

	const designer = persistentAgents.find(
		p => p.roleShort === VISUAL_DESIGNER_ROLE_SHORT
			&& p.teamId === TEAM_VISUAL_ID
			&& !p.currentSessionId
			&& !p.retired,
	);
	if (!designer) return { success: false, error: 'No free Visual Designers available — all team members are busy.' };

	designer.workspacePath = workspacePath;
	const designConfig = getJanDesignConfig();
	const systemPrompt = buildVisualDesignerSystemPrompt(designer, projectDescription, designConfig);

	const briefBlock = brief
		? `${brief}\n\n`
		: `⚠ No Brief was passed by Jan — look at the ticket to find the approved UX Figma node.\n\n`;

	const initialTask = buildVisualDesignerInitialTask(ticketId, ticketName, ticketUrl, briefBlock, !!revisionMode) + EXIT_REMINDER;

	const result = launchPersistentAgentSession(
		designer,
		systemPrompt,
		initialTask,
		{ ticketId, ticketName, ticketUrl },
		ctx,
		persistentAgents,
	);
	if (result.success) {
		console.log(`[Standalone] Launched visual designer "${designer.name}" for ticket ${ticketId}`);
	} else {
		console.log(`[Standalone] Failed to launch visual designer "${designer.name}" for ticket ${ticketId}`);
	}
	return result;
}

// ── Visual QA AI Review ─────────────────────────────────────

/**
 * Dispatch the Visual Quality Reviewer on an "ai review" ticket. Tries the
 * local machine's Figma slot first, cascades to a free remote worker if busy.
 */
export async function handleVisualQaReview(
	completedTicket: { ticketId: string; ticketName: string; ticketUrl: string; designerName: string; workspacePath: string },
	ctx: ServerContext,
): Promise<{ success: boolean; error?: string; worker?: string }> {
	const local = tryLaunchVisualQaLocal(completedTicket, ctx);
	if (local.success) return { ...local, worker: ctx.workerIdentity?.name };
	if (!ctx.isWorkerMode && local.figmaBusy) {
		const msg: Record<string, unknown> = {
			ticketId: completedTicket.ticketId,
			ticketName: completedTicket.ticketName,
			ticketUrl: completedTicket.ticketUrl,
			designerName: completedTicket.designerName,
			workspacePath: completedTicket.workspacePath,
		};
		return dispatchToFleet(msg, ctx, 'launchVisualQa', local.error);
	}
	return local;
}

function tryLaunchVisualQaLocal(
	completedTicket: { ticketId: string; ticketName: string; ticketUrl: string; designerName: string; workspacePath: string },
	ctx: ServerContext,
): { success: boolean; error?: string; figmaBusy?: boolean } {
	const { ticketId, ticketName, ticketUrl, designerName } = completedTicket;
	const { persistentAgents } = ctx;

	const activeFigma = findFigmaLockHolder(persistentAgents);
	if (activeFigma) {
		return { success: false, figmaBusy: true, error: `Local Figma busy: "${activeFigma.name}" (${activeFigma.roleShort}) is already running.` };
	}

	const qa = persistentAgents.find(
		p => p.roleShort === VISUAL_QA_ROLE_SHORT && p.teamId === TEAM_VISUAL_ID,
	);
	if (!qa) return { success: false, error: 'No Visual QA agent seeded on this machine' };

	const qaDesignConfig = getJanDesignConfig();
	const systemPrompt = buildVisualQaSystemPrompt(qa, qaDesignConfig);
	const initialTask = buildVisualQaInitialTask({ ticketId, ticketName, ticketUrl, designerName }) + EXIT_REMINDER;

	const result = launchPersistentAgentSession(
		qa,
		systemPrompt,
		initialTask,
		{ ticketId, ticketName, ticketUrl },
		ctx,
		persistentAgents,
		{ withPeers: true },
	);
	if (result.success) {
		console.log(`[Standalone] Launched Visual QA "${qa.name}" for AI review of ticket ${ticketId}`);
	}
	return result;
}

/**
 * Safety net: scan ClickUp for ai-review tickets assigned to Jan that nobody
 * picked up (e.g. after a server restart). Jan's normal batch pickup handles
 * these on every poll — this exists as a belt-and-braces catch.
 */
export function autoVisualQaPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;
	if (!AI_REVIEW_PICKUP_ENABLED) return;

	const qa = ctx.persistentAgents.find(
		p => p.roleShort === VISUAL_QA_ROLE_SHORT && p.teamId === TEAM_VISUAL_ID,
	);
	if (!qa || qa.currentSessionId) return;

	for (const group of ctx.clickupTickets) {
		if (group.name.toLowerCase() !== 'ai review') continue;
		// Only Jan's tickets — Darryl's ai review tickets go through autoDarrylPickup.
		const ticket = group.tasks.find(t =>
			t.assignees.some(a => a.username === JAN_CLICKUP_USERNAME),
		);
		if (!ticket) continue;
		console.log(`[Standalone] Auto-pickup: Visual QA taking stranded ai-review ticket ${ticket.id}`);
		handleVisualQaReview({
			ticketId: ticket.id,
			ticketName: ticket.name,
			ticketUrl: ticket.url,
			designerName: 'unknown',
			workspacePath: qa.workspacePath,
		}, ctx).catch(err => console.error('[Standalone] Visual QA pickup dispatch failed:', err));
		return;
	}
}

// ── Auto-revision pickup ────────────────────────────────────

export function autoDesignerRevisionPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;

	// Figma lock covers revision relaunches too.
	const activeDesigner = ctx.persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT || p.roleShort === VISUAL_DESIGNER_ROLE_SHORT) && p.currentSessionId,
	);
	if (activeDesigner) return;

	const revisionTickets: Array<{ id: string; name: string; url: string }> = [];
	for (const group of ctx.clickupTickets) {
		if (group.name.toLowerCase() !== 'revision needed') continue;
		for (const task of group.tasks) {
			revisionTickets.push({ id: task.id, name: task.name, url: task.url });
		}
	}

	if (revisionTickets.length === 0) return;

	const ticket = revisionTickets[0];
	const previousDesigner = ctx.persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT || p.roleShort === VISUAL_DESIGNER_ROLE_SHORT)
			&& !p.currentSessionId
			&& p.lastTicketId === ticket.id,
	);
	if (!previousDesigner) {
		console.log(`[Standalone] No idle designer found for revision ticket ${ticket.id}`);
		return;
	}

	const launchHandler = previousDesigner.roleShort === VISUAL_DESIGNER_ROLE_SHORT
		? handleLaunchVisualDesigner
		: handleLaunchDesigner;

	console.log(`[Standalone] Auto-revision: relaunching ${previousDesigner.roleShort.toLowerCase()} "${previousDesigner.name}" for ticket ${ticket.id}`);
	launchHandler(
		{
			workspacePath: previousDesigner.workspacePath,
			ticketId: ticket.id,
			ticketName: ticket.name,
			ticketUrl: ticket.url,
			revisionMode: true,
		},
		ctx,
	);
}

// ── Worker-originated designer session-end hook ────────────

/**
 * Called on the hub when a remote worker reports that one of its design-role
 * sessions ended (UX Designer, Visual Designer, or Visual QA). Mirrors the
 * server-local onSessionStale side-effects so Jan review / Visual QA / revision
 * pickup still fire even though the session ran on a different machine.
 */
export function handleDesignerSessionEnded(
	msg: Record<string, unknown>,
	ctx: ServerContext,
	sourceWs: import('ws').WebSocket,
): void {
	const agentRole = msg.agentRole as string | undefined;
	const ticketId = msg.ticketId as string | undefined;
	const ticketName = (msg.ticketName as string | undefined) ?? '';
	const ticketUrl = (msg.ticketUrl as string | undefined) ?? '';
	const designerName = (msg.designerName as string | undefined) ?? 'unknown';
	const workspacePath = (msg.workspacePath as string | undefined) ?? '';
	const updatedMemory = msg.updatedMemory as string | undefined;
	const agentId = msg.agentId as string | undefined;

	clearWorkerTicket(sourceWs, ctx);

	if (agentId && updatedMemory) {
		saveAgentMemoryFromWorker(agentId, updatedMemory);
	}

	if (!ticketId) {
		console.log(`[Hub] Ignoring designerSessionEnded without ticketId (agentRole=${agentRole})`);
		return;
	}

	const completedTicket = { ticketId, ticketName, ticketUrl, designerName, workspacePath };

	if (agentRole === VISUAL_DESIGNER_ROLE_SHORT) {
		if (AI_REVIEW_AUTO_ESCALATE) {
			console.log(`[Hub] Remote Visual Designer finished ticket ${ticketId} — triggering Visual QA AI review`);
			setTimeout(() => { handleVisualQaReview(completedTicket, ctx).catch(err => console.error('[Hub] Visual QA dispatch failed:', err)); }, REVIEW_TRIGGER_DELAY_MS);
		} else {
			console.log(`[Hub] Remote Visual Designer finished ticket ${ticketId} — auto-escalation paused, no auto-QA`);
		}
		return;
	}
	if (agentRole === DESIGNER_ROLE_SHORT) {
		console.log(`[Hub] Remote UX Designer finished ticket ${ticketId} — triggering Jan review`);
		setTimeout(() => handleJanReviewDesigner(completedTicket, ctx), REVIEW_TRIGGER_DELAY_MS);
		return;
	}
	if (agentRole === VISUAL_QA_ROLE_SHORT) {
		if (AI_REVIEW_AUTO_ESCALATE) {
			console.log(`[Hub] Remote Visual QA finished ticket ${ticketId} — running revision pickup`);
			setTimeout(() => autoDesignerRevisionPickup(ctx), REVIEW_TRIGGER_DELAY_MS);
		}
		return;
	}
	if (agentRole === JAN_ROLE_SHORT) {
		console.log(`[Hub] Remote Jan finished ticket ${ticketId} — running revision pickup`);
		setTimeout(() => autoDesignerRevisionPickup(ctx), REVIEW_TRIGGER_DELAY_MS);
		return;
	}
	console.log(`[Hub] Remote session ended: role=${agentRole} ticket=${ticketId} (no follow-up configured)`);
}

// Re-export capacity helper — several tests/handlers call it from this module.
export { getDesignerMachineCapacity };
