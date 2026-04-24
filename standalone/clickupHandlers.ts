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
	WORKER_ROLE_DESIGNER,
	AI_REVIEW_PICKUP_ENABLED,
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
	getIdleWorkersWithRole,
	collectAgentMemories,
	broadcastWorkerStatus,
	sendWorkerRequest,
	clearWorkerTicket,
	saveAgentMemoryFromWorker,
} from './workerRegistry.js';
import { loadKnownProjects } from '../src/projectStore.js';

import {
	findBusyVisualSlot,
	getDesignerMachineCapacity,
	computeDesignFleetCapacity,
} from './capacity.js';
import {
	EXIT_REMINDER,
	launchPersistentAgentSession,
	type TicketInfo,
} from './launchHelpers.js';
import {
	claimTicket,
	releaseTicket,
	claimedTicketIds,
} from './dispatchRegistry.js';
import {
	selectDarrylPickups,
	selectJanPickups,
} from './pickupPlanner.js';
import {
	buildWorkerAiReviewInitialTask,
	buildWorkerStandardInitialTask,
	buildDarrylBatchInitialTask,
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

/**
 * Dispatch policy: specialists are NEVER auto-launched in response to a
 * reactive event (worker-free, session-end, ClickUp status change, webview
 * connect). The only two things that can start work are:
 *   1. The 3-minute ClickUp polling loop (`startClickupPolling`).
 *   2. An explicit manual refresh from the kantoor webview
 *      (`clickupRefresh` message → `handleClickupRefresh`).
 *
 * Both funnel through `runAutoPickupNow`, which fires autoDarrylPickup +
 * autoJanPickup against freshly-fetched ClickUp state. There is no
 * reactive-pickup-on-worker-free function.
 */
export function runAutoPickupNow(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;
	autoDarrylPickup(ctx);
	autoJanPickup(ctx);
}


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
		runAutoPickupNow(ctx);
	} catch (err) {
		console.error('[Standalone] ClickUp fetch error:', err);
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: String(err) });
	} finally {
		clickupRefreshInFlight = false;
	}
}

export function autoDarrylPickup(ctx: ServerContext): void {
	// Workers don't auto-pickup — hub is the single orchestrator entry point.
	if (ctx.isWorkerMode) return;

	// Decision pass (pure — see pickupPlanner.ts). Drops anything already in
	// flight via the registry, filters to Darryl's assignee scope, sorts
	// ai-review before to-do so short review cycles drain first.
	const inFlight = claimedTicketIds(ctx.dispatchRegistry);
	const todoTickets = selectDarrylPickups(ctx.clickupTickets, inFlight, DARRYL_CLICKUP_USERNAME, AI_REVIEW_PICKUP_ENABLED);

	if (todoTickets.length === 0) return;

	// Single-orchestrator pattern (same shape as autoJanPickup): Darryl is the
	// sole dispatch decision-maker for dev tickets. If he's already running,
	// skip — his current session will dispatch its batch, the next poll picks
	// up whatever's still "to do".
	const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
	if (darryl?.currentSessionId) return;

	const batch: Array<TicketInfo & { status: 'to do' | 'ai review' }> = todoTickets.map(t => ({
		ticketId: t.id,
		ticketName: t.name,
		ticketUrl: t.url,
		status: t.status,
	}));

	console.log(`[Standalone] Auto-pickup: Darryl batch of ${batch.length} (${batch.filter(b => b.status === 'to do').length} to-do, ${batch.filter(b => b.status === 'ai review').length} ai-review)`);
	handleDarrylBatchDispatch(batch, ctx);
}

