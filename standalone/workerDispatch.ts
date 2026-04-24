/**
 * Worker dispatch endpoints — the launchers that actually start per-worker
 * sessions on a ticket.
 *
 * Five public entry points:
 *   - `launchAgentOnTicket` — dev worker (Darryl's downstream dispatch).
 *   - `handleClickupStartWork` — webview-initiated wrapper around
 *     `launchAgentOnTicket`.
 *   - `handleLaunchDesigner` — UX designer (Jan's `/api/launch-designer`).
 *   - `handleLaunchVisualDesigner` — Visual designer
 *     (Jan's `/api/launch-visual-designer`).
 *   - `handleVisualQaReview` — Visual QA (Jan's `/api/launch-visual-qa`).
 *
 * Plus `handleDesignerSessionEnded` — the hub-side hook that fires when a
 * remote worker reports a design-role session ended (clears slot + releases
 * claim). It lives here because it's tightly coupled to the design dispatch
 * lifecycle, not to ClickUp logic.
 *
 * ## Claim lifecycle
 * Each handler claims its ticket in the dispatch registry at entry (purpose
 * = role name) and releases on failure rollback. On success the claim is
 * held until session-end (onSessionStale → releaseTicket or
 * handleDesignerSessionEnded → clearWorkerTicket → releaseTicket).
 *
 * Orchestrators (Darryl/Jan) do NOT hold claims — see orchestratorDispatch.ts.
 * Only WORKER sessions hold registry claims.
 *
 * ## Fleet cascade
 * The three design endpoints (`handleLaunchDesigner`,
 * `handleLaunchVisualDesigner`, `handleVisualQaReview`) first try the local
 * machine's visual slot via a `tryLaunch*Local` helper, and cascade to any
 * idle remote designer worker via `dispatchToFleet` when the local slot is
 * busy. `launchAgentOnTicket` does NOT cascade — dev workers are launched
 * locally on the hub.
 */

import * as path from 'path';
import {
	DESIGNER_ROLE_SHORT,
	VISUAL_DESIGNER_ROLE_SHORT,
	VISUAL_QA_ROLE_SHORT,
	TEAM_UX_ID,
	TEAM_VISUAL_ID,
	WORKER_ROLE_DESIGNER,
} from './constants.js';
import { ensureAgentMemory } from './agentStore.js';
import {
	buildDesignerSystemPrompt,
	buildVisualDesignerSystemPrompt,
	buildVisualQaSystemPrompt,
	buildVisualQaInitialTask,
} from './systemPrompts.js';
import { getJanDesignConfig, launchPersistentAgent } from './agentHandlers.js';
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
import { findBusyVisualSlot } from './capacity.js';
import {
	EXIT_REMINDER,
	launchPersistentAgentSession,
} from './launchHelpers.js';
import { claimTicket, releaseTicket } from './dispatchRegistry.js';
import {
	buildWorkerAiReviewInitialTask,
	buildWorkerStandardInitialTask,
	buildUxDesignerInitialTask,
	buildVisualDesignerInitialTask,
} from './initialTasks.js';

// ── Dev worker (Darryl's downstream dispatch) ───────────────

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

// ── Fleet cascade ───────────────────────────────────────────
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
