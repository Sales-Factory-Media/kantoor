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
	AUTO_MODE_ASSIGNEE_USERNAME,
	SERVER_PORT,
	AI_REVIEW_PICKUP_ENABLED,
} from './constants.js';
import {
	buildJanSystemPrompt,
} from './systemPrompts.js';
import { getJanDesignConfig, getAutoModeEnabled } from './agentHandlers.js';
import { normalizeListIds, type ClickUpConfig, type ClickUpStatusGroup } from '../src/connectors/clickupClient.js';
import type { ServerContext } from './serverContext.js';
import {
	getActiveBuildingConnectorConfig,
	patchActiveBuildingConnectorConfig,
} from '../src/db/settingsStore.js';
import {
	computeDesignFleetCapacity,
	computeDevFleetCapacity,
} from './capacity.js';
import {
	ANNOUNCE_REMINDER,
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
	selectJasperClassifyPickups,
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
	dispatchDarrylClassify,
} from './orchestratorDispatch.js';
import { delegationExcludeSet } from './delegationStore.js';

// ── Polling ──────────────────────────────────────────────────

export function startClickupPolling(ctx: ServerContext): void {
	if (ctx.clickupTimer) return;
	if (!ctx.connector || !ctx.connector.isConfigured()) return;
	const label = ctx.activeBuilding?.name ?? 'building';
	console.log(`[Standalone] Starting ${ctx.connector.type} polling for ${label}...`);
	ctx.clickupTimer = setInterval(() => { handleClickupRefresh(ctx).catch(() => {}); }, CLICKUP_POLL_INTERVAL_MS);
}

export function stopClickupPolling(ctx: ServerContext): void {
	if (ctx.clickupTimer) {
		clearInterval(ctx.clickupTimer);
		ctx.clickupTimer = null;
	}
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
	autoJasperClassifyPickup(ctx);
}

/**
 * Auto Mode: when enabled, hand ONE "to do" ticket assigned to the auto-mode
 * user to Darryl to classify (pick the best worker). Darryl does NOT dispatch —
 * he posts a recommendation that a human confirms in the kantoor. Gated so a
 * ticket already awaiting confirmation (delegation store) or in flight (dispatch
 * registry) is never re-classified. Qualification is strictly one-at-a-time —
 * Darryl is a singleton and we only ever hand him a single ticket per cycle.
 */
/**
 * Index the current ticket cache by id → connector date_updated (epoch ms).
 * Used to decide whether a pending delegation's ticket changed since it was
 * last evaluated.
 */
function buildTicketUpdatedAtLookup(
	clickupTickets: ClickUpStatusGroup[],
): (ticketId: string) => number | undefined {
	const byId = new Map<string, number>();
	for (const group of clickupTickets) {
		for (const task of group.tasks) {
			const raw = (task as { dateUpdated?: string }).dateUpdated;
			const n = raw != null ? Number(raw) : NaN;
			if (Number.isFinite(n)) byId.set(task.id, n);
		}
	}
	return (ticketId: string) => byId.get(ticketId);
}

export function autoJasperClassifyPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;
	if (!getAutoModeEnabled()) return;

	// Skip if Darryl is already running (classifying, or dispatching a Darryl
	// Philbin batch) — the next poll retries.
	const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
	if (darryl?.currentSessionId) return;

	// Exclude tickets already classified (awaiting confirmation) or in flight.
	// A pending recommendation whose ticket was UPDATED since Darryl evaluated it
	// is dropped from the exclude set so it gets re-classified (fresh info).
	const liveUpdatedAt = buildTicketUpdatedAtLookup(ctx.clickupTickets);
	const exclude = delegationExcludeSet(ctx.delegationStore, liveUpdatedAt);
	for (const id of claimedTicketIds(ctx.dispatchRegistry)) exclude.add(id);

	const candidates = selectJasperClassifyPickups(ctx.clickupTickets, exclude, AUTO_MODE_ASSIGNEE_USERNAME);
	if (candidates.length === 0) return;

	const ticket = candidates[0];
	dispatchDarrylClassify(
		{ ticketId: ticket.id, ticketName: ticket.name, ticketUrl: ticket.url },
		ctx,
	);
}


let clickupRefreshInFlight = false;

export async function handleClickupRefresh(ctx: ServerContext): Promise<void> {
	if (!ctx.connector || !ctx.connector.isConfigured()) return;
	if (clickupRefreshInFlight) return;
	clickupRefreshInFlight = true;
	try {
		// StatusGroup (connector) and ClickUpStatusGroup (legacy) have the same
		// shape; cast for the in-context store until the rest of dispatch is
		// migrated to the normalized types.
		const statuses = await ctx.connector.fetchTickets() as unknown as ClickUpStatusGroup[];
		ctx.clickupTickets = statuses;
		ctx.clickupNextFetchAt = Date.now() + CLICKUP_POLL_INTERVAL_MS;
		ctx.broadcastSink.postMessage({ type: 'clickupTickets', statuses, nextFetchAt: ctx.clickupNextFetchAt });
		runAutoPickupNow(ctx);
	} catch (err) {
		console.error(`[Standalone] ${ctx.connector.type} fetch error:`, err);
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: String(err) });
	} finally {
		clickupRefreshInFlight = false;
	}
}

