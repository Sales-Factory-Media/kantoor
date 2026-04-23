import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadKnownProjects } from '../src/projectStore.js';
import { CLICKUP_POLL_INTERVAL_MS, DARRYL_ROLE_SHORT, DARRYL_CLICKUP_USERNAME, DARRYL_ESCALATION_USERNAME, DARRYL_WORKSPACE, JAN_ROLE_SHORT, JAN_CLICKUP_USERNAME, JAN_WORKSPACE, DESIGNER_ROLE_SHORT, VISUAL_DESIGNER_ROLE_SHORT, VISUAL_QA_ROLE_SHORT, TEAM_UX_ID, TEAM_VISUAL_ID, SERVER_PORT, WORKER_ROLE_DEV, WORKER_ROLE_DESIGNER, DEFAULT_WORKER_ROLES, AI_REVIEW_AUTO_ESCALATE, AI_REVIEW_PICKUP_ENABLED } from './constants.js';
import { launchAgentSession } from './itermFocus.js';
import {
	savePersistentAgents,
	ensureAgentMemory,
	generateAgentId,
	expandHome,
	ensureMempalaceMcpConfig,
	mergeMcpConfigs,
	pickRandomName,
} from './agentStore.js';
import type { DesignConfig, PersistentAgent } from './agentStore.js';
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
import { ensureMcpConfig as ensurePeersMcpConfig } from './conferenceManager.js';
import { fetchListTasks, addTaskComment } from './clickupClient.js';
import type { ClickUpConfig } from './clickupClient.js';
import { readJson, writeJson } from './serverHelpers.js';
import { SETTINGS_FILE } from './serverContext.js';
import type { ServerContext } from './serverContext.js';
import { launchPersistentAgent } from './agentHandlers.js';
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
import { REVIEW_TRIGGER_DELAY_MS } from './constants.js';

// Append this to every initial task so the agent remembers to close its iTerm
// tab when the work is done. The exact bash block is in the agent's system
// prompt under "## Self-Exit" (see buildSelfExitBlock in agentStore.ts).
const EXIT_REMINDER = '\n\nWhen you have finished this work (PR open, ticket status flipped, memory updated), run the `## Self-Exit` bash block from your system prompt to close your iTerm tab. Don\'t run it until everything is saved — there is no coming back.';

// ── Polling ──────────────────────────────────────────────────

