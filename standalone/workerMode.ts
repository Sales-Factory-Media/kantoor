import * as os from 'os';
import * as fs from 'fs';
import { WebSocket } from 'ws';
import {
	loadPersistentAgents,
	savePersistentAgents,
	getAgentMemoryPath,
	ensureAgentMemory,
} from './agentStore.js';
import type { PersistentAgent } from './agentStore.js';
import type { ClickUpConfig } from './clickupClient.js';
import { WORKER_HEARTBEAT_INTERVAL_MS, WORKER_RECONNECT_INTERVAL_MS } from './constants.js';
import { handleDarrylHandleTicket } from './clickupHandlers.js';
import type { ServerContext } from './serverContext.js';

let hubWs: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function startWorkerMode(
	hubUrl: string,
	name: string,
	color: string,
	ctx: ServerContext,
): void {
	function connect(): void {
		const wsUrl = hubUrl.replace(/^http/, 'ws') + '/ws';
		console.log(`[Worker] Connecting to hub at ${wsUrl}...`);
		console.log(`[Worker] WebSocket class available: ${typeof WebSocket}, constructor: ${WebSocket?.name || 'unknown'}`);

		const ws = new WebSocket(wsUrl);

		ws.on('open', () => {
			console.log(`[Worker] Connected to hub`);
			hubWs = ws;

			// Register with hub
			ws.send(JSON.stringify({
				type: 'workerRegister',
				name,
				color,
				hostname: os.hostname(),
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
			if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
			scheduleReconnect(hubUrl, name, color, ctx);
		});

		ws.on('error', (err) => {
			console.error(`[Worker] WebSocket error:`, err.message);
			// close event will fire after this, triggering reconnect
		});
	}

	connect();
}

function scheduleReconnect(hubUrl: string, name: string, color: string, ctx: ServerContext): void {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(() => {
		startWorkerMode(hubUrl, name, color, ctx);
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
	} else if (type === 'workerError') {
		console.error(`[Worker] Hub error: ${msg.error}`);
	}
}

// ── Registration response ───────────────────────────────────

function handleRegistered(msg: Record<string, unknown>, ctx: ServerContext): void {
	const hubAgents = msg.agents as PersistentAgent[] | undefined;
	const clickupConfig = msg.clickupConfig as ClickUpConfig | null | undefined;

	// Merge agents: hub wins on conflicts, keep local-only agents
	if (hubAgents) {
		mergeAgents(hubAgents);
	}

	// Store clickup config so local Darryl sessions can use it
	if (clickupConfig) {
		ctx.clickupConfig = clickupConfig;
	}

	console.log(`[Worker] Registered with hub. Received ${hubAgents?.length ?? 0} agents.`);
}

// ── Agent merge logic ───────────────────────────────────────

function mergeAgents(hubAgents: PersistentAgent[]): void {
	const localAgents = loadPersistentAgents();
	const hubIdSet = new Set(hubAgents.map(a => a.id));

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

	console.log(`[Worker] Received ticket ${ticketId}: "${ticketName}"`);

	// Tell hub we started
	ws.send(JSON.stringify({ type: 'ticketStarted', ticketId, ticketName }));

	// Run the Darryl flow locally — same as hub does
	handleDarrylHandleTicket(
		{ ticketId, ticketName, ticketUrl },
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
