import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadKnownProjects } from '../src/projectStore.js';
import { CLICKUP_POLL_INTERVAL_MS, DARRYL_ROLE_SHORT, DARRYL_CLICKUP_USERNAME, DARRYL_ESCALATION_USERNAME, DARRYL_WORKSPACE, JAN_ROLE_SHORT, JAN_CLICKUP_USERNAME, JAN_WORKSPACE, DESIGNER_ROLE_SHORT, VISUAL_DESIGNER_ROLE_SHORT, VISUAL_QA_ROLE_SHORT, TEAM_UX_ID, TEAM_VISUAL_ID, SERVER_PORT, WORKER_ROLE_DEV, WORKER_ROLE_DESIGNER, DEFAULT_WORKER_ROLES } from './constants.js';
import { launchAgentSession } from './itermFocus.js';
import {
	savePersistentAgents,
	ensureAgentMemory,
	generateAgentId,
	buildDarrylSystemPrompt,
	buildJanSystemPrompt,
	buildDesignerSystemPrompt,
	buildVisualDesignerSystemPrompt,
	buildVisualQaSystemPrompt,
	buildVisualQaInitialTask,
	buildJanReviewPrompt,
	expandHome,
	ensureMempalaceMcpConfig,
	mergeMcpConfigs,
	pickRandomName,
} from './agentStore.js';
import type { RosterEntry, DesignConfig } from './agentStore.js';
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

	// Collect TODO and AI REVIEW tickets assigned to Darryl
	const todoTickets: Array<{ id: string; name: string; url: string; status: string }> = [];
	for (const group of ctx.clickupTickets) {
		const statusLower = group.name.toLowerCase();
		if (statusLower !== 'to do' && statusLower !== 'ai review') continue;
		for (const task of group.tasks) {
			if (task.assignees.some(a => a.username === DARRYL_CLICKUP_USERNAME)) {
				todoTickets.push({ id: task.id, name: task.name, url: task.url, status: statusLower });
			}
		}
	}

	if (todoTickets.length === 0) return;

	// Prioritize ai review tickets over to do — process Copilot feedback before starting new work
	todoTickets.sort((a, b) => {
		if (a.status === 'ai review' && b.status !== 'ai review') return -1;
		if (a.status !== 'ai review' && b.status === 'ai review') return 1;
		return 0;
	});

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

export function autoJanPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;

	// Collect tickets assigned to Jan in "to refine" or "to do" status
	const janTickets: Array<{ id: string; name: string; url: string; status: string }> = [];
	for (const group of ctx.clickupTickets) {
		const statusLower = group.name.toLowerCase();
		if (statusLower !== 'to do' && statusLower !== 'to refine') continue;
		for (const task of group.tasks) {
			if (task.assignees.some(a => a.username === JAN_CLICKUP_USERNAME)) {
				janTickets.push({ id: task.id, name: task.name, url: task.url, status: statusLower });
			}
		}
	}

	if (janTickets.length === 0) return;

	// Jan handles one ticket at a time (like Darryl on the hub)
	const jan = ctx.persistentAgents.find(p => p.name === 'Jan');
	if (jan?.currentSessionId) return; // Already busy

	// Prioritize "to refine" tickets (Phase 1) over "to do" (Phase 2)
	janTickets.sort((a, b) => {
		if (a.status === 'to refine' && b.status !== 'to refine') return -1;
		if (a.status !== 'to refine' && b.status === 'to refine') return 1;
		return 0;
	});

	const ticket = janTickets[0];
	console.log(`[Standalone] Auto-pickup: Jan taking ticket ${ticket.id} (status: ${ticket.status})`);
	handleJanDesignBriefing(
		{ ticketId: ticket.id, ticketName: ticket.name, ticketUrl: ticket.url, ticketStatus: ticket.status },
		ctx,
	);
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
		callInTask = `Ticket ${ticketId}: "${ticketName}" (${ticketUrl}).

${briefBlock}## Steps
1. Move ticket to "in progress".
2. Check out or create branch \`feature/CU-${ticketId}-<short-desc>\` from develop.
3. Do the work. Rely on the Brief above — only re-read the ticket if the Brief is missing something specific.
4. Open a PR. Commit messages must include \`CU-${ticketId}\`.
5. Move ticket to **"ai review"** (not "qa test") — Copilot reviews, then you may be reassigned to process its feedback.`;
	}

	const knownProjects = loadKnownProjects();
	const project = knownProjects.find(p => p.workspacePath === pa.workspacePath);
	if (project?.description) {
		callInTask += `\n\n## Project\n${project.description}`;
	}

	if (options?.useTeam) {
		callInTask += '\n\nUse team mode: spawn sub-agents for parallel work.';
	}

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

	const initialTask = isAiReviewMode
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
	if (!launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--dangerously-skip-permissions'] })) {
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

	const initialTask = isRefineMode
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
1. \`clickup_get_task\` + \`clickup_get_task_comments\` once. Find the approved UX direction and its Figma node link.
2. Dispatch ONE Visual Designer with a Brief:
   \`curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-designer -d '{"workspacePath":"<project>","ticketId":"${ticketId}","ticketName":"${ticketName}","ticketUrl":"${ticketUrl}","additionalPrompt":"<Brief>"}'\`
   The Brief MUST include the approved UX Figma node URL, the scope, and any DS notes. Template in your system prompt.
3. Only \`success:true\` counts. On \`success:false\`, leave ticket alone, wait ~60s, retry.
4. That's it for you — Visual QA AI Review runs automatically when the designer finishes.`;

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
	if (!launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--dangerously-skip-permissions'] })) {
		console.log(`[Standalone] Failed to launch Jan for ticket ${ticketId}`);
	}
}