export function startClickupPolling(ctx: ServerContext): void {
	if (ctx.clickupTimer) return; // already polling
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

	// When AI Review pickup is enabled, prioritize ai-review tickets over to-do so Copilot feedback gets processed first
	if (AI_REVIEW_PICKUP_ENABLED) {
		todoTickets.sort((a, b) => {
			if (a.status === 'ai review' && b.status !== 'ai review') return -1;
			if (a.status !== 'ai review' && b.status === 'ai review') return 1;
			return 0;
		});
	}

	// Check available dev-capable capacity (hub + idle remote dev workers)
	const capacity = getAvailableCapacity(ctx, WORKER_ROLE_DEV);
	if (capacity === 0) return;

	// Distribute tickets up to available capacity
	const ticketsToAssign = todoTickets.slice(0, capacity);
	const idleWorkers = getIdleWorkers(ctx, WORKER_ROLE_DEV);

	// Hub is available if it has the dev role AND Darryl isn't currently running
	const hubHasDevRole = (ctx.workerIdentity?.roles ?? [...DEFAULT_WORKER_ROLES]).includes(WORKER_ROLE_DEV);
	const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
	const hubAvailable = hubHasDevRole && !darryl?.currentSessionId;

	// Build a queue of available slots: hub first, then remote workers
	const slots: Array<{ type: 'hub' } | { type: 'worker'; worker: typeof idleWorkers[0] }> = [];
	if (hubAvailable) slots.push({ type: 'hub' });
	for (const w of idleWorkers) slots.push({ type: 'worker', worker: w });

	// Collect agent memories once (shared across all worker assignments)
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

function getDesignerMachineCapacity(ctx: ServerContext): number {
	const hubRoles = ctx.workerIdentity?.roles ?? [...DEFAULT_WORKER_ROLES];
	let capacity = hubRoles.includes(WORKER_ROLE_DESIGNER) ? 1 : 0;
	for (const worker of ctx.workers.values()) {
		const roles = worker.roles ?? [];
		if (roles.length === 0 || roles.includes(WORKER_ROLE_DESIGNER)) {
			capacity++;
		}
	}
	return capacity;
}

export function autoJanPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;

	// IDs of every ticket Jan is an assignee on, across all statuses.
	// Used to recognise sub-tickets of Jan's work even if they're unassigned.
	const janTicketIds = new Set<string>();
	for (const group of ctx.clickupTickets) {
		for (const task of group.tasks) {
			if (task.assignees.some(a => a.username === JAN_CLICKUP_USERNAME)) {
				janTicketIds.add(task.id);
			}
		}
	}

	// Collect tickets Jan can act on, split by status, and count in-progress
	// tickets (each potentially holds a Figma slot on some machine).
	const refineTickets: Array<{ id: string; name: string; url: string }> = [];
	const todoTickets: Array<{ id: string; name: string; url: string }> = [];
	const aiReviewTickets: Array<{ id: string; name: string; url: string }> = [];
	let inProgressCount = 0;
	for (const group of ctx.clickupTickets) {
		const statusLower = group.name.toLowerCase();
		if (statusLower === 'in progress') {
			for (const task of group.tasks) {
				if (janTicketIds.has(task.id) || (task.parent && janTicketIds.has(task.parent))) {
					inProgressCount++;
				}
			}
			continue;
		}
		for (const task of group.tasks) {
			if (!janTicketIds.has(task.id)) continue;
			if (statusLower === 'to refine') {
				refineTickets.push({ id: task.id, name: task.name, url: task.url });
			} else if (statusLower === 'to do') {
				todoTickets.push({ id: task.id, name: task.name, url: task.url });
			} else if (statusLower === 'ai review' && AI_REVIEW_PICKUP_ENABLED) {
				aiReviewTickets.push({ id: task.id, name: task.name, url: task.url });
			}
		}
	}

	if (refineTickets.length === 0 && todoTickets.length === 0 && aiReviewTickets.length === 0) return;

	// Jan is a single agent; can only run one session at a time
	const jan = ctx.persistentAgents.find(p => p.name === 'Jan');
	if (jan?.currentSessionId) return;

	// "to refine" is still single-ticket: one refine ticket spawns 5 UX designers,
	// which already saturates the UX team — batching multiple refine tickets is
	// pointless.
	if (refineTickets.length > 0) {
		const ticket = refineTickets[0];
		console.log(`[Standalone] Auto-pickup: Jan taking refine ticket ${ticket.id}`);
		handleJanDesignBriefing(
			{ ticketId: ticket.id, ticketName: ticket.name, ticketUrl: ticket.url, ticketStatus: 'to refine' },
			ctx,
		);
		return;
	}

	// Batch mode: combine "to do" (each dispatches one Visual Designer) and
	// "ai review" (each dispatches the single Visual QA). Each category has
	// its own capacity limit — we don't want to over-queue either worker pool.
	const designerCapacity = getDesignerMachineCapacity(ctx);
	const availableDesignerSlots = Math.max(0, designerCapacity - inProgressCount);

	const qaBusy = ctx.persistentAgents.some(
		p => p.roleShort === VISUAL_QA_ROLE_SHORT
			&& p.teamId === TEAM_VISUAL_ID
			&& p.currentSessionId,
	);
	const availableQaSlots = qaBusy ? 0 : 1;

	const batchedTodo = todoTickets.slice(0, availableDesignerSlots);
	const batchedReview = aiReviewTickets.slice(0, availableQaSlots);

	const batch: Array<{ id: string; name: string; url: string; status: 'to do' | 'ai review' }> = [
		...batchedTodo.map(t => ({ ...t, status: 'to do' as const })),
		...batchedReview.map(t => ({ ...t, status: 'ai review' as const })),
	];

	if (batch.length === 0) {
		console.log(`[Standalone] Jan pickup gated: designers ${inProgressCount}/${designerCapacity} in progress, QA ${qaBusy ? 'busy' : 'free'}; ${todoTickets.length} todo + ${aiReviewTickets.length} ai-review waiting`);
		return;
	}

	console.log(`[Standalone] Auto-pickup: Jan batch of ${batch.length} (${batchedTodo.length} to-do, ${batchedReview.length} ai-review)`);
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
	const briefBlock = brief ? `${brief}\n\n` : `⚠ No Brief was passed by Darryl — you'll need to read the ticket yourself.\n\n`;

	let callInTask: string;
	if (options?.aiReviewMode) {
		callInTask = `Ticket ${ticketId}: "${ticketName}" is in **AI Review**. Copilot reviewed the PR — you process the feedback.
Ticket URL: ${ticketUrl}

${briefBlock}## Steps
1. Move ticket to "in progress".
2. Find the PR (branch \`feature/CU-${ticketId}-*\`). Read Copilot's review + inline comments via \`mcp__github__pull_request_read\`.
3. Triage: actionable (real bug / security / broken convention) vs not (style opinions you disagree with, already-addressed).
4a. Actionable: check out the branch, fix, commit with \`CU-${ticketId}\` ref, push, comment what you addressed + what you deliberately skipped (and why), move ticket back to "ai review".
4b. Nothing actionable: comment confirming review, move ticket to "qa test".

Rules: commit+push BEFORE flipping back to "ai review". 3-round cap — if this is round 3+, forward to "qa test" unless there's a real bug.`;
	} else {
		const finalStep = AI_REVIEW_AUTO_ESCALATE
			? 'Move ticket to **"ai review"** (not "qa test") — Copilot reviews, then you may be reassigned to process its feedback.'
			: 'Move ticket to **"qa test"**. A human reviews from there.';
		callInTask = `Ticket ${ticketId}: "${ticketName}" (${ticketUrl}).

${briefBlock}## Steps
1. Move ticket to "in progress".
2. Check out or create branch \`feature/CU-${ticketId}-<short-desc>\` from develop.
3. Do the work. Rely on the Brief above — only re-read the ticket if the Brief is missing something specific.
4. Open a PR. Commit messages must include \`CU-${ticketId}\`.
5. ${finalStep}`;
	}

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
	const aiReviewMode = msg.aiReviewMode as boolean | undefined;

	const result = launchAgentOnTicket(agentId, ticketId, ticketName, ticketUrl, ctx, { useTeam, additionalPrompt, aiReviewMode });
	if (!result.success) {
		console.log(`[Standalone] Failed to launch agent for ClickUp task ${ticketId}: ${result.error}`);
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: result.error || 'Unknown error' });
	}
}