// ── Capacity-gated batch pickup (shared by Darryl + Jan) ─────

/**
 * Spec for `runCapacityGatedPickup`. Encapsulates the per-orchestrator bits;
 * the helper handles singleton check, capacity gate, slice, log, and dispatch.
 *
 * The same shape works for Darryl (1 status type, dev capacity) and Jan
 * (3 status types, design-fleet capacity) because the orchestrator-specific
 * differences live entirely in the spec callbacks.
 */
interface CapacityGatedPickupSpec<S extends string> {
	/** Display name (also used to find the orchestrator's persistent agent). */
	name: string;
	/** Tickets sorted by priority — slicing happens inside the helper. */
	candidates: Array<TicketInfo & { status: S }>;
	/** Available worker slots right now. */
	available: number;
	/** Total slots (for diagnostic logs). */
	total: number;
	/** Active slots (for diagnostic logs). */
	active: number;
	/** Optional extra detail for the gated-log line (e.g. "(N in-progress + M pending)"). */
	gatedDetail?: string;
	/** Per-status counts for the dispatched-batch log. Keys are status strings. */
	describeBatch: (batch: Array<TicketInfo & { status: S }>) => string;
	/** Worker noun for log line (e.g. "dev workers", "machines"). */
	workerNoun: string;
	/** Actual dispatch. */
	dispatch: (batch: Array<TicketInfo & { status: S }>, ctx: ServerContext) => void;
}

function runCapacityGatedPickup<S extends string>(
	spec: CapacityGatedPickupSpec<S>,
	ctx: ServerContext,
): void {
	if (spec.candidates.length === 0) return;

	// Singleton: if the orchestrator is already running, skip — the next poll
	// will retry. Mirrors the Darryl/Jan pattern: one orchestrator session at
	// a time, batch-dispatching all tickets it's been handed.
	const orchestrator = ctx.persistentAgents.find(p => p.name === spec.name);
	if (orchestrator?.currentSessionId) return;

	if (spec.available === 0) {
		const detail = spec.gatedDetail ? ` ${spec.gatedDetail}` : '';
		console.log(`[Standalone] ${spec.name} pickup gated: ${spec.active}/${spec.total} ${spec.workerNoun} active${detail}; ${spec.candidates.length} ticket(s) waiting`);
		return;
	}

	const batch = spec.candidates.slice(0, spec.available);
	const deferred = spec.candidates.length - batch.length;
	const deferredNote = deferred > 0 ? `, ${deferred} deferred to next poll` : '';
	console.log(`[Standalone] Auto-pickup: ${spec.name} batch of ${batch.length} ${spec.describeBatch(batch)} — ${spec.active}/${spec.total} ${spec.workerNoun} already active${deferredNote}`);
	spec.dispatch(batch, ctx);
}

