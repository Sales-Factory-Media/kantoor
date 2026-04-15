import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadKnownProjects } from '../src/projectStore.js';
import { CLICKUP_POLL_INTERVAL_MS, DARRYL_ROLE_SHORT, DARRYL_CLICKUP_USERNAME, DARRYL_ESCALATION_USERNAME, DARRYL_WORKSPACE, JAN_ROLE_SHORT, JAN_CLICKUP_USERNAME, JAN_WORKSPACE, PM_ROLE_SHORT, PM_WORKSPACE, DESIGNER_ROLE_SHORT, VISUAL_DESIGNER_ROLE_SHORT, UX_PM_ROLE_SHORT, UX_QA_ROLE_SHORT, VISUAL_PM_ROLE_SHORT, VISUAL_QA_ROLE_SHORT, TEAM_UX_ID, TEAM_VISUAL_ID, SERVER_PORT } from './constants.js';
import { launchAgentSession } from './itermFocus.js';
import {
	savePersistentAgents,
	ensureAgentMemory,
	generateAgentId,
	buildDarrylSystemPrompt,
	buildJanSystemPrompt,
	buildPMSystemPrompt,
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
import type { RosterEntry } from './agentStore.js';
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
	addAssignment,
	collectAgentMemories,
	broadcastWorkerStatus,
} from './workerRegistry.js';

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

	// Check available capacity (hub + idle remote workers)
	const capacity = getAvailableCapacity(ctx);
	if (capacity === 0) return;

	// Distribute tickets up to available capacity
	const ticketsToAssign = todoTickets.slice(0, capacity);
	const idleWorkers = getIdleWorkers(ctx);

	// Hub is available if Darryl isn't currently running
	const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
	const hubAvailable = !darryl?.currentSessionId;

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

	let callInTask: string;
	if (options?.aiReviewMode) {
		// AI Review mode: Copilot has reviewed the PR. Process its feedback (or confirm none) and route the ticket.
		callInTask = `You have been reassigned to ClickUp ticket ${ticketId}: "${ticketName}" because it is currently in the **AI Review** state. GitHub Copilot has reviewed the pull request and may have left inline review comments.
Ticket URL: ${ticketUrl}

## Your job

1. Move the ticket to "in progress" using \`mcp__clickup__clickup_update_task\` (task_id: "${ticketId}", status: "in progress").
2. Read the full ticket with \`mcp__clickup__clickup_get_task\` and ALL comments with \`mcp__clickup__clickup_get_task_comments\`.
3. Find the PR linked to this ticket (check the ticket's linked tasks, the description, or look for a branch \`feature/CU-${ticketId}-*\`). Use \`mcp__github__pull_request_read\` and the GitHub review/comment tools to find Copilot's review comments. Specifically check:
   - Inline review comments left by Copilot on the PR diff
   - Top-level PR review comments by Copilot
   - Any conversation threads where Copilot raised concerns
4. Decide whether there is **actionable feedback** that genuinely needs to be addressed:
   - **Actionable**: a real bug, a security issue, a clear regression, a violated convention you should respect.
   - **Not actionable**: stylistic preferences you disagree with, low-confidence suggestions, things already addressed.
5. Then take ONE of these two paths:

### If there IS actionable feedback to fix:
- Check out the existing feature branch (\`feature/CU-${ticketId}-*\`).
- Implement the requested changes.
- Commit and push (follow the Git Conventions in your system prompt — the CU-${ticketId} reference is mandatory).
- Add a ClickUp comment summarizing what you addressed and explicitly listing anything you intentionally did NOT change and why.
- Move the ticket back to **"ai review"** so Copilot can review the new commit: \`mcp__clickup__clickup_update_task\` (task_id: "${ticketId}", status: "ai review").

### If there is NO actionable feedback (or all feedback has been addressed and resolved):
- Add a ClickUp comment confirming you reviewed Copilot's feedback and explaining why no further changes are needed (or that all prior concerns are resolved).
- Move the ticket to **"qa test"**: \`mcp__clickup__clickup_update_task\` (task_id: "${ticketId}", status: "qa test"). A human will take over from here.

## Important

- Do NOT loop forever. If you have already gone through 3 AI Review rounds on this ticket (count the prior "ai review" → "to do" or "ai review" → "in progress" cycles in the comments), and Copilot keeps flagging minor stylistic things, just move to "qa test" and let the human decide.
- Always commit and push BEFORE moving the ticket back to "ai review", otherwise Copilot will re-review the same code.
- Update MemPalace with what you addressed and any patterns you noticed.`;
	} else {
		// Standard "do new work" mode
		callInTask = `Work on ClickUp ticket ${ticketId}: "${ticketName}". Use the ClickUp MCP tools to read the ticket details, update status, and add comments as you make progress. Ticket URL: ${ticketUrl}\n\nBefore starting any work, check if a branch already exists with the ticket ID (e.g. feature/CU-${ticketId}-*). If it does, check it out. If not, create a new feature branch from develop following the convention: feature/CU-${ticketId}-<short-description>.\n\nWhen you are done with the work and your PR is open, move the ticket to "ai review" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "ai review"). GitHub Copilot will then review your PR. Do NOT move the ticket directly to "qa test" — Darryl will reassign someone (possibly you) to process Copilot's feedback later.`;
	}

	const knownProjects = loadKnownProjects();
	const project = knownProjects.find(p => p.workspacePath === pa.workspacePath);
	if (project?.description) {
		callInTask += `\n\n## Project Context\n\n${project.description}`;
	}

	if (options?.additionalPrompt) {
		callInTask += `\n\n## Additional Instructions\n\n${options.additionalPrompt}`;
	}

	if (options?.useTeam) {
		callInTask += '\n\nCreate an agent team to work on this ticket. Break the work into parallel tasks and spawn teammates to handle them.';
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
		? `ClickUp ticket ${ticketId}: "${ticketName}" is in **AI Review** state. GitHub Copilot has reviewed (or is reviewing) the pull request. Your job is to dispatch an agent to process Copilot's feedback and route the ticket forward.
Ticket URL: ${ticketUrl}

## Steps

1. Read the full ticket with \`mcp__clickup__clickup_get_task\` (task_id: "${ticketId}") and ALL comments with \`mcp__clickup__clickup_get_task_comments\`. Identify:
   - Which workspace/project this ticket belongs to (look at the linked branch \`feature/CU-${ticketId}-*\` or any prior assignment comments — comments like "Assigned to worker: ..." identify the original implementer).
   - Whether a previous agent has already cycled through AI Review (count prior "ai review" → "in progress" cycles in the comments).
2. Pick which agent should process the feedback:
   - **Preferred**: the same agent who originally implemented the ticket — they have the most context. Find them in your roster by name.
   - **Fallback**: any free (OFFLINE) agent in the SAME workspace as the ticket's project.
   - Avoid switching agents mid-ticket unless the original is gone.
3. Dispatch them with the AI Review mode flag set:
\`\`\`
curl -X POST http://localhost:${SERVER_PORT}/api/launch-agent \\
  -H 'Content-Type: application/json' \\
  -d '{"agentId":"<id>","ticketId":"${ticketId}","ticketName":"${ticketName}","ticketUrl":"${ticketUrl}","aiReviewMode":true}'
\`\`\`
   The \`aiReviewMode: true\` flag gives the agent the right initial task automatically — they will move the ticket to "in progress", read Copilot's feedback, decide whether to fix anything, and either move back to "ai review" (after pushing fixes) or forward to "qa test" (when no actionable feedback remains).
4. Comment on the ClickUp ticket noting which agent you reassigned and why. Use \`mcp__clickup__clickup_create_task_comment\`.
5. Update MemPalace with your dispatch decision (\`mcp__mempalace__mempalace_add_drawer\`). Record generously.

## Important

- Do NOT do the AI Review processing yourself — your job is to dispatch. The reassigned agent owns the work.
- Do NOT change the ticket status yourself. The reassigned agent will move it to "in progress" as their first step.
- If you have already cycled the same ticket through AI Review 3 or more times (count from comments), instruct the reassigned agent in an additionalPrompt to be conservative: only fix genuine issues, otherwise forward to qa test.`
		: `Assess ClickUp ticket ${ticketId}: "${ticketName}"
Ticket URL: ${ticketUrl}

## Steps

1. FIRST: Move the ticket to "in progress" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "in progress")
2. Read the full ticket with mcp__clickup__clickup_get_task (task_id: "${ticketId}")
3. Read the ticket's comments with mcp__clickup__clickup_get_task_comments (task_id: "${ticketId}") to check for additional context, questions, or prior discussion
4. Decide if the ticket is complete enough to work on (considering both the description and comments)
5. Then follow ONE of these paths:

### If NOT complete (needs human input):
- Comment on the ticket with your questions using mcp__clickup__clickup_create_task_comment
- Unassign yourself ("${DARRYL_CLICKUP_USERNAME}") and assign "${DARRYL_ESCALATION_USERNAME}" using mcp__clickup__clickup_update_task
- Move the ticket back to "to do" using mcp__clickup__clickup_update_task (status: "to do")

### If complete AND you can do it yourself:
- Do the work
- When finished and your PR is open, move the ticket to "ai review" using mcp__clickup__clickup_update_task (status: "ai review"). GitHub Copilot will review the PR; you (as Darryl) will see the ticket again later in "ai review" state and reassign someone to process Copilot's feedback. Do NOT move directly to "qa test".

### If complete AND you delegate to another agent:
- Pick the best agent from your roster and launch them via the HTTP API
- IMPORTANT: In the additionalPrompt, instruct them that when they finish and their PR is open, they must move the ticket to "ai review" (NOT "qa test") so GitHub Copilot can review.

6. Update MemPalace with your decision (use mcp__mempalace__mempalace_add_drawer)`;

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

	const initialTask = `You have received a design ticket via ClickUp ticket ${ticketId}: "${ticketName}"
Ticket URL: ${ticketUrl}
Current ticket status: **${ticketStatus}**

## Steps

1. FIRST: Move the ticket to "in progress" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "in progress")
2. Read the full ticket with mcp__clickup__clickup_get_task (task_id: "${ticketId}")
3. Read the ticket's comments with mcp__clickup__clickup_get_task_comments (task_id: "${ticketId}") for additional context
4. Assess the ticket: Is it clear enough to proceed? Does it have the information you need?

### If NOT complete (needs more info):
- Comment on the ticket with specific questions using mcp__clickup__clickup_create_task_comment
- Move the ticket back to "${ticketStatus}" using mcp__clickup__clickup_update_task (status: "${ticketStatus}")

${isRefineMode ? `### Mode: UX Exploration (ticket was "to refine")

This ticket is in the **brainstorming/exploration phase**. Your job is to kick off Phase 1 — UX Exploration.

**Step A — Delegate to PM agent to create 5 UX briefings:**
Launch the PM agent via the HTTP API. The PM will read the briefing and create 5 diverse UX design sub-tickets.
\`\`\`
curl -X POST http://localhost:${SERVER_PORT}/api/launch-pm -H 'Content-Type: application/json' -d '{"ticketId":"${ticketId}","ticketName":"${ticketName}","ticketUrl":"${ticketUrl}","listId":"<list-id-from-ticket>"}'
\`\`\`
Find the list ID from the ticket details (it's in the "list" field). Wait for the PM to finish (ticket status moves to "qa test").

**Step B — Review the 5 briefings for diversity:**
Once the PM is done, read the 5 sub-tickets it created. Verify they are genuinely different directions, not minor variations.
If any briefings are too similar, comment on them with specific feedback.

**Step C — Launch designers ONE AT A TIME:**
For each of the 5 briefing sub-tickets, launch a designer:
\`\`\`
curl -X POST http://localhost:${SERVER_PORT}/api/launch-designer -H 'Content-Type: application/json' -d '{"workspacePath":"<project-workspace-path>","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>"}'
\`\`\`
IMPORTANT: Only one designer can run at a time (they share the same local Figma instance).
Launch the first designer, wait for it to finish (ticket moves to "qa test"), then launch the next.
Use the workspace path of the PROJECT being designed (e.g. ~/Projects/brightmind), NOT the kantoor-workspace.` : `### Mode: Visual Design (ticket was "to do")

This ticket is in the **production-ready visual implementation phase**. The UX exploration is done — a direction has been chosen.
Your job is to kick off Phase 2 — Visual Design for polished, production-ready output.

**Step A — Hand off to the Visual Design Team:**
Launch a Visual Designer from the Visual Design Team on this ticket. The endpoint automatically picks a free team member; if all 5 are busy or another designer is currently on Figma, it returns an error and you should wait + retry.
\`\`\`
curl -X POST http://localhost:${SERVER_PORT}/api/launch-visual-designer -H 'Content-Type: application/json' -d '{"workspacePath":"<project-workspace-path>","ticketId":"${ticketId}","ticketName":"${ticketName}","ticketUrl":"${ticketUrl}"}'
\`\`\`
Use the workspace path of the PROJECT being designed (e.g. ~/Projects/brightmind), NOT the kantoor-workspace.

**Step B — Let the AI Review pipeline run:**
You do NOT review the visual output yourself anymore. When the Visual Designer finishes, they move the ticket to "ai review", and the team's Visual Quality Reviewer automatically picks it up. The Visual QA decides:
- **Pass** → ticket moves to "qa test" for human review (your job is done for this ticket)
- **Fail** → ticket moves back to "to do" with structured feedback, and a free Visual Designer auto-picks it up for revision

You can monitor progress via ClickUp comments, but no manual review action is required from you on visual tickets unless something looks off after the human QA pass.`}