// ── Configure ────────────────────────────────────────────────

export function handleClickupConfigure(msg: Record<string, unknown>, ctx: ServerContext): void {
	const rawListId = msg.listId;
	const rawApiToken = msg.apiToken;

	if (typeof rawListId !== 'string' || rawListId.trim().length === 0) {
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: 'Invalid ClickUp configuration: listId must be a non-empty string.' });
		return;
	}

	const incomingApiToken = typeof rawApiToken === 'string' ? rawApiToken.trim() : '';
	const effectiveApiToken = incomingApiToken || ctx.clickupConfig?.apiToken || '';

	if (!effectiveApiToken) {
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: 'Invalid ClickUp configuration: apiToken must be a non-empty string.' });
		return;
	}

	const settings = readJson(SETTINGS_FILE) ?? {};
	const config: ClickUpConfig = {
		apiToken: effectiveApiToken,
		listId: rawListId.trim(),
	};
	writeJson(SETTINGS_FILE, { ...settings, clickup: config });
	ctx.clickupConfig = config;
	ctx.broadcastSink.postMessage({ type: 'clickupConfigured', configured: true, listId: config.listId });

	// Start polling if not already running
	startClickupPolling(ctx);

	// Immediately fetch
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

	// Find or create Darryl
	let darryl = persistentAgents.find(p => p.name === 'Darryl');
	if (!darryl) {
		darryl = {
			id: generateAgentId(),
			name: 'Darryl',
			roleShort: DARRYL_ROLE_SHORT,
			roleFull: 'The Foreman. Assesses tickets, decides which agents should work on them, and launches them.',
			workspacePath: DARRYL_WORKSPACE, // Store with ~ prefix for portability
		};
		persistentAgents.push(darryl);
		savePersistentAgents(persistentAgents);
	}

	// If Darryl already has an active session, reuse it
	if (darryl.currentSessionId) {
		console.log(`[Standalone] Darryl already has an active session ${darryl.currentSessionId}, skipping relaunch for ticket ${ticketId}`);
		return;
	}

	// Build roster
	const knownProjects = loadKnownProjects();
	const roster: RosterEntry[] = persistentAgents
		.filter(p => p.id !== darryl!.id)
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

	// Build prompts
	const systemPrompt = buildDarrylSystemPrompt(darryl, roster, SERVER_PORT);

	let initialTask = isAiReviewMode
		? `Ticket ${ticketId}: "${ticketName}" is in **AI Review**. Dispatch an agent to process Copilot's feedback.
URL: ${ticketUrl}

## Steps
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. Find: the original implementer (comment "Assigned to worker: <name>"), the project workspace, how many prior AI Review rounds (count "ai review" → "in progress" cycles).
2. Pick an agent: prefer the original implementer (best context). Fallback = free agent in same workspace.
3. Dispatch with \`aiReviewMode:true\` and a short Brief summarizing what Copilot flagged:
\`curl -X POST http://localhost:${SERVER_PORT}/api/launch-agent -d '{"agentId":"...","ticketId":"${ticketId}","ticketName":"${ticketName}","ticketUrl":"${ticketUrl}","aiReviewMode":true,"additionalPrompt":"<Brief>"}'\`
4. Comment on the ticket naming who you reassigned.

Rules: do NOT change the ticket status yourself (the reassigned agent will). 3+ prior rounds → tell them in the Brief to be conservative and forward to "qa test" unless there's a real bug.`
		: `Ticket ${ticketId}: "${ticketName}" (${ticketUrl}).

## Steps
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once.
2. Is the ticket complete enough to dispatch?
   - **No** → comment with specific questions, unassign yourself, assign "${DARRYL_ESCALATION_USERNAME}", move ticket to "to do". Stop.
   - **Yes** → pick the right free agent from your roster, then dispatch them with a Brief:
     \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-agent -d '{"agentId":"...","ticketId":"${ticketId}","ticketName":"${ticketName}","ticketUrl":"${ticketUrl}","additionalPrompt":"<Brief>","useTeam":<bool>}'\`
3. Move the ticket to "in progress" yourself ONLY if dispatch succeeded. Otherwise leave it.

The Brief should summarize the ticket in 2–6 bullets so the worker doesn't re-read everything. Use the template from your system prompt.`;

	initialTask += EXIT_REMINDER;

	// Launch Darryl
	const newSessionId = crypto.randomUUID();
	darryl.currentSessionId = newSessionId;
	savePersistentAgents(persistentAgents);
	ensureAgentMemory(darryl.id);

	const cwd = expandHome(darryl.workspacePath || '~');
	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}
	const mcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	if (!launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--permission-mode', 'auto'] })) {
		console.log(`[Standalone] Failed to launch Darryl for ticket ${ticketId}`);
	}
}

// ── Jan (Art Director) orchestration ────────────────────────

