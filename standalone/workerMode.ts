import * as os from 'os';
import * as fs from 'fs';
import { WebSocket } from 'ws';
import {
	loadPersistentAgents,
	savePersistentAgents,
	getAgentMemoryPath,
	ensureAgentMemory,
	collapseHome,
} from './agentStore.js';
import type { PersistentAgent } from './agentStore.js';
import type { ClickUpConfig } from './clickupClient.js';
import { WORKER_HEARTBEAT_INTERVAL_MS, WORKER_RECONNECT_INTERVAL_MS, DEFAULT_WORKER_ROLES } from './constants.js';
import {
	handleDarrylHandleTicket,
	handleLaunchDesigner,
	handleLaunchVisualDesigner,
	handleLaunchPM,
} from './clickupHandlers.js';
import type { ServerContext } from './serverContext.js';

let hubWs: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function startWorkerMode(
	hubUrl: string,
	name: string,
	color: string,
	ctx: ServerContext,
	roles: string[] = [...DEFAULT_WORKER_ROLES],
): void {
	function connect(): void {
		const wsUrl = hubUrl.replace(/^http/, 'ws') + '/ws';
		console.log(`[Worker] Connecting to hub at ${wsUrl}...`);
		console.log(`[Worker] WebSocket class available: ${typeof WebSocket}, constructor: ${WebSocket?.name || 'unknown'}`);

		const ws = new WebSocket(wsUrl);

		ws.on('open', () => {
			console.log(`[Worker] Connected to hub`);
			hubWs = ws;
			ctx.hubWs = ws;

			// Register with hub
			ws.send(JSON.stringify({
				type: 'workerRegister',
				name,
				color,
				hostname: os.hostname(),
				roles,
			}));

			// Start heartbeat
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: 'workerHeartbeat' }));
				}
			}, WORKER_HEARTBEAT_INTERVAL_MS);
		});

		ws.on('message', (raw) => {
			try {
				const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
				handleHubMessage(ws, msg, ctx);
			} catch { /* ignore malformed */ }
		});

		ws.on('close', () => {
			console.log(`[Worker] Disconnected from hub, will reconnect...`);
			hubWs = null;
			ctx.hubWs = null;
			if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
			scheduleReconnect(hubUrl, name, color, ctx, roles);
		});

		ws.on('error', (err) => {
			console.error(`[Worker] WebSocket error:`, err.message);
			// close event will fire after this, triggering reconnect
		});
	}

	connect();
}

function scheduleReconnect(hubUrl: string, name: string, color: string, ctx: ServerContext, roles: string[]): void {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(() => {
		startWorkerMode(hubUrl, name, color, ctx, roles);
	}, WORKER_RECONNECT_INTERVAL_MS);
}

function handleHubMessage(
	ws: WebSocket,
	msg: Record<string, unknown>,
	ctx: ServerContext,
): void {
	const type = msg.type as string;

	if (type === 'workerRegistered') {
		handleRegistered(msg, ctx);
	} else if (type === 'handleTicket') {
		handleTicketFromHub(ws, msg, ctx);
	} else if (type === 'launchDesigner' || type === 'launchVisualDesigner' || type === 'launchPM') {
		handleLaunchRpcFromHub(ws, type, msg, ctx).catch(err => {
			console.error(`[Worker] ${type} RPC error:`, err);
			const requestId = msg.requestId as string | undefined;
			if (requestId && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: 'workerResponse', requestId, success: false, error: String(err) }));
			}
		});
	} else if (type === 'workerError') {
		console.error(`[Worker] Hub error: ${msg.error}`);
	}
}

// ── Launch RPC: hub asks us to start a designer / visual designer / PM ─────

async function handleLaunchRpcFromHub(
	ws: WebSocket,
	rpcType: 'launchDesigner' | 'launchVisualDesigner' | 'launchPM',
	msg: Record<string, unknown>,
	ctx: ServerContext,
): Promise<void> {
	const requestId = msg.requestId as string | undefined;
	const payload = (msg.payload as Record<string, unknown>) ?? {};

	// If the hub shipped agent memories alongside the launch, write them first so
	// the designer we're about to spawn has up-to-date context.
	const agentMemories = payload.agentMemories as Record<string, string> | undefined;
	if (agentMemories) {
		for (const [agentId, content] of Object.entries(agentMemories)) {
			ensureAgentMemory(agentId);
			fs.writeFileSync(getAgentMemoryPath(agentId), content, 'utf-8');
		}
		ctx.persistentAgents = loadPersistentAgents();
	}

	// Strip memories before forwarding — the inner handlers don't expect them
	const launchMsg: Record<string, unknown> = { ...payload };
	delete launchMsg.agentMemories;

	let result: { success: boolean; error?: string; worker?: string };
	if (rpcType === 'launchDesigner') {
		result = await handleLaunchDesigner(launchMsg, ctx);
	} else if (rpcType === 'launchVisualDesigner') {
		result = await handleLaunchVisualDesigner(launchMsg, ctx);
	} else {
		result = handleLaunchPM(launchMsg, ctx);
	}

	console.log(`[Worker] ${rpcType} result: success=${result.success}${result.error ? ` error="${result.error}"` : ''}`);

	if (requestId && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({
			type: 'workerResponse',
			requestId,
			success: result.success,
			error: result.error,
			workerName: ctx.workerIdentity?.name,
		}));
	}
}

// ── Session-end reporter: tell the hub when a designer/QA finishes here ───