// ── Designer launch (sequential, one at a time per device) ─────────────────
// Fleet semantics: the Figma lock is PER DEVICE. Jan can have one designer
// running on the hub AND one on each remote worker laptop simultaneously.

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

	// Figma lock: only one designer (UX OR Visual) can run at a time on THIS machine
	const activeDesigner = persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT || p.roleShort === VISUAL_DESIGNER_ROLE_SHORT) && p.currentSessionId,
	);
	if (activeDesigner) {
		return { success: false, figmaBusy: true, error: `Local Figma busy: designer "${activeDesigner.name}" (${activeDesigner.roleShort}) is already running.` };
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
5. Move ticket to "qa test".`;

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
	if (launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--dangerously-skip-permissions'] })) {
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

	// Figma lock: only one designer (UX OR Visual) can run at a time on THIS machine
	const activeDesigner = persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT || p.roleShort === VISUAL_DESIGNER_ROLE_SHORT) && p.currentSessionId,
	);
	if (activeDesigner) {
		return { success: false, figmaBusy: true, error: `Local Figma busy: designer "${activeDesigner.name}" (${activeDesigner.roleShort}) is already running.` };
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
3. Create the page \`${ticketId} — Visual Design\`. If the shopping list includes candidates, also create \`__Candidates — ${ticketId}\` in the same file.
4. Build the screens using just-in-time lookup (C). New components go on the candidates page, NOT the canonical DS.
5. Final audit (F). Screenshot + post Figma page URL as a ClickUp comment (include a "Candidates for promotion" list if any, and note any checklist items you flag N/A).
6. Move ticket to "ai review".`;

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
	if (launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--dangerously-skip-permissions'] })) {
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
	const initialTask = buildJanReviewPrompt({ ticketId, ticketName, ticketUrl, designerName });

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

	if (!launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--dangerously-skip-permissions'] })) {
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
		console.log(`[Hub] Remote Visual Designer finished ticket ${ticketId} — triggering Visual QA AI review`);
		setTimeout(() => handleVisualQaReview(completedTicket, ctx), REVIEW_TRIGGER_DELAY_MS);
		return;
	}
	if (agentRole === DESIGNER_ROLE_SHORT) {
		console.log(`[Hub] Remote UX Designer finished ticket ${ticketId} — triggering Jan review`);
		setTimeout(() => handleJanReviewDesigner(completedTicket, ctx), REVIEW_TRIGGER_DELAY_MS);
		return;
	}
	if (agentRole === VISUAL_QA_ROLE_SHORT || agentRole === JAN_ROLE_SHORT) {
		console.log(`[Hub] Remote ${agentRole} finished ticket ${ticketId} — running revision pickup`);
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

	const qaDesignConfig = getJanDesignConfig();
	const systemPrompt = buildVisualQaSystemPrompt(qa, qaDesignConfig);
	const initialTask = buildVisualQaInitialTask({ ticketId, ticketName, ticketUrl, designerName });

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
	if (launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--dangerously-skip-permissions'] })) {
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