export function handleJanDesignBriefing(msg: Record<string, unknown>, ctx: ServerContext): void {
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const ticketStatus = (msg.ticketStatus as string | undefined) ?? 'to do';
	const { persistentAgents } = ctx;

	// Find or create Jan
	let jan = persistentAgents.find(p => p.name === 'Jan');
	if (!jan) {
		jan = {
			id: generateAgentId(),
			name: 'Jan',
			roleShort: JAN_ROLE_SHORT,
			roleFull: 'The Art Director. Receives design briefings, delegates to PM and designers, reviews output, and maintains design quality standards.',
			workspacePath: JAN_WORKSPACE,
		};
		persistentAgents.push(jan);
		savePersistentAgents(persistentAgents);
	}

	// If Jan already has an active session, skip relaunch
	if (jan.currentSessionId) {
		console.log(`[Standalone] Jan already has an active session ${jan.currentSessionId}, skipping relaunch for ticket ${ticketId}`);
		return;
	}

	// Build roster (excluding Jan)
	const knownProjects = loadKnownProjects();
	const roster: RosterEntry[] = persistentAgents
		.filter(p => p.id !== jan!.id)
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

	// Build prompts
	const systemPrompt = buildJanSystemPrompt(jan, roster, SERVER_PORT);

	// Build initial task based on ticket status — two distinct modes
	const isRefineMode = ticketStatus === 'to refine';

	let initialTask = isRefineMode
		? `Ticket ${ticketId}: "${ticketName}" (${ticketUrl}) — status **"to refine"** → Phase 1 UX Exploration.

## Steps
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. If the brief is unclear, comment with questions and leave the status as "to refine". Stop.
2. Move ticket to "in progress". Capture: the parent list id, the project workspace (e.g. \`~/Projects/brightmind\`).
3. **Write 5 UX briefing sub-tickets** (follow the "UX briefing creation" section of your system prompt — one direction per sub-ticket, FULL scope each, different axes).
4. **Dispatch one designer per sub-ticket** in quick succession (fleet runs them in parallel). For EACH sub-ticket:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-designer -d '{"workspacePath":"<project>","ticketId":"<sub-id>","ticketName":"UX Direction N: ...","ticketUrl":"<sub-url>","additionalPrompt":"<Brief>"}'\`
   The Brief (template in your system prompt) tells the designer what to build without needing to re-read everything.
5. Only \`success:true\` counts as dispatched. On \`success:false\`, leave sub-ticket status alone, wait ~60s, retry.
6. Poll ticket statuses instead of blocking. When all 5 are in "qa test", review them and comment with art-direction feedback.`
		: `Ticket ${ticketId}: "${ticketName}" (${ticketUrl}) — status **"to do"** → Phase 2 Visual Design.

## Steps
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. Try to find an approved UX direction (a sub-ticket tagged \`UX-prototype-briefing\`, or a Figma node URL posted as a comment, or an explicit "approved UX:" line).
   - **If you find approved UX** → your Brief cites that Figma node URL + any DS notes.
   - **If there is NO UX sub-ticket and NO UX Figma URL in the comments** → treat this as a greenfield visual task. Do NOT go hunting for UX, do NOT stall, do NOT ask questions. Write a Brief from the ticket description alone and dispatch. Mention in the Brief that there is no prior UX so the designer knows they're defining the layout themselves.
2. Dispatch ONE Visual Designer with the Brief:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-designer -d '{"workspacePath":"<project>","ticketId":"${ticketId}","ticketName":"${ticketName}","ticketUrl":"${ticketUrl}","additionalPrompt":"<Brief>"}'\`
   Brief template is in your system prompt — fill what you have, flag what's missing.
3. Only \`success:true\` counts. On \`success:false\`, leave ticket alone, wait ~60s, retry.
4. ${AI_REVIEW_AUTO_ESCALATE
	? 'That\'s it for you — Visual QA AI Review runs automatically when the designer finishes. PASS → "qa test", FAIL → revision auto-pickup.'
	: 'That\'s it for you — the designer will move the ticket to "qa test" when finished, and a human reviews from there.'}`;

	initialTask += EXIT_REMINDER;

	// Launch Jan
	const newSessionId = crypto.randomUUID();
	jan.currentSessionId = newSessionId;
	jan.currentTicketId = ticketId;
	jan.currentTicketName = ticketName;
	jan.currentTicketUrl = ticketUrl;
	savePersistentAgents(persistentAgents);
	ensureAgentMemory(jan.id);

	const cwd = expandHome(jan.workspacePath || '~');
	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}
	const mcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	if (!launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--permission-mode', 'auto'] })) {
		console.log(`[Standalone] Failed to launch Jan for ticket ${ticketId}`);
	}
}

/**
 * Launch Jan with a batch of tickets — up to N "to do" (each dispatches one
 * Visual Designer) plus up to 1 "ai review" (dispatches Visual QA). All
 * dispatches fire from the same Jan session so she doesn't need to be
 * relaunched per ticket.
 */