export function autoDarrylPickup(ctx: ServerContext): void {
	// Workers don't auto-pickup — hub is the single orchestrator entry point.
	if (ctx.isWorkerMode) return;

	// Decision pass (pure — see pickupPlanner.ts). Drops anything already in
	// flight via the registry, filters to Darryl's assignee scope, sorts
	// ai-review before to-do so short review cycles drain first.
	const inFlight = claimedTicketIds(ctx.dispatchRegistry);
	const todoTickets = selectDarrylPickups(ctx.clickupTickets, inFlight, DARRYL_CLICKUP_USERNAME, AI_REVIEW_PICKUP_ENABLED);

	const candidates: Array<TicketInfo & { status: 'to do' | 'ai review' }> = todoTickets.map(t => ({
		ticketId: t.id,
		ticketName: t.name,
		ticketUrl: t.url,
		status: t.status,
	}));

	const cap = computeDevFleetCapacity(ctx);

	runCapacityGatedPickup({
		name: 'Darryl',
		candidates,
		available: cap.available,
		total: cap.total,
		active: cap.active,
		workerNoun: 'dev workers',
		describeBatch: batch => {
			const todo = batch.filter(b => b.status === 'to do').length;
			const review = batch.filter(b => b.status === 'ai review').length;
			return `(${todo} to-do, ${review} ai-review)`;
		},
		dispatch: handleDarrylBatchDispatch,
	}, ctx);
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

	if (
		buckets.refine.length === 0
		&& buckets.todo.length === 0
		&& buckets.aiReview.length === 0
		&& buckets.revision.length === 0
	) return;

	// Jan singleton check (helper does this too, but refine bypasses the
	// helper so we duplicate it for refine's path).
	const jan = ctx.persistentAgents.find(p => p.name === 'Jan');
	if (jan?.currentSessionId) return;

	// Refine tickets are single-ticket: one refine ticket spawns 5 UX designers,
	// already saturating the UX team. Bypass the capacity gate — Jan still
	// goes through the orchestrator-spawn singleton lock above.
	if (buckets.refine.length > 0) {
		const ticket = buckets.refine[0];
		console.log(`[Standalone] Auto-pickup: Jan taking refine ticket ${ticket.id}`);
		handleJanDesignBriefing(
			{ ticketId: ticket.id, ticketName: ticket.name, ticketUrl: ticket.url, ticketStatus: 'to refine' },
			ctx,
		);
		return;
	}

	const cap = computeDesignFleetCapacity(ctx, buckets.janTicketIds);

	// Combined batch: fill available slots with whatever's waiting.
	// ai-review first (reviews are quick), then revisions (continuing work),
	// then new to-do tickets.
	const candidates: Array<TicketInfo & { status: 'to do' | 'ai review' | 'revision needed' }> = [
		...buckets.aiReview.map(t => ({ ticketId: t.id, ticketName: t.name, ticketUrl: t.url, status: 'ai review' as const })),
		...buckets.revision.map(t => ({ ticketId: t.id, ticketName: t.name, ticketUrl: t.url, status: 'revision needed' as const })),
		...buckets.todo.map(t => ({ ticketId: t.id, ticketName: t.name, ticketUrl: t.url, status: 'to do' as const })),
	];

	runCapacityGatedPickup({
		name: 'Jan',
		candidates,
		available: cap.available,
		total: cap.total,
		active: cap.active,
		gatedDetail: `(${cap.inProgressCount} in-progress + ${cap.pendingDispatches} pending-dispatch)`,
		workerNoun: 'machines',
		describeBatch: batch => {
			const todo = batch.filter(b => b.status === 'to do').length;
			const review = batch.filter(b => b.status === 'ai review').length;
			const revision = batch.filter(b => b.status === 'revision needed').length;
			return `(${todo} to-do, ${review} ai-review, ${revision} revision)`;
		},
		dispatch: handleJanBatchDispatch,
	}, ctx);
}

// ── Configure ────────────────────────────────────────────────

export async function handleClickupConfigure(msg: Record<string, unknown>, ctx: ServerContext): Promise<void> {
	const apiToken = msg.apiToken as string | undefined;
	// New shape: listIds: string[]. Accept the legacy single listId too.
	const rawListIds = Array.isArray(msg.listIds)
		? (msg.listIds as unknown[])
		: (typeof msg.listId === 'string' ? [msg.listId] : undefined);

	const patch: Record<string, unknown> = {};
	if (apiToken !== undefined) patch.apiToken = apiToken;
	if (rawListIds !== undefined) {
		patch.listIds = rawListIds;
		// Clear the legacy single-list key so a stale value can't linger and get
		// re-merged by normalizeListIds. (undefined is dropped on JSONB write.)
		patch.listId = undefined;
	}

	const merged = await patchActiveBuildingConnectorConfig(patch);
	const mergedToken = merged.apiToken as string | undefined;
	const mergedListIds = normalizeListIds(merged);

	// Rebuild the connector from the patched config so polling sees the change.
	const { connectorForBuilding } = await import('../src/connectors/registry.js');
	if (ctx.activeBuilding) {
		const refreshed = { ...ctx.activeBuilding, connectorConfig: merged };
		ctx.activeBuilding = refreshed;
		ctx.connector = connectorForBuilding(refreshed);
	}

	if (!mergedToken || mergedListIds.length === 0) {
		ctx.clickupConfig = null;
		ctx.broadcastSink.postMessage({ type: 'clickupConfigured', configured: false, listIds: [] });
		return;
	}

	const config: ClickUpConfig = { apiToken: mergedToken, listIds: mergedListIds };
	ctx.clickupConfig = config;
	ctx.broadcastSink.postMessage({ type: 'clickupConfigured', configured: true, listIds: config.listIds });

	startClickupPolling(ctx);
	handleClickupRefresh(ctx).catch(() => {});
}

/**
 * Read the active building's connector config and return it as a ClickUpConfig
 * if both fields are present. Used at server boot to populate ctx.clickupConfig
 * from the DB instead of the legacy settings.json.
 */
export async function loadActiveClickupConfig(): Promise<ClickUpConfig | null> {
	const cfg = await getActiveBuildingConnectorConfig();
	const apiToken = cfg.apiToken as string | undefined;
	const listIds = normalizeListIds(cfg);
	if (!apiToken || listIds.length === 0) return null;
	return { apiToken, listIds };
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
	) + ANNOUNCE_REMINDER + EXIT_REMINDER;

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

