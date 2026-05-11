import * as os from 'os';
import * as crypto from 'crypto';
import type { WebSocket } from 'ws';
import {
	WORKER_HEARTBEAT_TIMEOUT_MS,
	MEMPALACE_SERVER_PORT,
	WORKER_DISPATCH_TIMEOUT_MS,
	DEFAULT_WORKER_ROLES,
} from './constants.js';
import type { ServerContext, WorkerInfo, WorkerAssignment } from './serverContext.js';
import { loadPersistentAgents, collapseHome } from './agentStore.js';
import { releaseTicket } from './dispatchRegistry.js';
import { loadWorkerAssignments, saveWorkerAssignments } from '../src/db/workerAssignmentStore.js';

// ── Assignment persistence (delegates to DB-backed store) ───

export function loadAssignments(): WorkerAssignment[] {
	return loadWorkerAssignments();
}

export function saveAssignments(assignments: WorkerAssignment[]): void {
	saveWorkerAssignments(assignments);
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
	const rawRoles = msg.roles;
	const roles: string[] = Array.isArray(rawRoles) && rawRoles.every(r => typeof r === 'string')
		? (rawRoles as string[])
		: [...DEFAULT_WORKER_ROLES];

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
		roles,
	};
	ctx.workers.set(name, worker);

	console.log(`[Hub] Worker registered: "${name}" (${hostname}) roles=[${roles.join(',')}]`);

	// Send registration response with agents and clickup config. Collapse
	// workspace paths using the HUB's home dir before shipping — otherwise an
	// absolute hub path like "/Users/<hubUser>/Projects/foo" arrives at a
	// worker with a different home dir, the worker's collapseHome can't
	// touch it, and downstream samePath comparisons against "~/Projects/foo"
	// (expanded with the worker's home) silently fail. Collapsing here means
	// the worker always sees "~/Projects/foo".
	const agents = loadPersistentAgents().map(a => ({
		...a,
		workspacePath: a.workspacePath ? collapseHome(a.workspacePath) : a.workspacePath,
	}));
	// Derive the hub's reachable address from the WebSocket's local address
	// (the IP the worker actually connected to), falling back to os.hostname()
	const socket = (ws as unknown as { _socket?: { localAddress?: string } })._socket;
	let localAddr = socket?.localAddress;
	// Strip IPv4-mapped IPv6 prefix (e.g. "::ffff:192.168.1.10" → "192.168.1.10")
	if (localAddr?.startsWith('::ffff:')) {
		localAddr = localAddr.slice(7);
	}
	let hubHost = (localAddr && localAddr !== '::' && localAddr !== '0.0.0.0')
		? localAddr
		: os.hostname();
	// Wrap bare IPv6 addresses in brackets for valid URL construction
	if (hubHost.includes(':')) {
		hubHost = `[${hubHost}]`;
	}
	ws.send(JSON.stringify({
		type: 'workerRegistered',
		agents,
		clickupConfig: ctx.clickupConfig,
		mempalaceServerUrl: `http://${hubHost}:${MEMPALACE_SERVER_PORT}/sse`,
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
			// If worker was working on a ticket, mark it as failed and release
			// the claim so another machine can retry.
			if (worker.currentTicketId) {
				markAssignment(ctx, worker.currentTicketId, 'failed');
				releaseTicket(ctx.dispatchRegistry, worker.currentTicketId);
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
				releaseTicket(ctx.dispatchRegistry, worker.currentTicketId);
			}
			ctx.workers.delete(name);
			broadcastWorkerStatus(ctx);
			return;
		}
	}
}

// ── Request/response correlation ────────────────────────────
// Hub → Worker RPC pattern: send a message with `requestId`, the worker
// calls back with `{ type: 'workerResponse', requestId, success, error }`.
// Used to await whether a remote worker actually started a designer/PM.

export function sendWorkerRequest(
	ctx: ServerContext,
	worker: WorkerInfo,
	message: Record<string, unknown>,
	timeoutMs: number = WORKER_DISPATCH_TIMEOUT_MS,
): Promise<{ success: boolean; error?: string; workerName?: string }> {
	return new Promise((resolve) => {
		if (worker.ws.readyState !== worker.ws.OPEN) {
			resolve({ success: false, error: `Worker "${worker.name}" WS not open`, workerName: worker.name });
			return;
		}
		const requestId = crypto.randomUUID();
		const timer = setTimeout(() => {
			const pending = ctx.pendingWorkerRequests.get(requestId);
			if (pending) {
				ctx.pendingWorkerRequests.delete(requestId);
				resolve({ success: false, error: `Worker "${worker.name}" did not respond within ${timeoutMs}ms`, workerName: worker.name });
			}
		}, timeoutMs);
		ctx.pendingWorkerRequests.set(requestId, { resolve, timer, workerName: worker.name });
		try {
			worker.ws.send(JSON.stringify({ ...message, requestId }));
		} catch (err) {
			clearTimeout(timer);
			ctx.pendingWorkerRequests.delete(requestId);
			resolve({ success: false, error: `Failed to send to worker "${worker.name}": ${String(err)}`, workerName: worker.name });
		}
	});
}