5. Update MemPalace with your decisions (use mcp__mempalace__mempalace_add_drawer)`;

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

// ── PM (Project Manager) launch ─────────────────────────────

/**
 * Launch the PM agent on a design briefing ticket.
 * The PM reads the briefing, analyzes context, and creates 5 diverse UX design
 * briefing sub-tickets in ClickUp. Called by Jan when she receives a complete briefing.
 */
export function handleLaunchPM(msg: Record<string, unknown>, ctx: ServerContext): { success: boolean; error?: string } {
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const listId = msg.listId as string;

	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	const { persistentAgents } = ctx;

	// Check if PM is already running
	const activePM = persistentAgents.find(
		p => p.roleShort === PM_ROLE_SHORT && p.currentSessionId,
	);
	if (activePM) {
		return { success: false, error: `PM "${activePM.name}" is already running. Wait for it to finish before launching another.` };
	}

	// Find an idle PM or create one
	let pm = persistentAgents.find(
		p => p.roleShort === PM_ROLE_SHORT && !p.currentSessionId,
	);

	if (!pm) {
		pm = {
			id: generateAgentId(),
			name: pickRandomName(persistentAgents),
			roleShort: PM_ROLE_SHORT,
			roleFull: 'Project Manager in Jan\'s design pipeline. Analyzes technical briefings and creates 5 diverse UX design briefing tickets.',
			workspacePath: PM_WORKSPACE,
		};
		persistentAgents.push(pm);
	}

	const systemPrompt = buildPMSystemPrompt(pm);

	const listIdInstruction = listId
		? `Use list_id "${listId}" when creating the sub-tickets.`
		: 'Read the parent ticket to find which list it belongs to, and create sub-tickets in that same list.';

	const initialTask = `You have been assigned a design briefing by Jan (Art Director) via ClickUp ticket ${ticketId}: "${ticketName}"
