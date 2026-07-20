/**
 * Pure ticket-selection helpers for auto-pickup. No side effects, no network,
 * no launch calls — just filter + sort + bucket ClickUp cache + in-flight
 * registry into "here's what's eligible to dispatch right now".
 *
 * Extracted from autoDarrylPickup / autoJanPickup so the decision logic can
 * be unit-tested against real ClickUp payload shapes without mocking the
 * launch machinery. The auto-pickup functions themselves stay responsible
 * for capacity gating, slot assignment, and actually calling the dispatch
 * handlers.
 */

import type { ClickUpStatusGroup, ClickUpTask } from '../src/connectors/clickupClient.js';

export interface DarrylCandidate {
	id: string;
	name: string;
	url: string;
	status: 'to do' | 'ai review';
}

export interface JanCandidate {
	id: string;
	name: string;
	url: string;
}

export interface JanBuckets {
	refine: JanCandidate[];
	todo: JanCandidate[];
	aiReview: JanCandidate[];
	revision: JanCandidate[];
	/** All ticket IDs Jan is directly assigned to (any status). Exposed so
	 *  callers can reuse it for capacity accounting without re-scanning. */
	janTicketIds: Set<string>;
}

/**
 * Pick Darryl-eligible tickets from a ClickUp snapshot. Filters to
 *   - status in the accepted set (always "to do"; "ai review" if flag is on),
 *   - assignee is the Darryl ClickUp username,
 *   - ticket is NOT in the in-flight set (registry source-of-truth).
 *
 * Sort order with ai-review enabled: ai-review first, then to-do. This lets
 * Darryl drain the quick-to-process review queue before picking up fresh
 * implementation tickets.
 */
export function selectDarrylPickups(
	clickupTickets: ClickUpStatusGroup[],
	inFlight: Set<string>,
	darrylUsername: string,
	aiReviewEnabled: boolean,
): DarrylCandidate[] {
	const out: DarrylCandidate[] = [];
	for (const group of clickupTickets) {
		const statusLower = group.name.toLowerCase();
		const isTodo = statusLower === 'to do';
		const isAiReview = statusLower === 'ai review';
		if (!isTodo && !(aiReviewEnabled && isAiReview)) continue;
		for (const task of group.tasks) {
			if (inFlight.has(task.id)) continue;
			if (!task.assignees.some(a => a.username === darrylUsername)) continue;
			out.push({
				id: task.id,
				name: task.name,
				url: task.url,
				status: isAiReview ? 'ai review' : 'to do',
			});
		}
	}
	if (aiReviewEnabled) {
		out.sort((a, b) => {
			if (a.status === 'ai review' && b.status !== 'ai review') return -1;
			if (a.status !== 'ai review' && b.status === 'ai review') return 1;
			return 0;
		});
	}
	return out;
}

export interface ClassifyCandidate {
	id: string;
	name: string;
	url: string;
}

/**
 * Pick tickets eligible for Auto Mode classification: status "to do", assigned
 * to the auto-mode user, and NOT already excluded (a pending recommendation or
 * an in-flight dispatch — both passed in `exclude`).
 *
 * Pure. The caller (autoJasperClassifyPickup) gates on the Auto Mode setting,
 * the Darryl singleton, and slices to one ticket at a time.
 */
export function selectJasperClassifyPickups(
	clickupTickets: ClickUpStatusGroup[],
	exclude: Set<string>,
	assigneeUsername: string,
): ClassifyCandidate[] {
	const out: ClassifyCandidate[] = [];
	for (const group of clickupTickets) {
		if (group.name.toLowerCase() !== 'to do') continue;
		for (const task of group.tasks) {
			if (exclude.has(task.id)) continue;
			if (!task.assignees.some(a => a.username === assigneeUsername)) continue;
			out.push({ id: task.id, name: task.name, url: task.url });
		}
	}
	return out;
}

/**
 * Pick Jan-eligible tickets from a ClickUp snapshot, bucketed by status.
 *
 * Jan is assigned to every ticket she owns at the top level. Sub-tickets
 * (e.g. UX Direction briefings) inherit authorisation via their parent —
 * they're included if their ID or their parent's ID is in Jan's assignee
 * set. Tickets already in the in-flight registry are dropped from every
 * bucket.
 */
export function selectJanPickups(
	clickupTickets: ClickUpStatusGroup[],
	inFlight: Set<string>,
	janUsername: string,
	aiReviewEnabled: boolean,
): JanBuckets {
	// First pass: collect every ticket ID Jan is directly assigned to.
	const janTicketIds = new Set<string>();
	for (const group of clickupTickets) {
		for (const task of group.tasks) {
			if (task.assignees.some(a => a.username === janUsername)) {
				janTicketIds.add(task.id);
			}
		}
	}

	const isJanScoped = (task: ClickUpTask): boolean =>
		janTicketIds.has(task.id) || (!!task.parent && janTicketIds.has(task.parent));

	const refine: JanCandidate[] = [];
	const todo: JanCandidate[] = [];
	const aiReview: JanCandidate[] = [];
	const revision: JanCandidate[] = [];

	for (const group of clickupTickets) {
		const statusLower = group.name.toLowerCase();
		if (
			statusLower !== 'to refine'
			&& statusLower !== 'to do'
			&& statusLower !== 'ai review'
			&& statusLower !== 'revision needed'
		) continue;
		if (statusLower === 'ai review' && !aiReviewEnabled) continue;

		for (const task of group.tasks) {
			if (inFlight.has(task.id)) continue;
			if (!isJanScoped(task)) continue;
			const candidate: JanCandidate = { id: task.id, name: task.name, url: task.url };
			switch (statusLower) {
				case 'to refine': refine.push(candidate); break;
				case 'to do': todo.push(candidate); break;
				case 'ai review': aiReview.push(candidate); break;
				case 'revision needed': revision.push(candidate); break;
			}
		}
	}

	return { refine, todo, aiReview, revision, janTicketIds };
}