export function handleJanBatchDispatch(
	batch: Array<{ id: string; name: string; url: string; status: 'to do' | 'ai review' }>,
	ctx: ServerContext,
): void {
	if (batch.length === 0) return;
	const { persistentAgents } = ctx;

	// Find or create Jan
	let jan = persistentAgents.find(p => p.name === 'Jan');
	if (!jan) {
		jan = {
			id: generateAgentId(),
			name: 'Jan',
			roleShort: JAN_ROLE_SHORT,
			roleFull: 'The Art Director. Receives design briefings, delegates to PM and designers, reviews output, and maintains design quality standards.',
			workspacePath: JAN_WORKSPACE,
		};
		persistentAgents.push(jan);
		savePersistentAgents(persistentAgents);
	}

	if (jan.currentSessionId) {
		console.log(`[Standalone] Jan already has an active session ${jan.currentSessionId}, skipping batch dispatch`);
		return;
	}

	// Build roster (excluding Jan)
	const knownProjects = loadKnownProjects();
	const roster: RosterEntry[] = persistentAgents
		.filter(p => p.id !== jan!.id)
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

	const systemPrompt = buildJanSystemPrompt(jan, roster, SERVER_PORT);

	// Build the multi-ticket initial task. Jan processes each in sequence but
	// the dispatched agents all run in parallel once fired.
	const ticketLines = batch.map((t, i) =>
		`${i + 1}. **[${t.status.toUpperCase()}]** ${t.id}: "${t.name}" (${t.url})`,
	).join('\n');

	const initialTask = `You have ${batch.length} ticket${batch.length === 1 ? '' : 's'} to dispatch. Work through them in order — do NOT stop after the first one.

${ticketLines}

## For each ticket above:

### If status is **"to do"** (Phase 2 Visual Design)
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. Find an approved UX direction (sub-ticket tagged \`UX-prototype-briefing\`, a Figma node URL in comments, or an explicit "approved UX:" line).
   - If found → cite that Figma node URL + any DS notes in your Brief.
   - If none → greenfield. Do NOT stall or ask questions. Write a Brief from the ticket description alone and note the missing UX.
2. Dispatch ONE Visual Designer:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-designer -d '{"workspacePath":"~/Projects/<project>","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>","additionalPrompt":"<Brief>"}'\`
3. Only \`success:true\` counts. On \`success:false\`, skip this one and move on — it'll be retried on the next pickup cycle.

### If status is **"ai review"** — DELEGATE ONLY. Your sole action is the curl call.
1. Fire the dispatch:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-qa -d '{"ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>"}'\`
2. FORBIDDEN in this mode: \`clickup_get_task\`, \`clickup_get_task_comments\`, any \`figma_*\` tool, any \`clickup_update_task\` (status), any comment. The Visual Quality Reviewer agent is the one that reads the ticket, opens Figma, counts FRAME vs INSTANCE nodes, writes the verdict, and moves the ticket to \`in progress\` (on start) then \`qa test\`/\`to do\` (on finish). You MUST NOT do any of these steps.
3. Only \`success:true\` counts. On \`success:false\`, skip and move on to the next ticket in the batch.

## When you're done
After dispatching (or skipping) every ticket above, you are DONE. Do not wait for designers or QA to finish — they run in parallel on their own timelines. ${EXIT_REMINDER.trim()}`;

	// Launch Jan. Track only the first ticket on the persistent-agent record
	// (used for UI labels); the rest are recorded in the initial task.
	const first = batch[0];
	const newSessionId = crypto.randomUUID();
	jan.currentSessionId = newSessionId;
	jan.currentTicketId = first.id;
	jan.currentTicketName = first.name;
	jan.currentTicketUrl = first.url;
	savePersistentAgents(persistentAgents);
	ensureAgentMemory(jan.id);

	const cwd = expandHome(jan.workspacePath || '~');
	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}
	const mcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	if (!launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--permission-mode', 'auto'] })) {
		console.log(`[Standalone] Failed to launch Jan batch of ${batch.length}`);
		jan.currentSessionId = undefined;
		savePersistentAgents(persistentAgents);
	}
}

// ── Designer launch (sequential, one at a time per device) ─────────────────
// Fleet semantics: the Figma lock is PER DEVICE. Jan can have one designer
// running on the hub AND one on each remote worker laptop simultaneously.

// The Figma lock covers every agent that touches the local Figma instance:
// UX Designer, Visual Designer, and Visual QA (which evaluates designer output
// in the same Figma). At most one of these roles may hold the lock on a given
// machine at a time. This function returns the agent currently holding the
// lock, or undefined if free.
function findFigmaLockHolder(persistentAgents: PersistentAgent[]): PersistentAgent | undefined {
	return persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT
			|| p.roleShort === VISUAL_DESIGNER_ROLE_SHORT
			|| p.roleShort === VISUAL_QA_ROLE_SHORT)
			&& p.currentSessionId,
	);
}