Ticket URL: ${ticketUrl}

## Steps

1. FIRST: Move the ticket to "in progress" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "in progress")
2. Read the full ticket with mcp__clickup__clickup_get_task (task_id: "${ticketId}", subtasks: true)
3. Read the ticket's comments with mcp__clickup__clickup_get_task_comments (task_id: "${ticketId}") for additional context from Jan
4. If the ticket has a parent, read the parent ticket too for broader project context
5. Search MemPalace for relevant design decisions and component knowledge
6. Analyze the briefing and identify 5 genuinely DIFFERENT UX design directions
7. Create 5 ClickUp sub-tickets, each as a subtask of ticket "${ticketId}" (use parent: "${ticketId}")
   ${listIdInstruction}
   - Name each ticket: "UX Direction {N}: {Direction Title}"
   - Include the full briefing format from your system prompt
   - Set priority to "normal"
   - Tag each ticket with "UX-prototype-briefing" using mcp__clickup__clickup_add_tag_to_task
8. After creating all 5 tickets, comment on the parent ticket "${ticketId}" with a summary of the 5 directions you created
9. Move the ticket to "qa test" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "qa test")
10. Update MemPalace with your design directions and reasoning (use mcp__mempalace__mempalace_add_drawer and mcp__mempalace__mempalace_kg_add)`;

	// Launch the PM
	const newSessionId = crypto.randomUUID();
	pm.currentSessionId = newSessionId;
	pm.currentTicketId = ticketId;
	pm.currentTicketName = ticketName;
	pm.currentTicketUrl = ticketUrl;
	ensureAgentMemory(pm.id);

	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}

	const cwd = expandHome(pm.workspacePath || '~');
	const mcpConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	if (launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { mcpConfigPath, extraFlags: ['--dangerously-skip-permissions'] })) {
		savePersistentAgents(persistentAgents);
		console.log(`[Standalone] Launched PM "${pm.name}" for ticket ${ticketId}`);
		return { success: true };
	}

	pm.currentSessionId = undefined;
	savePersistentAgents(persistentAgents);
	console.log(`[Standalone] Failed to launch PM "${pm.name}" for ticket ${ticketId}`);
	return { success: false, error: 'Failed to launch PM session' };
}

// ── Designer launch (sequential, one at a time) ────────────

/**
 * Launch a single designer agent on a briefing ticket.
 * Designers run in the specified project workspace directory (not centralized).
 * Reuses an idle designer agent for the workspace or creates a new one.
 *
 * Jan should call this once per briefing ticket. Only one designer runs at a time
 * to avoid Figma MCP conflicts (all agents share the same local Figma instance).
 * Use ClickUp ticket status to track which briefings are done and which are next.
 */
export function handleLaunchDesigner(msg: Record<string, unknown>, ctx: ServerContext): { success: boolean; error?: string } {
	const workspacePath = msg.workspacePath as string;
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const revisionMode = msg.revisionMode as boolean | undefined;

	if (!workspacePath) {
		return { success: false, error: 'Missing required field: workspacePath' };
	}
	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	const { persistentAgents } = ctx;

	// Figma lock: only one designer (UX OR Visual) can run at a time across all teams
	const activeDesigner = persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT || p.roleShort === VISUAL_DESIGNER_ROLE_SHORT) && p.currentSessionId,
	);
	if (activeDesigner) {
		return { success: false, error: `Designer "${activeDesigner.name}" (${activeDesigner.roleShort}) is already running on Figma. Wait for it to finish before launching another.` };
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
			&& !p.currentSessionId,
	);

	if (!designer) {
		return { success: false, error: 'No free UX Designers available — all team members are busy.' };
	}

	// Reassign workspace to the target project for this session
	designer.workspacePath = workspacePath;

	// Build designer-specific system prompt
	const systemPrompt = buildDesignerSystemPrompt(designer, projectDescription);

	const revisionPreamble = revisionMode
		? `IMPORTANT: This is a REVISION. Jan (Art Director) has reviewed your previous work and requested changes.