export function handleWorkerResponse(
	ws: WebSocket,
	msg: Record<string, unknown>,
	ctx: ServerContext,
): void {
	const requestId = msg.requestId as string | undefined;
	if (!requestId) return;
	const pending = ctx.pendingWorkerRequests.get(requestId);
	if (!pending) return;
	ctx.pendingWorkerRequests.delete(requestId);
	clearTimeout(pending.timer);
	// Confirm the response came from the expected worker's WS
	let sourceName: string | undefined;
	for (const worker of ctx.workers.values()) {
		if (worker.ws === ws) { sourceName = worker.name; break; }
	}
	pending.resolve({
		success: !!msg.success,
		error: msg.error as string | undefined,
		workerName: sourceName ?? pending.workerName,
	});
}

// ── Role filters ────────────────────────────────────────────

export function getIdleWorkersWithRole(ctx: ServerContext, role: string): WorkerInfo[] {
	const result: WorkerInfo[] = [];
	for (const worker of ctx.workers.values()) {
		if (worker.currentTicketId) continue;
		if (!worker.roles || worker.roles.length === 0 || worker.roles.includes(role)) {
			result.push(worker);
		}
	}
	return result;
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

	// Update worker state
	for (const worker of ctx.workers.values()) {
		if (worker.ws === ws) {
			console.log(`[Hub] Worker "${worker.name}" completed ticket ${ticketId}`);
			worker.currentTicketId = null;
			worker.currentTicketName = null;
			markAssignment(ctx, ticketId, 'completed');
			releaseTicket(ctx.dispatchRegistry, ticketId);
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
			releaseTicket(ctx.dispatchRegistry, ticketId);
			broadcastWorkerStatus(ctx);
			return;
		}
	}
}

// ── Remote designer session-end hook ────────────────────────
// A worker tells us one of its designer/QA sessions ended. We clear any
// ticket tracking and let the caller (clickupHandlers) trigger the
// appropriate next step (Jan review / Visual QA / revision pickup).

export function clearWorkerTicket(ws: WebSocket, ctx: ServerContext): string | null {
	for (const worker of ctx.workers.values()) {
		if (worker.ws === ws) {
			const previous = worker.currentTicketId;
			worker.currentTicketId = null;
			worker.currentTicketName = null;
			if (previous) releaseTicket(ctx.dispatchRegistry, previous);
			broadcastWorkerStatus(ctx);
			return previous;
		}
	}
	return null;
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
			roles: ctx.workerIdentity.roles ?? [...DEFAULT_WORKER_ROLES],
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
			roles: worker.roles,
			isHub: false,
		});
	}

	ctx.broadcastSink.postMessage({ type: 'workerStatus', workers });
}

// ── Capacity ────────────────────────────────────────────────

function hubHasRole(ctx: ServerContext, role: string): boolean {
	const hubRoles = ctx.workerIdentity?.roles ?? [...DEFAULT_WORKER_ROLES];
	return hubRoles.includes(role);
}

/** Get the number of available dev worker slots (hub + remote workers with 'dev' role that are idle) */
export function getAvailableCapacity(ctx: ServerContext, role = 'dev'): number {
	let capacity = 0;

	// Hub is available if it advertises the role and Darryl isn't currently running
	if (hubHasRole(ctx, role)) {
		const darryl = ctx.persistentAgents.find(p => p.name === 'Darryl');
		if (!darryl?.currentSessionId) {
			capacity++;
		}
	}

	// Remote workers that advertise the role and are idle
	for (const worker of ctx.workers.values()) {
		if (worker.currentTicketId) continue;
		if (!worker.roles || worker.roles.includes(role)) {
			capacity++;
		}
	}

	return capacity;
}

/** Get idle remote workers that advertise the given role (default: 'dev') */
export function getIdleWorkers(ctx: ServerContext, role = 'dev'): WorkerInfo[] {
	const idle: WorkerInfo[] = [];
	for (const worker of ctx.workers.values()) {
		if (worker.currentTicketId) continue;
		if (!worker.roles || worker.roles.includes(role)) {
			idle.push(worker);
		}
	}
	return idle;
}