async function dispatchDesignerToFleet(
	msg: Record<string, unknown>,
	ctx: ServerContext,
	rpcType: 'launchDesigner' | 'launchVisualDesigner',
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

	// Ship agent memories so the designer on the worker has up-to-date context
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



/**
 * Launch a single designer agent on a briefing ticket.
 * Designers run in the specified project workspace directory (not centralized).
 *
 * On the hub: tries to launch locally first (one designer per machine — shared Figma).
 * If the local Figma is busy, cascades to any idle remote worker that advertises the
 * 'designer' role. Returns `{ success, worker }` so callers (Jan, humans) can confirm
 * that the job actually started on some device before assuming progress.
 *
 * On a worker: launches locally (this path is triggered by a hub RPC).
 */
export async function handleLaunchDesigner(msg: Record<string, unknown>, ctx: ServerContext): Promise<{ success: boolean; error?: string; worker?: string }> {
	const local = tryLaunchDesignerLocal(msg, ctx);
	if (local.success) return { ...local, worker: ctx.workerIdentity?.name };
	if (!ctx.isWorkerMode && local.figmaBusy) {
		return dispatchDesignerToFleet(msg, ctx, 'launchDesigner', local.error);
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

	if (!workspacePath) {
		return { success: false, error: 'Missing required field: workspacePath' };
	}
	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	const { persistentAgents } = ctx;

	// Figma lock: only one designer/QA can run at a time on THIS machine
	const activeFigma = findFigmaLockHolder(persistentAgents);
	if (activeFigma) {
		return { success: false, figmaBusy: true, error: `Local Figma busy: "${activeFigma.name}" (${activeFigma.roleShort}) is already running.` };
	}

	// Resolve project description
	const knownProjects = loadKnownProjects();
	const projName = path.basename(workspacePath);
	const project = knownProjects.find(k => k.name === projName);
	const projectDescription = project?.description;

	// Pick a free worker from the UX team (any team member, not workspace-specific)
	const designer = persistentAgents.find(
		p => p.roleShort === DESIGNER_ROLE_SHORT
			&& p.teamId === TEAM_UX_ID
			&& !p.currentSessionId
			&& !p.retired,
	);

	if (!designer) {
		return { success: false, error: 'No free UX Designers available — all team members are busy.' };
	}

	// Reassign workspace to the target project for this session
	designer.workspacePath = workspacePath;

	const systemPrompt = buildDesignerSystemPrompt(designer, projectDescription);

	const briefBlock = brief
		? `${brief}\n\n`
		: `⚠ No Brief was passed by Jan — you will need to read the ticket description yourself.\n\n`;
	const revisionLine = revisionMode
		? 'REVISION: read the LATEST Jan review comment on the ticket for required changes. Preserve what was approved.\n\n'
		: '';

	const initialTask = `Ticket ${ticketId}: "${ticketName}" (${ticketUrl})

${revisionLine}${briefBlock}## Steps
1. Move ticket to "in progress".
2. Open a new Figma page: \`${ticketId} — ${ticketName}\`.
3. Design based on the Brief above. Only pull the sub-ticket if you need a detail the Brief doesn't cover.
4. Screenshot + post Figma page URL as a ClickUp comment.
5. Move ticket to "qa test".${EXIT_REMINDER}`;

	// Launch the designer
	const newSessionId = crypto.randomUUID();
	designer.currentSessionId = newSessionId;
	designer.currentTicketId = ticketId;
	designer.currentTicketName = ticketName;
	designer.currentTicketUrl = ticketUrl;
	ensureAgentMemory(designer.id);

	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}

	const cwd = expandHome(designer.workspacePath || '~');
	const mcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	if (launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--permission-mode', 'auto'] })) {
		savePersistentAgents(persistentAgents);
		console.log(`[Standalone] Launched designer "${designer.name}" for ticket ${ticketId} in ${cwd}`);
		return { success: true };
	}

	designer.currentSessionId = undefined;
	savePersistentAgents(persistentAgents);
	console.log(`[Standalone] Failed to launch designer "${designer.name}" for ticket ${ticketId}`);
	return { success: false, error: 'Failed to launch designer session' };
}

// ── Visual Designer (Phase 2) ─────────────────────────────

/**
 * Launch a visual designer agent on an approved ticket for polished implementation.
 * Similar to handleLaunchDesigner but uses the Visual Designer role and system prompt.
 * On the hub: launches locally if Figma is free, else cascades to any idle 'designer'
 * worker on the fleet so Jan can have a visual designer running on each device.
 */
export async function handleLaunchVisualDesigner(msg: Record<string, unknown>, ctx: ServerContext): Promise<{ success: boolean; error?: string; worker?: string }> {
	const local = tryLaunchVisualDesignerLocal(msg, ctx);
	if (local.success) return { ...local, worker: ctx.workerIdentity?.name };
	if (!ctx.isWorkerMode && local.figmaBusy) {
		return dispatchDesignerToFleet(msg, ctx, 'launchVisualDesigner', local.error);
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

	if (!workspacePath) {
		return { success: false, error: 'Missing required field: workspacePath' };
	}
	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	const { persistentAgents } = ctx;

	// Figma lock: only one designer/QA can run at a time on THIS machine
	const activeFigma = findFigmaLockHolder(persistentAgents);
	if (activeFigma) {
		return { success: false, figmaBusy: true, error: `Local Figma busy: "${activeFigma.name}" (${activeFigma.roleShort}) is already running.` };
	}

	// Resolve project description
	const knownProjects = loadKnownProjects();
	const projName = path.basename(workspacePath);
	const project = knownProjects.find(k => k.name === projName);
	const projectDescription = project?.description;

	// Pick a free worker from the Visual team
	const designer = persistentAgents.find(
		p => p.roleShort === VISUAL_DESIGNER_ROLE_SHORT
			&& p.teamId === TEAM_VISUAL_ID
			&& !p.currentSessionId
			&& !p.retired,
	);

	if (!designer) {
		return { success: false, error: 'No free Visual Designers available — all team members are busy.' };
	}

	// Reassign workspace to the target project for this session
	designer.workspacePath = workspacePath;

	const designConfig = getJanDesignConfig();
	const systemPrompt = buildVisualDesignerSystemPrompt(designer, projectDescription, designConfig);

	const briefBlock = brief
		? `${brief}\n\n`
		: `⚠ No Brief was passed by Jan — look at the ticket to find the approved UX Figma node.\n\n`;
	const revisionLine = revisionMode
		? 'REVISION: read the LATEST Jan/QA review comment on the ticket and address it. Preserve what was approved.\n\n'
		: '';

	const initialTask = `Ticket ${ticketId}: "${ticketName}" (${ticketUrl})

${revisionLine}${briefBlock}## Steps
1. Move ticket to "in progress".
2. Run the Component discipline protocol from your system prompt: family scan (A) + shopping list (B) from the approved UX Figma node in the Brief. Keep the summary short — do NOT dump the whole library into context.
3. Create the page \`${ticketId} — Visual Design — {short descriptor}\` — the descriptor is 2–4 words you pick to describe what's on the page (e.g. \`Dashboard Overview\`, \`Onboarding Flow\`), so humans can tell pages apart. If the shopping list includes candidates, also create \`__Candidates — ${ticketId}\` in the same file.
4. Build the screens using just-in-time lookup (C). New components go on the candidates page, NOT the canonical DS.
5. Final audit (F). Screenshot + post Figma page URL as a ClickUp comment (include a "Candidates for promotion" list if any, and note any checklist items you flag N/A).
6. ${AI_REVIEW_AUTO_ESCALATE ? 'Move ticket to "ai review" — the Visual Quality Reviewer will auto-pick it up.' : 'Move ticket to "qa test". A human reviews from there.'}${EXIT_REMINDER}`;

	// Launch the visual designer
	const newSessionId = crypto.randomUUID();
	designer.currentSessionId = newSessionId;
	designer.currentTicketId = ticketId;
	designer.currentTicketName = ticketName;
	designer.currentTicketUrl = ticketUrl;
	ensureAgentMemory(designer.id);

	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}

	const cwd = expandHome(designer.workspacePath || '~');
	const mcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	if (launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--permission-mode', 'auto'] })) {
		savePersistentAgents(persistentAgents);
		console.log(`[Standalone] Launched visual designer "${designer.name}" for ticket ${ticketId} in ${cwd}`);
		return { success: true };
	}

	designer.currentSessionId = undefined;
	savePersistentAgents(persistentAgents);
	console.log(`[Standalone] Failed to launch visual designer "${designer.name}" for ticket ${ticketId}`);
	return { success: false, error: 'Failed to launch visual designer session' };
}

// ── Jan review of designer output ───────────────────────────

export function handleJanReviewDesigner(
	completedTicket: { ticketId: string; ticketName: string; ticketUrl: string; designerName: string; workspacePath: string },
	ctx: ServerContext,
): void {
	const { ticketId, ticketName, ticketUrl, designerName } = completedTicket;
	const { persistentAgents } = ctx;

	// Find or create Jan (same as handleJanDesignBriefing)
	let jan = persistentAgents.find(p => p.name === 'Jan');
	if (!jan) {
		jan = {
			id: generateAgentId(),
			name: 'Jan',
			roleShort: JAN_ROLE_SHORT,
			roleFull: 'The Art Director. Receives design briefings, delegates to PM and designers, reviews output, and maintains design quality standards.',
			workspacePath: JAN_WORKSPACE,
		};
		persistentAgents.push(jan);
		savePersistentAgents(persistentAgents);
	}

	if (jan.currentSessionId) {
		console.log(`[Standalone] Jan already has an active session ${jan.currentSessionId}, skipping review for ticket ${ticketId}`);
		return;
	}

	// Build roster (excluding Jan)
	const knownProjects = loadKnownProjects();
	const roster: RosterEntry[] = persistentAgents
		.filter(p => p.id !== jan!.id)
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

	const systemPrompt = buildJanSystemPrompt(jan, roster, SERVER_PORT);
	const initialTask = buildJanReviewPrompt({ ticketId, ticketName, ticketUrl, designerName }) + EXIT_REMINDER;

	const newSessionId = crypto.randomUUID();
	jan.currentSessionId = newSessionId;
	jan.currentTicketId = ticketId;
	jan.currentTicketName = ticketName;
	jan.currentTicketUrl = ticketUrl;
	savePersistentAgents(persistentAgents);
	ensureAgentMemory(jan.id);

	const cwd = expandHome(jan.workspacePath || '~');
	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}

	// Merge peers + mempalace MCP configs for review session
	const peersMcpConfigPath = ensurePeersMcpConfig();
	const mempalaceMcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	const mcpConfigPath = mergeMcpConfigs(peersMcpConfigPath, mempalaceMcpConfigPath);

	if (!launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--permission-mode', 'auto'] })) {
		console.log(`[Standalone] Failed to launch Jan for review of ticket ${ticketId}`);
	}
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

	// Free the remote worker slot
	clearWorkerTicket(sourceWs, ctx);

	// Persist any memory updates the worker captured
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
			setTimeout(() => handleVisualQaReview(completedTicket, ctx), REVIEW_TRIGGER_DELAY_MS);
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

// ── Visual QA AI Review ─────────────────────────────────────

/**
 * Pick up a ticket that a Visual Designer just moved to "ai review".
 * Launches the team's Visual Quality Reviewer to evaluate the work.
 * The QA agent decides Pass (→ "qa test") or Fail (→ "to do" for revision).
 */
export function handleVisualQaReview(
	completedTicket: { ticketId: string; ticketName: string; ticketUrl: string; designerName: string; workspacePath: string },
	ctx: ServerContext,
): void {
	const { ticketId, ticketName, ticketUrl, designerName } = completedTicket;
	const { persistentAgents } = ctx;

	// Find the Visual QA agent (seeded at startup)
	const qa = persistentAgents.find(
		p => p.roleShort === VISUAL_QA_ROLE_SHORT && p.teamId === TEAM_VISUAL_ID,
	);
	if (!qa) {
		console.log(`[Standalone] No Visual QA agent seeded — cannot review ticket ${ticketId}`);
		return;
	}
	if (qa.currentSessionId) {
		console.log(`[Standalone] Visual QA "${qa.name}" is already busy, deferring review of ticket ${ticketId}`);
		return;
	}
	// Figma lock: defer if a designer is already running on this machine so we
	// don't fight them for Figma. autoVisualQaPickup will retry on the next poll.
	const activeFigma = findFigmaLockHolder(persistentAgents);
	if (activeFigma) {
		console.log(`[Standalone] Local Figma busy: "${activeFigma.name}" (${activeFigma.roleShort}) is running — deferring Visual QA for ticket ${ticketId}`);
		return;
	}

	const qaDesignConfig = getJanDesignConfig();
	const systemPrompt = buildVisualQaSystemPrompt(qa, qaDesignConfig);
	const initialTask = buildVisualQaInitialTask({ ticketId, ticketName, ticketUrl, designerName }) + EXIT_REMINDER;

	const newSessionId = crypto.randomUUID();
	qa.currentSessionId = newSessionId;
	qa.currentTicketId = ticketId;
	qa.currentTicketName = ticketName;
	qa.currentTicketUrl = ticketUrl;
	savePersistentAgents(persistentAgents);
	ensureAgentMemory(qa.id);

	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}

	// Visual QA needs peers (to ping the designer) + mempalace
	const peersMcpConfigPath = ensurePeersMcpConfig();
	const mempalaceMcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	const mcpConfigPath = mergeMcpConfigs(peersMcpConfigPath, mempalaceMcpConfigPath);

	const cwd = expandHome(qa.workspacePath || '~');
	if (launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--permission-mode', 'auto'] })) {
		console.log(`[Standalone] Launched Visual QA "${qa.name}" for AI review of ticket ${ticketId}`);
	} else {
		qa.currentSessionId = undefined;
		savePersistentAgents(persistentAgents);
		console.log(`[Standalone] Failed to launch Visual QA for ticket ${ticketId}`);
	}
}

