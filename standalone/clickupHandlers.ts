import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadKnownProjects } from '../src/projectStore.js';
import { CLICKUP_POLL_INTERVAL_MS, DARRYL_ROLE_SHORT, DARRYL_CLICKUP_USERNAME, DARRYL_ESCALATION_USERNAME, DARRYL_WORKSPACE, JAN_ROLE_SHORT, JAN_CLICKUP_USERNAME, JAN_WORKSPACE, PM_ROLE_SHORT, PM_WORKSPACE, DESIGNER_ROLE_SHORT, SERVER_PORT } from './constants.js';
import { launchAgentSession } from './itermFocus.js';
import {
	savePersistentAgents,
	ensureAgentMemory,
	generateAgentId,
	buildDarrylSystemPrompt,
	buildJanSystemPrompt,
	buildPMSystemPrompt,
	buildDesignerSystemPrompt,
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

	// Collect all TODO tickets assigned to Darryl
	const todoTickets: Array<{ id: string; name: string; url: string }> = [];
	for (const group of ctx.clickupTickets) {
		if (group.name.toLowerCase() !== 'to do') continue;
		for (const task of group.tasks) {
			if (task.assignees.some(a => a.username === DARRYL_CLICKUP_USERNAME)) {
				todoTickets.push({ id: task.id, name: task.name, url: task.url });
			}
		}
	}

	if (todoTickets.length === 0) return;

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
				{ ticketId: ticket.id, ticketName: ticket.name, ticketUrl: ticket.url },
				ctx,
			);
		} else {
			const { worker } = slot;
			console.log(`[Hub] Assigning ticket ${ticket.id} to worker "${worker.name}" (${worker.hostname})`);
			addAssignment(ctx, ticket.id, ticket.name, worker.name, worker.hostname);

			worker.ws.send(JSON.stringify({
				type: 'handleTicket',
				ticketId: ticket.id,
				ticketName: ticket.name,
				ticketUrl: ticket.url,
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

	// Collect all TODO tickets assigned to Jan
	const todoTickets: Array<{ id: string; name: string; url: string }> = [];
	for (const group of ctx.clickupTickets) {
		if (group.name.toLowerCase() !== 'to do') continue;
		for (const task of group.tasks) {
			if (task.assignees.some(a => a.username === JAN_CLICKUP_USERNAME)) {
				todoTickets.push({ id: task.id, name: task.name, url: task.url });
			}
		}
	}

	if (todoTickets.length === 0) return;

	// Jan handles one ticket at a time (like Darryl on the hub)
	const jan = ctx.persistentAgents.find(p => p.name === 'Jan');
	if (jan?.currentSessionId) return; // Already busy

	const ticket = todoTickets[0];
	console.log(`[Standalone] Auto-pickup: Jan taking ticket ${ticket.id}`);
	handleJanDesignBriefing(
		{ ticketId: ticket.id, ticketName: ticket.name, ticketUrl: ticket.url },
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
	options?: { useTeam?: boolean; additionalPrompt?: string },
): { success: boolean; error?: string } {
	const { persistentAgents } = ctx;
	const pa = persistentAgents.find(p => p.id === agentId);
	if (!pa) return { success: false, error: `Agent not found: ${agentId}` };

	let callInTask = `Work on ClickUp ticket ${ticketId}: "${ticketName}". Use the ClickUp MCP tools to read the ticket details, update status, and add comments as you make progress. Ticket URL: ${ticketUrl}\n\nBefore starting any work, check if a branch already exists with the ticket ID (e.g. feature/CU-${ticketId}-*). If it does, check it out. If not, create a new feature branch from develop following the convention: feature/CU-${ticketId}-<short-description>.\n\nWhen you are done with the work, move the ticket to "qa test" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "qa test").`;

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

	const result = launchAgentOnTicket(agentId, ticketId, ticketName, ticketUrl, ctx, { useTeam, additionalPrompt });
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

	const initialTask = `Assess ClickUp ticket ${ticketId}: "${ticketName}"
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
- When finished, move the ticket to "qa test" using mcp__clickup__clickup_update_task (status: "qa test")

### If complete AND you delegate to another agent:
- Pick the best agent from your roster and launch them via the HTTP API
- IMPORTANT: In the additionalPrompt, instruct them that when they finish, they must move the ticket to "qa test" using mcp__clickup__clickup_update_task (status: "qa test")

6. Update your memory file with your decision`;

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

	const initialTask = `You have received a design briefing via ClickUp ticket ${ticketId}: "${ticketName}"
Ticket URL: ${ticketUrl}

## Steps

1. FIRST: Move the ticket to "in progress" using mcp__clickup__clickup_update_task (task_id: "${ticketId}", status: "in progress")
2. Read the full ticket with mcp__clickup__clickup_get_task (task_id: "${ticketId}")
3. Read the ticket's comments with mcp__clickup__clickup_get_task_comments (task_id: "${ticketId}") for additional context
4. Assess the briefing: Is it clear enough to start design work? Does it have user needs, constraints, and goals?

### If NOT complete (needs more info):
- Comment on the ticket with specific questions using mcp__clickup__clickup_create_task_comment
- Move the ticket back to "to do" using mcp__clickup__clickup_update_task (status: "to do")

### If complete — Start Phase 1 (UX Exploration):

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
Use the workspace path of the PROJECT being designed (e.g. ~/Projects/brightmind), NOT the kantoor-workspace.

5. Update your memory file with your decisions`;

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
10. Update MemPalace with your design directions and reasoning
11. Update your memory file`;

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

	// Check if any designer is already running (only one at a time to avoid Figma conflicts)
	const activeDesigner = persistentAgents.find(
		p => p.roleShort === DESIGNER_ROLE_SHORT && p.currentSessionId,
	);
	if (activeDesigner) {
		return { success: false, error: `Designer "${activeDesigner.name}" is already running. Wait for it to finish before launching another. Check ClickUp ticket status to know when it's done.` };
	}

	// Resolve project description
	const knownProjects = loadKnownProjects();
	const projName = path.basename(workspacePath);
	const project = knownProjects.find(k => k.name === projName);
	const projectDescription = project?.description;

	// Find an idle designer for this workspace, or create one
	let designer = persistentAgents.find(
		p => p.roleShort === DESIGNER_ROLE_SHORT
			&& p.workspacePath === workspacePath
			&& !p.currentSessionId,
	);

	if (!designer) {
		designer = {
			id: generateAgentId(),
			name: pickRandomName(persistentAgents),
			roleShort: DESIGNER_ROLE_SHORT,
			roleFull: 'UX/UI Designer. Reads design briefings from ClickUp, creates designs in Figma on playground boards, and delivers diverse creative explorations.',
			workspacePath,
		};
		persistentAgents.push(designer);
	}

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
9. Update your memory file with what you designed and key decisions`;

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

// ── Auto-revision pickup ────────────────────────────────────

export function autoDesignerRevisionPickup(ctx: ServerContext): void {
	if (ctx.isWorkerMode) return;

	// Check if any designer is already running
	const activeDesigner = ctx.persistentAgents.find(
		p => p.roleShort === DESIGNER_ROLE_SHORT && p.currentSessionId,
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

	// Find the designer who previously worked on this ticket
	const previousDesigner = ctx.persistentAgents.find(
		p => p.roleShort === DESIGNER_ROLE_SHORT
			&& !p.currentSessionId
			&& p.lastTicketId === ticket.id,
	);

	if (!previousDesigner) {
		console.log(`[Standalone] No idle designer found for revision ticket ${ticket.id}`);
		return;
	}

	console.log(`[Standalone] Auto-revision: relaunching designer "${previousDesigner.name}" for ticket ${ticket.id}`);
	handleLaunchDesigner(
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