/** Called from server.ts onSessionStale when a design-role agent session ends on this worker. */
export function reportDesignerSessionEndedToHub(
	payload: {
		agentRole: string;
		ticketId: string;
		ticketName: string;
		ticketUrl: string;
		designerName: string;
		workspacePath: string;
		updatedMemory?: string;
		agentId?: string;
	},
	ctx: ServerContext,
): void {
	if (!ctx.hubWs || ctx.hubWs.readyState !== WebSocket.OPEN) return;
	try {
		ctx.hubWs.send(JSON.stringify({ type: 'designerSessionEnded', ...payload }));
	} catch (err) {
		console.error(`[Worker] Failed to report session end to hub:`, err);
	}
}

// ── Registration response ───────────────────────────────────

function handleRegistered(msg: Record<string, unknown>, ctx: ServerContext): void {
	const hubAgents = msg.agents as PersistentAgent[] | undefined;
	const clickupConfig = msg.clickupConfig as ClickUpConfig | null | undefined;
	const mempalaceServerUrl = msg.mempalaceServerUrl as string | undefined;

	// Merge agents: hub wins on conflicts, keep local-only agents
	if (hubAgents) {
		mergeAgents(hubAgents);
	}

	// Store clickup config so local Darryl sessions can use it
	if (clickupConfig) {
		ctx.clickupConfig = clickupConfig;
	}

	// Store mempalace server URL so worker agents can connect to hub's mempalace
	if (mempalaceServerUrl) {
		ctx.mempalaceServerUrl = mempalaceServerUrl;
	}

	console.log(`[Worker] Registered with hub. Received ${hubAgents?.length ?? 0} agents, mempalace: ${mempalaceServerUrl ?? 'none'}.`);
}

// ── Agent merge logic ───────────────────────────────────────

function mergeAgents(hubAgents: PersistentAgent[]): void {
	const localAgents = loadPersistentAgents();
	const hubIdSet = new Set(hubAgents.map(a => a.id));

	// Normalize workspace paths from hub (collapse absolute paths to ~/...)
	// Also strip currentSessionId — hub sessions run on the hub, not on this worker.
	// Workers retain agent memory via MEMORY.md files but always start fresh sessions.
	for (const agent of hubAgents) {
		if (agent.workspacePath) {
			agent.workspacePath = collapseHome(agent.workspacePath);
		}
		delete agent.currentSessionId;
	}

	// Start with all hub agents
	const merged: PersistentAgent[] = [...hubAgents];

	// Add local-only agents (not known to hub)
	for (const local of localAgents) {
		if (!hubIdSet.has(local.id)) {
			merged.push(local);
		}
	}

	savePersistentAgents(merged);
	console.log(`[Worker] Merged agents: ${hubAgents.length} from hub + ${merged.length - hubAgents.length} local-only = ${merged.length} total`);
}

// ── Handle ticket from hub ──────────────────────────────────

function handleTicketFromHub(
	ws: WebSocket,
	msg: Record<string, unknown>,
	ctx: ServerContext,
): void {
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const ticketStatus = msg.ticketStatus as string | undefined;

	// Write agent memories from hub to local filesystem
	const agentMemories = msg.agentMemories as Record<string, string> | undefined;
	if (agentMemories) {
		for (const [agentId, content] of Object.entries(agentMemories)) {
			ensureAgentMemory(agentId);
			const memPath = getAgentMemoryPath(agentId);
			fs.writeFileSync(memPath, content, 'utf-8');
		}
		console.log(`[Worker] Wrote ${Object.keys(agentMemories).length} agent memory files from hub`);
	}

	// Reload agents from disk (may have been updated by merge)
	ctx.persistentAgents = loadPersistentAgents();

	// Clear any stale currentSessionId values — on a worker, sessions are local.
	// If no local process is running for a session, clear it so agents can be launched fresh.
	let cleared = false;
	for (const pa of ctx.persistentAgents) {
		if (pa.currentSessionId) {
			pa.currentSessionId = undefined;
			cleared = true;
		}
	}
	if (cleared) {
		savePersistentAgents(ctx.persistentAgents);
		console.log(`[Worker] Cleared stale session IDs from persistent agents`);
	}

	console.log(`[Worker] Received ticket ${ticketId}: "${ticketName}"`);

	// Tell hub we started
	ws.send(JSON.stringify({ type: 'ticketStarted', ticketId, ticketName }));

	// Run the Darryl flow locally — same as hub does
	handleDarrylHandleTicket(
		{ ticketId, ticketName, ticketUrl, ticketStatus },
		ctx,
	);

	// Watch for Darryl's session to end, then report back
	watchForCompletion(ws, ticketId, ctx);
}

// ── Watch for Darryl session completion ─────────────────────

function watchForCompletion(ws: WebSocket, ticketId: string, ctx: ServerContext): void {
	const checkInterval = setInterval(() => {
		const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
		if (darryl && !darryl.currentSessionId) {
			// Darryl finished — collect updated memories and report
			clearInterval(checkInterval);

			const updatedMemories = collectLocalMemories(ctx.persistentAgents);

			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({
					type: 'ticketComplete',
					ticketId,
					updatedMemories,
				}));
			}
			console.log(`[Worker] Ticket ${ticketId} completed, reported to hub`);
		}
	}, 5000); // Check every 5s
}

function collectLocalMemories(agents: PersistentAgent[]): Record<string, string> {
	const memories: Record<string, string> = {};
	for (const agent of agents) {
		const memPath = getAgentMemoryPath(agent.id);
		try {
			if (fs.existsSync(memPath)) {
				memories[agent.id] = fs.readFileSync(memPath, 'utf-8');
			}
		} catch { /* skip */ }
	}
	return memories;
}

export function stopWorkerMode(): void {
	if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
	if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
	if (hubWs) {
		try { hubWs.close(); } catch { /* ignore */ }
		hubWs = null;
	}
}