Read the ClickUp comments carefully — Jan's latest review comment contains specific, actionable feedback you MUST address.
Focus on the requested changes while preserving what Jan approved.

`
		: '';

	const initialTask = `${revisionPreamble}You have been assigned a design briefing via ClickUp ticket ${ticketId}: "${ticketName}"
Ticket URL: ${ticketUrl}

## Steps

1. FIRST: Move the ticket to "in progress" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "in progress")
2. Read the full ticket with mcp__clickup__clickup_get_task (task_id: "${ticketId}")
3. Read the ticket's comments with mcp__clickup__clickup_get_task_comments (task_id: "${ticketId}") for additional context
4. Search MemPalace for relevant design decisions and component knowledge
5. Create your design on a clean Figma playground board:
   - Name your page/frame: \`${ticketId} — ${ticketName}\`
   - Focus on creating a genuinely unique design direction
   - Follow the design principles in your system prompt
6. Take screenshots of your work using figma_take_screenshot
7. Post your results as a comment on the ClickUp ticket with screenshots and a summary of your design approach
8. Move the ticket to "qa test" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "qa test")
9. Update MemPalace with what you designed and key decisions (use mcp__mempalace__mempalace_add_drawer)`;

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
 * Only one designer (UX or Visual) runs at a time to avoid Figma MCP conflicts.
 */
