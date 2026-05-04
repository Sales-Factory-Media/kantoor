/**
 * Worker dispatch endpoints — the launchers that actually start per-worker
 * sessions on a ticket.
 *
 * All four endpoints (dev worker, UX designer, Visual designer, Visual QA)
 * funnel through `dispatchWorker`, which handles:
 *   1. Atomic ticket claim in the dispatch registry.
 *   2. Local launch via a role-specific `tryLaunchLocal` callback.
 *   3. Optional fleet cascade to a remote worker if the local visual slot is
 *      busy (design roles only — dev workers stay on the hub).
 *   4. Claim release on full failure.
 *
 * Each role provides a `WorkerDispatchSpec`. The role-specific bits are:
 *   - `purpose`: registry claim purpose.
 *   - `tryLaunchLocal`: find a free agent on the hub and launch them.
 *   - `fleet?`: how to ship the dispatch to a remote worker via WebSocket RPC.
 *
 * If you add a fifth role, write a spec — do NOT copy-paste a handler.
 *
 * ## Claim lifecycle
 * `dispatchWorker` claims at entry, releases on full failure, holds on success
 * until the session ends (onSessionStale → releaseTicket or
 * handleDesignerSessionEnded → clearWorkerTicket → releaseTicket).
 *
 * Orchestrators (Darryl/Jan) do NOT hold claims — see orchestratorDispatch.ts.
 * Only WORKER sessions hold registry claims.
 */

import * as path from 'path';
import {
	DESIGNER_ROLE_SHORT,
	VISUAL_DESIGNER_ROLE_SHORT,
	VISUAL_QA_ROLE_SHORT,
	TEAM_UX_ID,
	TEAM_VISUAL_ID,
	WORKER_ROLE_DESIGNER,
	WORKER_ROLE_DEV,
} from './constants.js';
import { ensureAgentMemory } from './agentStore.js';
import type { PersistentAgent } from './agentStore.js';
import {
	buildSystemPrompt,
	buildDesignerSystemPrompt,
	buildVisualDesignerSystemPrompt,
	buildVisualQaSystemPrompt,
	buildVisualQaInitialTask,
} from './systemPrompts.js';
import { getJanDesignConfig } from './agentHandlers.js';
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
import { findBusyDevSlot, findBusyVisualSlot, findFreeDevWorker } from './capacity.js';
import {
	EXIT_REMINDER,
	launchPersistentAgentSession,
	type LaunchOptions,
} from './launchHelpers.js';
import { claimTicket, releaseTicket } from './dispatchRegistry.js';
import {
	buildWorkerAiReviewInitialTask,
	buildWorkerStandardInitialTask,
	buildUxDesignerInitialTask,
	buildVisualDesignerInitialTask,
} from './initialTasks.js';

// ── Unified dispatch core ────────────────────────────────────

export interface LocalLaunchOutcome {
	success: boolean;
	/** Set when the local visual slot is busy — caller may try fleet cascade. */
	slotBusy?: boolean;
	/** Picked worker name on success (used for logging / response payload). */
	worker?: string;
	error?: string;
}

export interface WorkerDispatchSpec {
	/** Registry claim purpose, e.g. 'dev-worker', 'visual-designer'. */
	purpose: string;
	/** Run the local launch attempt. Set `slotBusy: true` to trigger cascade. */
	tryLaunchLocal: (msg: Record<string, unknown>, ctx: ServerContext) => LocalLaunchOutcome;
	/** Optional WebSocket-RPC fleet cascade. */
	fleet?: {
		rpcType: 'launchDesigner' | 'launchVisualDesigner' | 'launchVisualQa' | 'launchDev';
		/** Worker role required to receive this RPC. */
		role: typeof WORKER_ROLE_DESIGNER | typeof WORKER_ROLE_DEV;
	};
}