export function autoJanPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;

	// Decision pass (pure — see pickupPlanner.ts). Jan is the single entry
	// point for all design work across four ClickUp statuses:
	//   - "to refine": write 5 UX briefings, dispatch 5 UX designers
	//   - "to do": dispatch one Visual Designer
	//   - "ai review": dispatch Visual QA (curl-only; no Figma from Jan)
	//   - "revision needed": dispatch a designer with revisionMode=true
	// There is no separate revision-pickup or QA-safety-net function — every
	// design dispatch runs through Jan so she can make the actual call about
	// who picks up the work.
	const inFlight = claimedTicketIds(ctx.dispatchRegistry);
	const buckets = selectJanPickups(ctx.clickupTickets, inFlight, JAN_CLICKUP_USERNAME, AI_REVIEW_PICKUP_ENABLED);
	const refineTickets: TicketInfo[] = buckets.refine.map(t => ({ ticketId: t.id, ticketName: t.name, ticketUrl: t.url }));
	const todoTickets: TicketInfo[] = buckets.todo.map(t => ({ ticketId: t.id, ticketName: t.name, ticketUrl: t.url }));
	const aiReviewTickets: TicketInfo[] = buckets.aiReview.map(t => ({ ticketId: t.id, ticketName: t.name, ticketUrl: t.url }));
	const revisionTickets: TicketInfo[] = buckets.revision.map(t => ({ ticketId: t.id, ticketName: t.name, ticketUrl: t.url }));

	if (
		refineTickets.length === 0
		&& todoTickets.length === 0
		&& aiReviewTickets.length === 0
		&& revisionTickets.length === 0
	) return;

	const janTicketIds = buckets.janTicketIds;

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
	// ai-review first (reviews are quick), then revisions (continuing work),
	// then new to-do tickets.
	const combined: Array<TicketInfo & { status: 'to do' | 'ai review' | 'revision needed' }> = [
		...aiReviewTickets.map(t => ({ ...t, status: 'ai review' as const })),
		...revisionTickets.map(t => ({ ...t, status: 'revision needed' as const })),
		...todoTickets.map(t => ({ ...t, status: 'to do' as const })),
	];
	const batch = combined.slice(0, cap.available);

	if (batch.length === 0) {
		console.log(`[Standalone] Jan pickup gated: ${cap.active}/${cap.total} machines active (${cap.inProgressCount} in-progress + ${cap.pendingDispatches} pending-dispatch); ${todoTickets.length} todo + ${aiReviewTickets.length} ai-review + ${revisionTickets.length} revision waiting`);
		return;
	}

	const todoInBatch = batch.filter(b => b.status === 'to do').length;
	const reviewInBatch = batch.filter(b => b.status === 'ai review').length;
	const revisionInBatch = batch.filter(b => b.status === 'revision needed').length;
	console.log(`[Standalone] Auto-pickup: Jan batch of ${batch.length} (${todoInBatch} to-do, ${reviewInBatch} ai-review, ${revisionInBatch} revision) — ${cap.active}/${cap.total} machines already active`);
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

	// Claim the ticket BEFORE we do any launch work. If another dispatch path
	// already holds it, bail — Darryl's next pickup cycle (or the retry in
	// his prompt) will re-evaluate.
	const claimed = ticketId
		? claimTicket(ctx.dispatchRegistry, ticketId, pa.name, options?.aiReviewMode ? 'dev-worker-ai-review' : 'dev-worker')
		: false;
	if (ticketId && !claimed) {
		const existing = ctx.dispatchRegistry.get(ticketId);
		return { success: false, error: `Ticket ${ticketId} is already in flight (claimed by "${existing?.claimedBy ?? '?'}" for "${existing?.purpose ?? '?'}").` };
	}

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
	// Track the ticket on the persistent agent so onSessionStale can release
	// the claim when the session ends.
	pa.currentTicketId = ticketId;
	pa.currentTicketName = ticketName;
	pa.currentTicketUrl = ticketUrl;
	if (!launchPersistentAgent(pa, persistentAgents, callInTask, mempalaceHost)) {
		// Rollback the claim AND the ticket tracking — slot is free again.
		if (claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
		pa.currentTicketId = undefined;
		pa.currentTicketName = undefined;
		pa.currentTicketUrl = undefined;
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

// ── Shared orchestrator batch dispatch ──────────────────────

/**
 * Launch an orchestrator (Darryl or Jan) with a batch of tickets. The
 * orchestrator processes them sequentially in one session, firing a dispatch
 * curl per ticket; the dispatched workers run in parallel on their own
 * machines.
 *
 * Orchestrators are pure — they never claim tickets in the dispatch registry
 * themselves. The per-worker dispatch endpoints (launchAgentOnTicket,
 * handleLaunchDesigner, handleLaunchVisualDesigner, handleVisualQaReview)
 * own the claims. Orchestrator race-protection is the singleton
 * `currentSessionId` on the persistent-agent record — NOT a registry claim.
 *
 * The ONLY per-orchestrator differences live in the spec: which agent to
 * find/create, which system prompt to build, which batch initial-task to
 * build. Everything else (roster, singleton gate, first-ticket tracking,
 * launch, logging) is shared.
 */
interface OrchestratorBatchSpec<S extends string> {
	/** Display name used in logs — e.g. "Darryl", "Jan". */
	name: string;
	ensureAgent: (persistentAgents: PersistentAgent[]) => PersistentAgent;
	buildSystemPrompt: (agent: PersistentAgent, roster: RosterEntry[]) => string;
	buildInitialTask: (
		batch: Array<{ id: string; name: string; url: string; status: S }>,
	) => string;
}

function dispatchOrchestratorBatch<S extends string>(
	spec: OrchestratorBatchSpec<S>,
	batch: Array<TicketInfo & { status: S }>,
	ctx: ServerContext,
): void {
	if (batch.length === 0) return;
	const { persistentAgents } = ctx;

	const agent = spec.ensureAgent(persistentAgents);
	if (agent.currentSessionId) {
		console.log(`[Standalone] ${spec.name} already has an active session ${agent.currentSessionId}, skipping batch dispatch of ${batch.length}`);
		return;
	}

	const roster = buildRoster(persistentAgents, agent.id);
	const systemPrompt = spec.buildSystemPrompt(agent, roster);
	const initialTask = spec.buildInitialTask(
		batch.map(t => ({ id: t.ticketId, name: t.ticketName, url: t.ticketUrl, status: t.status })),
	) + EXIT_REMINDER;

	// Track only the first ticket on the persistent-agent record (used for UI
	// labels); the rest are listed in the initial task.
	const first = batch[0];
	const result = launchPersistentAgentSession(
		agent,
		systemPrompt,
		initialTask,
		first,
		ctx,
		persistentAgents,
	);
	if (!result.success) {
		console.log(`[Standalone] Failed to launch ${spec.name} batch of ${batch.length}`);
	}
}

// ── Darryl orchestration ─────────────────────────────────────

function ensureDarryl(persistentAgents: PersistentAgent[]): PersistentAgent {
	return findOrCreatePersistentAgent(
		persistentAgents,
		'Darryl',
		DARRYL_ROLE_SHORT,
		'The Foreman. Assesses tickets, decides which agents should work on them, and launches them.',
		DARRYL_WORKSPACE,
	);
}

export function handleDarrylBatchDispatch(
	batch: Array<TicketInfo & { status: 'to do' | 'ai review' }>,
	ctx: ServerContext,
): void {
	dispatchOrchestratorBatch(
		{
			name: 'Darryl',
			ensureAgent: ensureDarryl,
			buildSystemPrompt: (agent, roster) => buildDarrylSystemPrompt(agent, roster, SERVER_PORT),
			buildInitialTask: buildDarrylBatchInitialTask,
		},
		batch,
		ctx,
	);
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
	const systemPrompt = buildJanSystemPrompt(jan, roster, SERVER_PORT, getJanDesignConfig());
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

export function handleJanBatchDispatch(
	batch: Array<TicketInfo & { status: 'to do' | 'ai review' | 'revision needed' }>,
	ctx: ServerContext,
): void {
	dispatchOrchestratorBatch(
		{
			name: 'Jan',
			ensureAgent: ensureJan,
			buildSystemPrompt: (agent, roster) => buildJanSystemPrompt(agent, roster, SERVER_PORT, getJanDesignConfig()),
			buildInitialTask: buildJanBatchInitialTask,
		},
		batch,
		ctx,
	);
}

// ── Fleet dispatch (hub-only) ───────────────────────────────
// Visual-slot lock is PER DEVICE. Jan can have one designer or QA running on
// the hub AND one on each remote worker simultaneously — this dispatcher
// cascades a dispatch request to a free remote worker when the local visual
// slot is busy.

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
 *
 * Claim lifecycle: we claim the ticket in the dispatch registry at entry. If
 * every launch path fails (local unavailable AND no remote worker ACKs), we
 * release so Jan's next retry can succeed. If any path succeeds, the claim
 * is held until session-end (handleDesignerSessionEnded or onSessionStale).
 */
export async function handleLaunchDesigner(msg: Record<string, unknown>, ctx: ServerContext): Promise<{ success: boolean; error?: string; worker?: string }> {
	const ticketId = typeof msg.ticketId === 'string' ? msg.ticketId : '';
	const claimed = ticketId
		? claimTicket(ctx.dispatchRegistry, ticketId, ctx.workerIdentity?.name ?? 'Hub', 'ux-designer')
		: false;
	if (ticketId && !claimed) {
		const existing = ctx.dispatchRegistry.get(ticketId);
		return { success: false, error: `Ticket ${ticketId} is already in flight (claimed by "${existing?.claimedBy ?? '?'}" for "${existing?.purpose ?? '?'}").` };
	}

	const local = tryLaunchDesignerLocal(msg, ctx);
	if (local.success) return { ...local, worker: ctx.workerIdentity?.name };
	if (!ctx.isWorkerMode && local.visualSlotBusy) {
		const fleet = await dispatchToFleet(msg, ctx, 'launchDesigner', local.error);
		if (!fleet.success && claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
		return fleet;
	}
	if (claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
	return local;
}

function tryLaunchDesignerLocal(msg: Record<string, unknown>, ctx: ServerContext): { success: boolean; error?: string; visualSlotBusy?: boolean } {
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

	const busySlot = findBusyVisualSlot(persistentAgents);
	if (busySlot) {
		return { success: false, visualSlotBusy: true, error: `Local visual slot busy: "${busySlot.name}" (${busySlot.roleShort}) is already running on this machine.` };
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
	const designConfig = getJanDesignConfig();
	const systemPrompt = buildDesignerSystemPrompt(designer, projectDescription, designConfig);

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
	const ticketId = typeof msg.ticketId === 'string' ? msg.ticketId : '';
	const claimed = ticketId
		? claimTicket(ctx.dispatchRegistry, ticketId, ctx.workerIdentity?.name ?? 'Hub', 'visual-designer')
		: false;
	if (ticketId && !claimed) {
		const existing = ctx.dispatchRegistry.get(ticketId);
		return { success: false, error: `Ticket ${ticketId} is already in flight (claimed by "${existing?.claimedBy ?? '?'}" for "${existing?.purpose ?? '?'}").` };
	}

	const local = tryLaunchVisualDesignerLocal(msg, ctx);
	if (local.success) return { ...local, worker: ctx.workerIdentity?.name };
	if (!ctx.isWorkerMode && local.visualSlotBusy) {
		const fleet = await dispatchToFleet(msg, ctx, 'launchVisualDesigner', local.error);
		if (!fleet.success && claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
		return fleet;
	}
	if (claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
	return local;
}

function tryLaunchVisualDesignerLocal(msg: Record<string, unknown>, ctx: ServerContext): { success: boolean; error?: string; visualSlotBusy?: boolean } {
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

	const busySlot = findBusyVisualSlot(persistentAgents);
	if (busySlot) {
		return { success: false, visualSlotBusy: true, error: `Local visual slot busy: "${busySlot.name}" (${busySlot.roleShort}) is already running on this machine.` };
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
	const ticketId = completedTicket.ticketId;
	const claimed = ticketId
		? claimTicket(ctx.dispatchRegistry, ticketId, ctx.workerIdentity?.name ?? 'Hub', 'visual-qa')
		: false;
	if (ticketId && !claimed) {
		const existing = ctx.dispatchRegistry.get(ticketId);
		return { success: false, error: `Ticket ${ticketId} is already in flight (claimed by "${existing?.claimedBy ?? '?'}" for "${existing?.purpose ?? '?'}").` };
	}

	const local = tryLaunchVisualQaLocal(completedTicket, ctx);
	if (local.success) return { ...local, worker: ctx.workerIdentity?.name };
	if (!ctx.isWorkerMode && local.visualSlotBusy) {
		const msg: Record<string, unknown> = {
			ticketId: completedTicket.ticketId,
			ticketName: completedTicket.ticketName,
			ticketUrl: completedTicket.ticketUrl,
			designerName: completedTicket.designerName,
			workspacePath: completedTicket.workspacePath,
		};
		const fleet = await dispatchToFleet(msg, ctx, 'launchVisualQa', local.error);
		if (!fleet.success && claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
		return fleet;
	}
	if (claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
	return local;
}

function tryLaunchVisualQaLocal(
	completedTicket: { ticketId: string; ticketName: string; ticketUrl: string; designerName: string; workspacePath: string },
	ctx: ServerContext,
): { success: boolean; error?: string; visualSlotBusy?: boolean } {
	const { ticketId, ticketName, ticketUrl, designerName } = completedTicket;
	const { persistentAgents } = ctx;

	const busySlot = findBusyVisualSlot(persistentAgents);
	if (busySlot) {
		return { success: false, visualSlotBusy: true, error: `Local visual slot busy: "${busySlot.name}" (${busySlot.roleShort}) is already running on this machine.` };
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

// ── Worker-originated designer session-end hook ────────────

/**
 * Called on the hub when a remote worker reports that one of its design-role
 * sessions ended (UX Designer, Visual Designer, or Visual QA, or Jan). Frees
 * the worker slot and the dispatch claim, optionally kicks off the QA step
 * for a freshly-finished Visual Designer (when auto-escalation is on), and
 * fires the generic autoPickupAfterWorkerFree so Jan can batch the next
 * round of design work.
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

	// clearWorkerTicket releases the claim via the registry, clears the worker
	// slot, and broadcasts status.
	clearWorkerTicket(sourceWs, ctx);

	if (agentId && updatedMemory) {
		saveAgentMemoryFromWorker(agentId, updatedMemory);
	}

	if (!ticketId) {
		console.log(`[Hub] Ignoring designerSessionEnded without ticketId (agentRole=${agentRole})`);
		return;
	}

	const completedTicket = { ticketId, ticketName, ticketUrl, designerName, workspacePath };

	// No reactive auto-dispatch. If the ticket is now in "ai review", the next
	// 3-min ClickUp poll (or a manual refresh) will hand it to Jan via
	// autoJanPickup → she dispatches Visual QA. We deliberately do NOT chain a
	// specialist launch from a worker-free event — specialists are only
	// started by the poll or the kantoor manual refresh.
	void completedTicket;
	void agentRole;
}

// Re-export capacity helper — several tests/handlers call it from this module.
export { getDesignerMachineCapacity };
