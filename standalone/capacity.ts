/**
 * Fleet capacity accounting for the Visual Design pipeline.
 *
 * Every machine (hub or remote worker) with the 'designer' role can run at
 * most ONE visual task at a time — Visual Designer, UX Designer, or Visual
 * QA. The Figma lock enforces this per-machine. This module computes the
 * aggregate view used by Jan's batch pickup.
 */

import {
	DESIGNER_ROLE_SHORT,
	VISUAL_DESIGNER_ROLE_SHORT,
	VISUAL_QA_ROLE_SHORT,
	WORKER_ROLE_DESIGNER,
	DEFAULT_WORKER_ROLES,
} from './constants.js';
import type { PersistentAgent } from './agentStore.js';
import type { ServerContext } from './serverContext.js';

/**
 * Find the agent currently holding the Figma lock on THIS machine, if any.
 * The lock covers every role that touches the local Figma instance — UX
 * Designer, Visual Designer, and Visual Quality Reviewer — since they all
 * share the single Figma app.
 */
export function findFigmaLockHolder(persistentAgents: PersistentAgent[]): PersistentAgent | undefined {
	return persistentAgents.find(
		p => (p.roleShort === DESIGNER_ROLE_SHORT
			|| p.roleShort === VISUAL_DESIGNER_ROLE_SHORT
			|| p.roleShort === VISUAL_QA_ROLE_SHORT)
			&& p.currentSessionId,
	);
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
