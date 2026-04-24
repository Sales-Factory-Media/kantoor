/**
 * ClickUp integration: polling, ticket pickup, and dispatch for Darryl / Jan /
 * the design fleet. The giant prompt strings live in ./initialTasks.ts, the
 * launch boilerplate lives in ./launchHelpers.ts, and capacity accounting
 * lives in ./capacity.ts — this file is orchestration only.
 */

import {
	CLICKUP_POLL_INTERVAL_MS,
	DARRYL_CLICKUP_USERNAME,
	JAN_CLICKUP_USERNAME,
	SERVER_PORT,
	AI_REVIEW_PICKUP_ENABLED,
} from './constants.js';
import {
	buildJanSystemPrompt,
} from './systemPrompts.js';
import { getJanDesignConfig } from './agentHandlers.js';
import { fetchListTasks } from './clickupClient.js';
import type { ClickUpConfig } from './clickupClient.js';
import { readJson, writeJson } from './serverHelpers.js';
import { SETTINGS_FILE } from './serverContext.js';
import type { ServerContext } from './serverContext.js';
import {
	computeDesignFleetCapacity,
} from './capacity.js';
import {
	EXIT_REMINDER,
	launchPersistentAgentSession,
	type TicketInfo,
} from './launchHelpers.js';
import {
	claimedTicketIds,
} from './dispatchRegistry.js';
import {
	selectDarrylPickups,
	selectJanPickups,
} from './pickupPlanner.js';
import {
	buildJanRefineInitialTask,
	buildJanSingleTodoInitialTask,
} from './initialTasks.js';
import {
	buildRoster,
	ensureJan,
	handleDarrylBatchDispatch,
	handleJanBatchDispatch,
} from './orchestratorDispatch.js';

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

// ── Jan single-ticket design briefing (legacy webview message) ──

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

