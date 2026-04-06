import * as fs from 'fs';
import type { WebSocket } from 'ws';
import { WORKER_HEARTBEAT_TIMEOUT_MS } from './constants.js';
import { WORKER_ASSIGNMENTS_FILE, SETTINGS_DIR } from './serverContext.js';
import type { ServerContext, WorkerInfo, WorkerAssignment } from './serverContext.js';
import { loadPersistentAgents, getAgentMemoryPath, ensureAgentMemory } from './agentStore.js';
import type { PersistentAgent } from './agentStore.js';

// ── Assignment persistence ──────────────────────────────────

export function loadAssignments(): WorkerAssignment[] {
	try {
		if (!fs.existsSync(WORKER_ASSIGNMENTS_FILE)) return [];
		return JSON.parse(fs.readFileSync(WORKER_ASSIGNMENTS_FILE, 'utf-8')) as WorkerAssignment[];
	} catch { return []; }
}

export function saveAssignments(assignments: WorkerAssignment[]): void {
	if (!fs.existsSync(SETTINGS_DIR)) {
		fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
	}
	fs.writeFileSync(WORKER_ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

// ── Worker registration ─────────────────────────────────────

export function registerWorker(
	ws: WebSocket,
	msg: Record<string, unknown>,
	ctx: ServerContext,
): void {
	const name = msg.name as string;
	const color = msg.color as string;
	const hostname = msg.hostname as string;

	if (!name || !color || !hostname) {
		ws.send(JSON.stringify({ type: 'workerError', error: 'Missing name, color, or hostname' }));
		return;
	}

	// Remove existing worker with same name if reconnecting
	const existing = ctx.workers.get(name);
	if (existing && existing.ws !== ws) {
		try { existing.ws.close(); } catch { /* ignore */ }
	}

	const worker: WorkerInfo = {
		name,
		color,
		hostname,
		ws,
		lastHeartbeat: Date.now(),
		currentTicketId: null,
		currentTicketName: null,
	};
	ctx.workers.set(name, worker);

	console.log(`[Hub] Worker registered: "${name}" (${hostname})`);

	// Send registration response with agents and clickup config
	const agents = loadPersistentAgents();
	ws.send(JSON.stringify({
		type: 'workerRegistered',
		agents,
		clickupConfig: ctx.clickupConfig,
	}));

	broadcastWorkerStatus(ctx);
}

// ── Worker heartbeat ────────────────────────────────────────

export function handleWorkerHeartbeat(ws: WebSocket, ctx: ServerContext): void {
	for (const worker of ctx.workers.values()) {
		if (worker.ws === ws) {
			worker.lastHeartbeat = Date.now();
			return;
		}
	}
}

export function checkWorkerHeartbeats(ctx: ServerContext): void {
	const now = Date.now();
	const stale: string[] = [];
	for (const [name, worker] of ctx.workers) {
		if (now - worker.lastHeartbeat > WORKER_HEARTBEAT_TIMEOUT_MS) {
			stale.push(name);
		}
	}
	for (const name of stale) {
		console.log(`[Hub] Worker "${name}" timed out, removing`);
		const worker = ctx.workers.get(name);
		if (worker) {
			try { worker.ws.close(); } catch { /* ignore */ }
			// If worker was working on a ticket, mark it as failed
			if (worker.currentTicketId) {
				markAssignment(ctx, worker.currentTicketId, 'failed');
			}
		}
		ctx.workers.delete(name);
	}
	if (stale.length > 0) {
		broadcastWorkerStatus(ctx);
	}
}

// ── Worker disconnect ───────────────────────────────────────

export function handleWorkerDisconnect(ws: WebSocket, ctx: ServerContext): void {
	for (const [name, worker] of ctx.workers) {
		if (worker.ws === ws) {
			console.log(`[Hub] Worker "${name}" disconnected`);
			if (worker.currentTicketId) {
				markAssignment(ctx, worker.currentTicketId, 'failed');
			}
			ctx.workers.delete(name);
			broadcastWorkerStatus(ctx);
			return;
		}
	}
}

// ── Ticket completion from worker ───────────────────────────

export function handleTicketStarted(
	ws: WebSocket,
	msg: Record<string, unknown>,
	ctx: ServerContext,
): void {
	const ticketId = msg.ticketId as string;
	for (const worker of ctx.workers.values()) {
		if (worker.ws === ws) {
			worker.currentTicketId = ticketId;
			worker.currentTicketName = msg.ticketName as string || ticketId;
			broadcastWorkerStatus(ctx);
			return;
		}
	}
}

export function handleTicketComplete(
	ws: WebSocket,
	msg: Record<string, unknown>,
	ctx: ServerContext,
): void {
	const ticketId = msg.ticketId as string;

	// Save updated memories back to hub
	const updatedMemories = msg.updatedMemories as Record<string, string> | undefined;
	if (updatedMemories) {
		saveUpdatedMemories(updatedMemories);
	}

	// Update worker state
	for (const worker of ctx.workers.values()) {
		if (worker.ws === ws) {
			console.log(`[Hub] Worker "${worker.name}" completed ticket ${ticketId}`);
			worker.currentTicketId = null;
			worker.currentTicketName = null;
			markAssignment(ctx, ticketId, 'completed');
			broadcastWorkerStatus(ctx);
			return;
		}
	}
}

export function handleTicketFailed(
	ws: WebSocket,
	msg: Record<string, unknown>,
	ctx: ServerContext,
): void {
	const ticketId = msg.ticketId as string;
	const error = msg.error as string | undefined;

	for (const worker of ctx.workers.values()) {
		if (worker.ws === ws) {
			console.error(`[Hub] Worker "${worker.name}" failed ticket ${ticketId}: ${error || 'unknown'}`);
			worker.currentTicketId = null;
			worker.currentTicketName = null;
			markAssignment(ctx, ticketId, 'failed');
			broadcastWorkerStatus(ctx);
			return;
		}
	}
}

// ── Assignment tracking ─────────────────────────────────────

export function addAssignment(ctx: ServerContext, ticketId: string, ticketName: string, workerName: string, workerHost: string): void {
	const assignment: WorkerAssignment = {
		ticketId,
		ticketName,
		worker: workerName,
		workerHost,
		startedAt: new Date().toISOString(),
		status: 'in_progress',
	};
	ctx.workerAssignments.push(assignment);
	saveAssignments(ctx.workerAssignments);
}

function markAssignment(ctx: ServerContext, ticketId: string, status: 'completed' | 'failed'): void {
	const assignment = ctx.workerAssignments.find(a => a.ticketId === ticketId && a.status === 'in_progress');
	if (assignment) {
		assignment.status = status;
		saveAssignments(ctx.workerAssignments);
	}
}

// ── Memory sync ─────────────────────────────────────────────

function saveUpdatedMemories(memories: Record<string, string>): void {
	for (const [agentId, content] of Object.entries(memories)) {
		ensureAgentMemory(agentId);
		const memPath = getAgentMemoryPath(agentId);
		fs.writeFileSync(memPath, content, 'utf-8');
		console.log(`[Hub] Updated memory for agent ${agentId}`);
	}
}

/** Collect memory content for all agents that might be needed */
export function collectAgentMemories(agents: PersistentAgent[]): Record<string, string> {
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

// ── Broadcast ───────────────────────────────────────────────

export function broadcastWorkerStatus(ctx: ServerContext): void {
	const workers = [];

	// Hub itself is always worker #1
	if (ctx.workerIdentity) {
		// Find if hub is working on a ticket (check Darryl's currentSessionId)
		const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
		const hubBusy = !!darryl?.currentSessionId;
		// Find the ticket the hub is working on from assignments
		const hubAssignment = ctx.workerAssignments.find(
			a => a.worker === ctx.workerIdentity!.name && a.status === 'in_progress',
		);

		workers.push({
			name: ctx.workerIdentity.name,
			color: ctx.workerIdentity.color,
			hostname: 'localhost',
			status: hubAssignment ? 'busy' : (hubBusy ? 'busy' : 'idle'),
			ticketId: hubAssignment?.ticketId ?? null,
			ticketName: hubAssignment?.ticketName ?? null,
			isHub: true,
		});
	}

	// Remote workers
	for (const worker of ctx.workers.values()) {
		workers.push({
			name: worker.name,
			color: worker.color,
			hostname: worker.hostname,
			status: worker.currentTicketId ? 'busy' : 'idle',
			ticketId: worker.currentTicketId,
			ticketName: worker.currentTicketName,
			isHub: false,
		});
	}

	ctx.broadcastSink.postMessage({ type: 'workerStatus', workers });
}

// ── Capacity ────────────────────────────────────────────────

/** Get the number of available worker slots (hub + remote workers that are idle) */
export function getAvailableCapacity(ctx: ServerContext): number {
	let capacity = 0;

	// Hub is available if Darryl isn't currently running
	const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
	if (!darryl?.currentSessionId) {
		capacity++;
	}

	// Remote workers that are idle
	for (const worker of ctx.workers.values()) {
		if (!worker.currentTicketId) {
			capacity++;
		}
	}

	return capacity;
}

/** Get idle remote workers */
export function getIdleWorkers(ctx: ServerContext): WorkerInfo[] {
	const idle: WorkerInfo[] = [];
	for (const worker of ctx.workers.values()) {
		if (!worker.currentTicketId) {
			idle.push(worker);
		}
	}
	return idle;
}