export async function dispatchWorker(
	msg: Record<string, unknown>,
	ctx: ServerContext,
	spec: WorkerDispatchSpec,
): Promise<{ success: boolean; error?: string; worker?: string }> {
	const ticketId = typeof msg.ticketId === 'string' ? msg.ticketId : '';

	const claimed = ticketId
		? claimTicket(ctx.dispatchRegistry, ticketId, ctx.workerIdentity?.name ?? 'Hub', spec.purpose)
		: false;
	if (ticketId && !claimed) {
		const existing = ctx.dispatchRegistry.get(ticketId);
		return { success: false, error: `Ticket ${ticketId} is already in flight (claimed by "${existing?.claimedBy ?? '?'}" for "${existing?.purpose ?? '?'}").` };
	}

	const local = spec.tryLaunchLocal(msg, ctx);
	if (local.success) {
		return { success: true, worker: local.worker ?? ctx.workerIdentity?.name };
	}

	if (!ctx.isWorkerMode && local.slotBusy && spec.fleet) {
		const fleet = await dispatchToFleet(msg, ctx, spec.fleet.rpcType, spec.fleet.role, local.error);
		if (!fleet.success && claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
		return fleet;
	}

	if (claimed) releaseTicket(ctx.dispatchRegistry, ticketId);
	return { success: false, error: local.error };
}

// ── Fleet cascade ───────────────────────────────────────────
// Visual-slot lock is PER DEVICE. Jan can have one designer or QA running on
// the hub AND one on each remote worker simultaneously — this dispatcher
// cascades a dispatch request to a free remote worker when the local visual
// slot is busy.

async function dispatchToFleet(
	msg: Record<string, unknown>,
	ctx: ServerContext,
	rpcType: 'launchDesigner' | 'launchVisualDesigner' | 'launchVisualQa' | 'launchDev',
	role: typeof WORKER_ROLE_DESIGNER | typeof WORKER_ROLE_DEV,
	localError?: string,
): Promise<{ success: boolean; error?: string; worker?: string }> {
	const ticketId = msg.ticketId as string | undefined;
	const ticketName = msg.ticketName as string | undefined;
	const remoteWorkers = getIdleWorkersWithRole(ctx, role);
	if (remoteWorkers.length === 0) {
		const noun = role === WORKER_ROLE_DEV ? 'dev' : 'designer';
		return { success: false, error: localError
			? `${localError} No idle remote ${noun} workers connected — wait and retry.`
			: `Local ${noun} slot busy and no idle remote ${noun} workers connected — wait and retry.` };
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

// ── Shared local-launch helper ───────────────────────────────

/**
 * Common local-launch path: stamps ticket info, calls
 * `launchPersistentAgentSession`, and adapts the result into the
 * `LocalLaunchOutcome` shape `dispatchWorker` expects. Every role-specific
 * `tryLaunchLocal` callback ends with this.
 */
function launchLocally(
	agent: PersistentAgent,
	systemPrompt: string,
	initialTask: string,
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
	ctx: ServerContext,
	options?: LaunchOptions,
): LocalLaunchOutcome {
	ensureAgentMemory(agent.id);
	const result = launchPersistentAgentSession(
		agent,
		systemPrompt,
		initialTask,
		{ ticketId, ticketName, ticketUrl },
		ctx,
		ctx.persistentAgents,
		options ?? {},
	);
	if (!result.success) {
		return { success: false, error: result.error };
	}
	return { success: true, worker: agent.name };
}

function getProjectDescription(workspacePath: string): string | undefined {
	const knownProjects = loadKnownProjects();
	const projName = path.basename(workspacePath);
	return knownProjects.find(k => k.name === projName)?.description;
}

// ── Role: dev worker (Darryl's downstream dispatch) ─────────

function tryLaunchDevWorkerLocal(msg: Record<string, unknown>, ctx: ServerContext): LocalLaunchOutcome {
	const workspacePath = msg.workspacePath as string | undefined;
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const useTeam = msg.useTeam as boolean | undefined;
	const aiReviewMode = msg.aiReviewMode as boolean | undefined;
	const brief = typeof msg.additionalPrompt === 'string' ? msg.additionalPrompt.trim() : '';

	if (!workspacePath) return { success: false, error: 'Missing required field: workspacePath' };
	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	// Per-machine dev slot lock — same shape as Jan's visual-slot lock. The
	// hub takes ONE dev ticket at a time; further work cascades to idle remote
	// workers via the fleet RPC. Without this, every Darryl curl found the
	// same first-free hub agent and piled all dispatches onto a single machine.
	const busySlot = findBusyDevSlot(ctx.persistentAgents);
	if (busySlot) {
		return {
			success: false,
			slotBusy: true,
			error: `Local dev slot busy: "${busySlot.name}" is already running on this machine.`,
		};
	}

	// Atomic worker pick: find any free dev worker (no live session) whose
	// workspace matches the ticket.
	const pa = findFreeDevWorker(ctx.persistentAgents, workspacePath);
	if (!pa) {
		return { success: false, error: `No free dev worker available for workspace "${workspacePath}".` };
	}

	const projectDescription = getProjectDescription(pa.workspacePath);
	const systemPrompt = buildSystemPrompt(pa, projectDescription);

	const briefBlock = brief
		? `${brief}\n\n`
		: `⚠ No Brief was passed by Darryl — you'll need to read the ticket yourself.\n\n`;

	let initialTask = aiReviewMode
		? buildWorkerAiReviewInitialTask(ticketId, ticketName, ticketUrl, briefBlock)
		: buildWorkerStandardInitialTask(ticketId, ticketName, ticketUrl, briefBlock);
	if (projectDescription) {
		initialTask += `\n\n## Project\n${projectDescription}`;
	}
	if (useTeam) {
		initialTask += '\n\nUse team mode: spawn sub-agents for parallel work.';
	}
	initialTask += EXIT_REMINDER;

	const outcome = launchLocally(pa, systemPrompt, initialTask, ticketId, ticketName, ticketUrl, ctx);
	if (outcome.success) {
		console.log(`[Standalone] Launched dev worker "${pa.name}" for ticket ${ticketId}`);
	} else {
		console.log(`[Standalone] Failed to launch dev worker "${pa.name}" for ticket ${ticketId}`);
	}
	return outcome;
}

const devWorkerSpec: WorkerDispatchSpec = {
	purpose: 'dev-worker',
	tryLaunchLocal: tryLaunchDevWorkerLocal,
	// One dev ticket per machine. When the hub already has a dev session
	// running, cascade to an idle remote worker advertising the 'dev' role.
	fleet: { rpcType: 'launchDev', role: WORKER_ROLE_DEV },
};

const devWorkerAiReviewSpec: WorkerDispatchSpec = {
	...devWorkerSpec,
	purpose: 'dev-worker-ai-review',
};

/**
 * Launch a dev worker on a ticket. Mirrors Jan's flow: caller passes the
 * workspace path, the hub atomically picks a free worker matching it.
 *
 * The dev spec has no fleet cascade, so the returned promise resolves on the
 * next microtask — synchronous for all practical purposes — but the signature
 * is a Promise to keep the dispatch core uniform.
 *
 * Returns the picked worker's name on success so the caller can log/comment
 * about the assignment.
 */
export function launchAgentOnTicket(
	workspacePath: string,
	ticketId: string,
	ticketName: string,
	ticketUrl: string,
	ctx: ServerContext,
	options?: { useTeam?: boolean; additionalPrompt?: string; aiReviewMode?: boolean },
): Promise<{ success: boolean; error?: string; worker?: string }> {
	const msg: Record<string, unknown> = {
		workspacePath,
		ticketId,
		ticketName,
		ticketUrl,
		additionalPrompt: options?.additionalPrompt,
		useTeam: options?.useTeam,
		aiReviewMode: options?.aiReviewMode,
	};
	const spec = options?.aiReviewMode ? devWorkerAiReviewSpec : devWorkerSpec;
	return dispatchWorker(msg, ctx, spec);
}

export async function handleClickupStartWork(msg: Record<string, unknown>, ctx: ServerContext): Promise<void> {
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const useTeam = msg.useTeam as boolean | undefined;
	const additionalPrompt = msg.additionalPrompt as string | undefined;
	// Webview "Start work" picks the worker explicitly via agentId — read the
	// workspace off the chosen persistent agent and reuse the shared launcher.
	const agentId = msg.agentId as string | undefined;
	let workspacePath = msg.workspacePath as string | undefined;
	if (agentId) {
		const pa = ctx.persistentAgents.find(p => p.id === agentId);
		if (pa) workspacePath = pa.workspacePath;
	}
	if (!workspacePath) {
		ctx.broadcastSink.postMessage({ type: 'clickupStartWorkError', error: 'Missing workspacePath (and agentId could not be resolved).' });
		return;
	}
	const result = await launchAgentOnTicket(workspacePath, ticketId, ticketName, ticketUrl, ctx, { useTeam, additionalPrompt });
	if (!result.success) {
		ctx.broadcastSink.postMessage({ type: 'clickupStartWorkError', error: result.error });
	}
}

// ── Role: UX Designer ───────────────────────────────────────

function tryLaunchDesignerLocal(msg: Record<string, unknown>, ctx: ServerContext): LocalLaunchOutcome {
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

	const busySlot = findBusyVisualSlot(ctx.persistentAgents);
	if (busySlot) {
		return { success: false, slotBusy: true, error: `Local visual slot busy: "${busySlot.name}" (${busySlot.roleShort}) is already running on this machine.` };
	}

	const designer = ctx.persistentAgents.find(
		p => p.roleShort === DESIGNER_ROLE_SHORT
			&& p.teamId === TEAM_UX_ID
			&& !p.currentSessionId
			&& !p.retired,
	);
	if (!designer) return { success: false, error: 'No free UX Designers available — all team members are busy.' };

	designer.workspacePath = workspacePath;
	const projectDescription = getProjectDescription(workspacePath);
	const systemPrompt = buildDesignerSystemPrompt(designer, projectDescription, getJanDesignConfig());

	const briefBlock = brief
		? `${brief}\n\n`
		: `⚠ No Brief was passed by Jan — you will need to read the ticket description yourself.\n\n`;
	const initialTask = buildUxDesignerInitialTask(ticketId, ticketName, ticketUrl, briefBlock, !!revisionMode) + EXIT_REMINDER;

	const outcome = launchLocally(designer, systemPrompt, initialTask, ticketId, ticketName, ticketUrl, ctx);
	if (outcome.success) {
		console.log(`[Standalone] Launched designer "${designer.name}" for ticket ${ticketId}`);
	} else {
		console.log(`[Standalone] Failed to launch designer "${designer.name}" for ticket ${ticketId}`);
	}
	return outcome;
}

const uxDesignerSpec: WorkerDispatchSpec = {
	purpose: 'ux-designer',
	tryLaunchLocal: tryLaunchDesignerLocal,
	fleet: { rpcType: 'launchDesigner', role: WORKER_ROLE_DESIGNER },
};

export function handleLaunchDesigner(msg: Record<string, unknown>, ctx: ServerContext): Promise<{ success: boolean; error?: string; worker?: string }> {
	return dispatchWorker(msg, ctx, uxDesignerSpec);
}

// ── Role: Visual Designer ───────────────────────────────────

function tryLaunchVisualDesignerLocal(msg: Record<string, unknown>, ctx: ServerContext): LocalLaunchOutcome {
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

	const busySlot = findBusyVisualSlot(ctx.persistentAgents);
	if (busySlot) {
		return { success: false, slotBusy: true, error: `Local visual slot busy: "${busySlot.name}" (${busySlot.roleShort}) is already running on this machine.` };
	}

	const designer = ctx.persistentAgents.find(
		p => p.roleShort === VISUAL_DESIGNER_ROLE_SHORT
			&& p.teamId === TEAM_VISUAL_ID
			&& !p.currentSessionId
			&& !p.retired,
	);
	if (!designer) return { success: false, error: 'No free Visual Designers available — all team members are busy.' };

	designer.workspacePath = workspacePath;
	const projectDescription = getProjectDescription(workspacePath);
	const systemPrompt = buildVisualDesignerSystemPrompt(designer, projectDescription, getJanDesignConfig());

	const briefBlock = brief
		? `${brief}\n\n`
		: `⚠ No Brief was passed by Jan — look at the ticket to find the approved UX Figma node.\n\n`;
	const initialTask = buildVisualDesignerInitialTask(ticketId, ticketName, ticketUrl, briefBlock, !!revisionMode) + EXIT_REMINDER;

	const outcome = launchLocally(designer, systemPrompt, initialTask, ticketId, ticketName, ticketUrl, ctx);
	if (outcome.success) {
		console.log(`[Standalone] Launched visual designer "${designer.name}" for ticket ${ticketId}`);
	} else {
		console.log(`[Standalone] Failed to launch visual designer "${designer.name}" for ticket ${ticketId}`);
	}
	return outcome;
}

const visualDesignerSpec: WorkerDispatchSpec = {
	purpose: 'visual-designer',
	tryLaunchLocal: tryLaunchVisualDesignerLocal,
	fleet: { rpcType: 'launchVisualDesigner', role: WORKER_ROLE_DESIGNER },
};

export function handleLaunchVisualDesigner(msg: Record<string, unknown>, ctx: ServerContext): Promise<{ success: boolean; error?: string; worker?: string }> {
	return dispatchWorker(msg, ctx, visualDesignerSpec);
}

// ── Role: Visual QA ─────────────────────────────────────────

function tryLaunchVisualQaLocal(msg: Record<string, unknown>, ctx: ServerContext): LocalLaunchOutcome {
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const designerName = (msg.designerName as string | undefined) ?? 'unknown';

	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	const busySlot = findBusyVisualSlot(ctx.persistentAgents);
	if (busySlot) {
		return { success: false, slotBusy: true, error: `Local visual slot busy: "${busySlot.name}" (${busySlot.roleShort}) is already running on this machine.` };
	}

	const qa = ctx.persistentAgents.find(
		p => p.roleShort === VISUAL_QA_ROLE_SHORT && p.teamId === TEAM_VISUAL_ID,
	);
	if (!qa) return { success: false, error: 'No Visual QA agent seeded on this machine' };

	const systemPrompt = buildVisualQaSystemPrompt(qa, getJanDesignConfig());
	const initialTask = buildVisualQaInitialTask({ ticketId, ticketName, ticketUrl, designerName }) + EXIT_REMINDER;

	const outcome = launchLocally(qa, systemPrompt, initialTask, ticketId, ticketName, ticketUrl, ctx, { withPeers: true });
	if (outcome.success) {
		console.log(`[Standalone] Launched Visual QA "${qa.name}" for AI review of ticket ${ticketId}`);
	}
	return outcome;
}

const visualQaSpec: WorkerDispatchSpec = {
	purpose: 'visual-qa',
	tryLaunchLocal: tryLaunchVisualQaLocal,
	fleet: { rpcType: 'launchVisualQa', role: WORKER_ROLE_DESIGNER },
};

export function handleVisualQaReview(
	completedTicket: { ticketId: string; ticketName: string; ticketUrl: string; designerName: string; workspacePath: string },
	ctx: ServerContext,
): Promise<{ success: boolean; error?: string; worker?: string }> {
	return dispatchWorker(completedTicket as unknown as Record<string, unknown>, ctx, visualQaSpec);
}

// ── Worker-originated designer session-end hook ────────────

/**
 * Called on the hub when a remote worker reports that one of its design-role
 * sessions ended. Clears the worker slot and releases the dispatch claim via
 * `clearWorkerTicket`, and persists any updated agent memory shipped back.
 *
 * Does NOT trigger follow-up dispatch (no reactive auto-launch). Follow-up
 * work picks up on the next 3-min ClickUp poll or an explicit kantoor refresh.
 */
export function handleDesignerSessionEnded(
	msg: Record<string, unknown>,
	ctx: ServerContext,
	sourceWs: import('ws').WebSocket,
): void {
	const agentRole = msg.agentRole as string | undefined;
	const ticketId = msg.ticketId as string | undefined;
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
}
