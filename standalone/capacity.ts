/**
 * Fleet capacity accounting for the Visual Design pipeline.
 *
 * Every machine (hub or remote worker) with the 'designer' role can run at
 * most ONE visual task at a time — Visual Designer, UX Designer, or Visual
 * QA. The per-machine "visual slot" lock enforces this (see
 * findBusyVisualSlot). This module computes the aggregate view used by Jan's
 * batch pickup.
 */

import {
	DESIGNER_ROLE_SHORT,
	VISUAL_DESIGNER_ROLE_SHORT,
	VISUAL_QA_ROLE_SHORT,
	WORKER_ROLE_DESIGNER,
	WORKER_ROLE_DEV,
	DEFAULT_WORKER_ROLES,
	DARRYL_ROLE_SHORT,
	JAN_ROLE_SHORT,
	PM_ROLE_SHORT,
	UX_PM_ROLE_SHORT,
	UX_QA_ROLE_SHORT,
	VISUAL_PM_ROLE_SHORT,
} from './constants.js';
import type { PersistentAgent } from './agentStore.js';
import { expandHome } from './agentStore.js';
import type { ServerContext } from './serverContext.js';

/**
 * Compare two workspace paths in a tilde-tolerant way. Persistent-agent
 * records have historically stored workspace paths in either collapsed
 * (`~/Projects/foo`) or expanded (`/Users/.../Projects/foo`) form depending on
 * how the agent was created (CLI vs webview "Hire" form vs older versions).
 * Direct `===` comparison fails when the two sides disagree on which form to
 * use. Always normalize via `expandHome` before comparing.
 */
function samePath(a: string, b: string): boolean {
	return expandHome(a) === expandHome(b);
}

/**
 * Dev workers are the persistent agents Darryl dispatches to. They are
 * distinguished by exclusion: anything that isn't an orchestrator (Darryl /
 * Jan) and isn't a design-team role. User-defined custom roles count as dev
 * workers by default.
 */
const NON_DEV_ROLES = new Set<string>([
	DARRYL_ROLE_SHORT,
	JAN_ROLE_SHORT,
	DESIGNER_ROLE_SHORT,
	VISUAL_DESIGNER_ROLE_SHORT,
	UX_QA_ROLE_SHORT,
	VISUAL_QA_ROLE_SHORT,
	PM_ROLE_SHORT,
	UX_PM_ROLE_SHORT,
	VISUAL_PM_ROLE_SHORT,
]);

export function isDevWorker(pa: PersistentAgent): boolean {
	if (pa.retired) return false;
	return !NON_DEV_ROLES.has(pa.roleShort);
}

/**
 * Find a free dev worker matching the given workspace path. Atomic — meant to
 * be called inside the dispatch entry point so the hub picks the worker
 * instead of a stale-roster orchestrator. Mirrors the
 * `handleLaunchVisualDesigner` pattern (find first eligible designer).
 */
export function findFreeDevWorker(
	persistentAgents: PersistentAgent[],
	workspacePath: string,
): PersistentAgent | undefined {
	return persistentAgents.find(p =>
		isDevWorker(p)
		&& !p.currentSessionId
		&& samePath(p.workspacePath, workspacePath),
	);
}

/**
 * Find the agent currently occupying THIS machine's visual-task slot, if any.
 * Every visual role (UX Designer, Visual Designer, Visual QA) shares the same
 * slot because they all compete for the local Figma instance and for finite
 * per-machine resources. Returns the blocking agent so callers can report
 * "machine busy because <name> (<role>) is running".
 */
export function findBusyVisualSlot(persistentAgents: PersistentAgent[]): PersistentAgent | undefined {
	return persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT
			|| p.roleShort === VISUAL_DESIGNER_ROLE_SHORT
			|| p.roleShort === VISUAL_QA_ROLE_SHORT)
			&& p.currentSessionId,
	);
}

/**
 * Mirror of `findBusyVisualSlot` for dev work: returns the agent currently
 * occupying THIS machine's dev slot, if any. Used by Darryl's dispatch to
 * cap the hub at one dev ticket at a time and cascade further work to idle
 * remote workers — same shape as Jan's flow.
 */
export function findBusyDevSlot(persistentAgents: PersistentAgent[]): PersistentAgent | undefined {
	return persistentAgents.find(p => isDevWorker(p) && !!p.currentSessionId);
}

