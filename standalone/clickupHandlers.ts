import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadKnownProjects } from '../src/projectStore.js';
import { CLICKUP_POLL_INTERVAL_MS, DARRYL_ROLE_SHORT, DARRYL_CLICKUP_USERNAME, DARRYL_ESCALATION_USERNAME, DARRYL_WORKSPACE, SERVER_PORT } from './constants.js';
import { launchAgentSession } from './itermFocus.js';
import {
	savePersistentAgents,
	ensureAgentMemory,
	generateAgentId,
	buildDarrylSystemPrompt,
	expandHome,
} from './agentStore.js';
import type { RosterEntry } from './agentStore.js';
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

	callInTask += '\n\nWhen you are finished with this work, exit your session using the curl command described in your system prompt.';

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
	if (!launchPersistentAgent(pa, persistentAgents, callInTask)) {
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

6. Update your memory file with your decision

After completing your assessment and any actions, exit your session using the curl command described in your system prompt.`;

	// Launch Darryl
	const newSessionId = crypto.randomUUID();
	darryl.currentSessionId = newSessionId;
	savePersistentAgents(persistentAgents);
	ensureAgentMemory(darryl.id);

	const cwd = expandHome(darryl.workspacePath || '~');
	if (!launchAgentSession(newSessionId, cwd, systemPrompt, initialTask, { extraFlags: ['--dangerously-skip-permissions'] })) {
		console.log(`[Standalone] Failed to launch Darryl for ticket ${ticketId}`);
	}
}