export function handleLaunchVisualDesigner(msg: Record<string, unknown>, ctx: ServerContext): { success: boolean; error?: string } {
	const workspacePath = msg.workspacePath as string;
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const revisionMode = msg.revisionMode as boolean | undefined;

	if (!workspacePath) {
		return { success: false, error: 'Missing required field: workspacePath' };
	}
	if (!ticketId || !ticketName || !ticketUrl) {
		return { success: false, error: 'Missing required fields: ticketId, ticketName, ticketUrl' };
	}

	const { persistentAgents } = ctx;

	// Figma lock: only one designer (UX OR Visual) can run at a time across all teams
	const activeDesigner = persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT || p.roleShort === VISUAL_DESIGNER_ROLE_SHORT) && p.currentSessionId,
	);
	if (activeDesigner) {
		return { success: false, error: `Designer "${activeDesigner.name}" (${activeDesigner.roleShort}) is already running on Figma. Wait for it to finish before launching another.` };
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
			&& !p.currentSessionId,
	);

	if (!designer) {
		return { success: false, error: 'No free Visual Designers available — all team members are busy.' };
	}

	// Reassign workspace to the target project for this session
	designer.workspacePath = workspacePath;

	// Build visual designer-specific system prompt
	const systemPrompt = buildVisualDesignerSystemPrompt(designer, projectDescription);

	const revisionPreamble = revisionMode
		? `IMPORTANT: This is a REVISION. Jan (Art Director) has reviewed your previous work and requested changes.
Read the ClickUp comments carefully — Jan's latest review comment contains specific, actionable feedback you MUST address.
Focus on the requested changes while preserving what Jan approved.

`
		: '';

	const initialTask = `${revisionPreamble}You have been assigned a visual design task via ClickUp ticket ${ticketId}: "${ticketName}"
Ticket URL: ${ticketUrl}

## Steps

1. FIRST: Move the ticket to "in progress" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "in progress")
2. Read the design handbook from ClickUp (doc page ID: 2kyr1bnu-2675) — understand the design system rules
3. Read the full ticket with mcp__clickup__clickup_get_task (task_id: "${ticketId}")
4. Read the ticket's comments with mcp__clickup__clickup_get_task_comments (task_id: "${ticketId}") — find the approved UX direction and Figma references
5. Examine the approved UX designs in Figma — take screenshots to understand the structure
6. Search MemPalace for relevant design decisions and component knowledge
7. Create your polished visual implementation on a clean Figma playground board:
   - Name your page: \`${ticketId} — Visual Design\`
   - Build to the **Quality Checklist in your system prompt** — that exact list is what the Visual Quality Reviewer will judge you against (design system compliance, tokens, alignment, states, accessibility, responsiveness, faithfulness to UX, overflow, autolayout, component library hygiene). Address every item from the start.
   - Use design system components from the library; create new variants in the design system or a separate component library file rather than as one-offs
8. Take screenshots of your work using figma_take_screenshot
9. Post your results as a comment on the ClickUp ticket with screenshots and the Figma page link. If any checklist item is N/A for a justified reason, state it explicitly so the reviewer can confirm.
10. Move the ticket to "ai review" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "ai review") — the Visual Quality Reviewer will then automatically pick it up
11. Update MemPalace with what you designed and key decisions (use mcp__mempalace__mempalace_add_drawer) — record generously, the team benefits from over-sharing`;

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

	const systemPrompt = buildVisualQaSystemPrompt(qa);
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