/**
 * Total machines in the fleet that can run a visual task: hub (if it
 * advertises the designer role) plus every remote worker with the designer
 * role. Each counts as one machine = one slot.
 */
export function getDesignerMachineCapacity(ctx: ServerContext): number {
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

export interface DesignFleetCapacity {
	/** Total machines in the fleet that can run a visual task. */
	total: number;
	/** Slots currently consumed by active visual work (in-progress + pending-dispatch). */
	active: number;
	/** Slots currently free. */
	available: number;
	/** ClickUp "in progress" tickets counted toward `active`. */
	inProgressCount: number;
	/** Just-dispatched sessions not yet reflected in ClickUp status. */
	pendingDispatches: number;
}

/**
 * Compute available capacity for Jan's batch pickup.
 *
 * Primary signal is the ClickUp "in progress" status on Jan's ticket lineage.
 * We also count any visual-role persistent-agent session or remote-worker
 * assignment that ISN'T already reflected in the in-progress set — this
 * catches the 15–30s window between Jan firing curl and the dispatched
 * agent actually updating ClickUp.
 *
 * @param janTicketIds IDs of every ticket Jan is assigned to, across all statuses
 */
export function computeDesignFleetCapacity(
	ctx: ServerContext,
	janTicketIds: Set<string>,
): DesignFleetCapacity {
	const total = getDesignerMachineCapacity(ctx);

	const inProgressTicketIds = new Set<string>();
	let inProgressCount = 0;
	for (const group of ctx.clickupTickets) {
		if (group.name.toLowerCase() !== 'in progress') continue;
		for (const task of group.tasks) {
			if (janTicketIds.has(task.id) || (task.parent && janTicketIds.has(task.parent))) {
				inProgressTicketIds.add(task.id);
				inProgressCount++;
			}
		}
	}

	let pendingDispatches = 0;
	for (const pa of ctx.persistentAgents) {
		if (!pa.currentSessionId) continue;
		if (pa.roleShort !== DESIGNER_ROLE_SHORT
			&& pa.roleShort !== VISUAL_DESIGNER_ROLE_SHORT
			&& pa.roleShort !== VISUAL_QA_ROLE_SHORT) continue;
		if (pa.currentTicketId && inProgressTicketIds.has(pa.currentTicketId)) continue;
		pendingDispatches++;
	}
	for (const worker of ctx.workers.values()) {
		if (!worker.currentTicketId) continue;
		if (inProgressTicketIds.has(worker.currentTicketId)) continue;
		pendingDispatches++;
	}

	const active = inProgressCount + pendingDispatches;
	return {
		total,
		active,
		available: Math.max(0, total - active),
		inProgressCount,
		pendingDispatches,
	};
}

// ── Dev fleet (Darryl's pickup) ─────────────────────────────

export interface DevFleetCapacity {
	/** Free dev workers that can take a new ticket right now. */
	available: number;
	/** Total dev workers (free + busy) — for log/diagnostic output. */
	total: number;
	/** How many are currently running a session. */
	active: number;
}

/**
 * Compute available dev-worker capacity for Darryl's batch pickup. Mirrors
 * `computeDesignFleetCapacity`: count machines that can run a dev ticket and
 * how many slots are free right now. Used to slice Darryl's batch so we never
 * hand him more tickets than there are free workers — same gate Jan uses on
 * her side.
 *
 * Counts:
 *   - persistent dev workers on the hub (one slot per agent — they share the
 *     hub machine but each runs its own iTerm session sequentially).
 *   - remote workers advertising the 'dev' role (one ticket per worker).
 *
 * Active = persistent agents with a live `currentSessionId` + remote workers
 * holding a `currentTicketId`.
 */
export function computeDevFleetCapacity(ctx: ServerContext): DevFleetCapacity {
	let total = 0;
	let active = 0;

	for (const pa of ctx.persistentAgents) {
		if (!isDevWorker(pa)) continue;
		total++;
		if (pa.currentSessionId) active++;
	}

	for (const worker of ctx.workers.values()) {
		const roles = worker.roles ?? [];
		// Empty roles array = legacy worker, treat as dev-capable.
		if (roles.length !== 0 && !roles.includes(WORKER_ROLE_DEV)) continue;
		total++;
		if (worker.currentTicketId) active++;
	}

	return {
		total,
		active,
		available: Math.max(0, total - active),
	};
}