/**
 * Scan ClickUp for any tickets sitting in "ai review" with no QA agent assigned
 * (e.g. after a server restart while a QA review was pending). Picks them up.
 */
export function autoVisualQaPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;
	if (!AI_REVIEW_PICKUP_ENABLED) return; // Pickup disabled — QA doesn't scan for "ai review" tickets

	const qa = ctx.persistentAgents.find(
		p => p.roleShort === VISUAL_QA_ROLE_SHORT && p.teamId === TEAM_VISUAL_ID,
	);
	if (!qa || qa.currentSessionId) return;

	for (const group of ctx.clickupTickets) {
		if (group.name.toLowerCase() !== 'ai review') continue;
		// Only pick up tickets assigned to Jan — Darryl's ai review tickets
		// go through autoDarrylPickup → handleDarrylHandleTicket instead
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
		}, ctx);
		return;
	}
}

// ── Auto-revision pickup ────────────────────────────────────

export function autoDesignerRevisionPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;

	// Check if any designer (UX or Visual) is already running
	const activeDesigner = ctx.persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT || p.roleShort === VISUAL_DESIGNER_ROLE_SHORT) && p.currentSessionId,
	);
	if (activeDesigner) return;

	// Find tickets in "revision needed" status
	const revisionTickets: Array<{ id: string; name: string; url: string }> = [];
	for (const group of ctx.clickupTickets) {
		if (group.name.toLowerCase() !== 'revision needed') continue;
		for (const task of group.tasks) {
			revisionTickets.push({ id: task.id, name: task.name, url: task.url });
		}
	}

	if (revisionTickets.length === 0) return;

	const ticket = revisionTickets[0];

	// Find the designer (UX or Visual) who previously worked on this ticket
	const previousDesigner = ctx.persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT || p.roleShort === VISUAL_DESIGNER_ROLE_SHORT)
			&& !p.currentSessionId
			&& p.lastTicketId === ticket.id,
	);

	if (!previousDesigner) {
		console.log(`[Standalone] No idle designer found for revision ticket ${ticket.id}`);
		return;
	}

	// Use the appropriate launch handler based on the designer's role
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
