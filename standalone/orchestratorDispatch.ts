/**
 * Orchestrator batch dispatch — shared launch path for Darryl and Jan.
 *
 * Orchestrators are pure: they never claim tickets in the dispatch registry
 * for their own session. Race-protection is the singleton `currentSessionId`
 * on the persistent-agent record, NOT a registry claim. Per-worker claims
 * happen later, inside the orchestrator's session, when it curls a
 * worker-dispatch endpoint (launchAgentOnTicket, handleLaunchDesigner,
 * handleLaunchVisualDesigner, handleVisualQaReview).
 *
 * The ONLY per-orchestrator differences live in `OrchestratorBatchSpec`:
 *   - which persistent agent to find/create,
 *   - which system prompt to build,
 *   - which batch initial-task to build.
 * Everything else (roster construction, singleton gate, first-ticket
 * tracking, launch, logging) is shared.
 *
 * If you add a third orchestrator, implement it by passing a new spec to
 * `dispatchOrchestratorBatch` — do NOT copy-paste these wrappers.
 */

import * as path from 'path';
import type { ServerContext } from './serverContext.js';
import type { PersistentAgent } from './agentStore.js';
import { savePersistentAgents, generateAgentId } from './agentStore.js';
import type { RosterEntry } from './systemPrompts.js';
import { buildDarrylSystemPrompt, buildJanSystemPrompt } from './systemPrompts.js';
import { getJanDesignConfig } from './agentHandlers.js';
import {
	SERVER_PORT,
	DARRYL_ROLE_SHORT,
	DARRYL_WORKSPACE,
	JAN_ROLE_SHORT,
	JAN_WORKSPACE,
} from './constants.js';
import {
	EXIT_REMINDER,
	launchPersistentAgentSession,
	type TicketInfo,
} from './launchHelpers.js';
import {
	buildDarrylBatchInitialTask,
	buildDarrylClassifyInitialTask,
	buildJanBatchInitialTask,
	type ClassifyWorkerOption,
} from './initialTasks.js';
import { isDevWorker } from './capacity.js';
import { loadKnownProjects } from '../src/projectStore.js';

// ── Utilities ────────────────────────────────────────────────

/** Build the roster passed into system prompts — every persistent agent
 *  except the one being launched, enriched with known-project metadata. */
export function buildRoster(
	persistentAgents: PersistentAgent[],
	excludeAgentId: string,
): RosterEntry[] {
	const knownProjects = loadKnownProjects();
	return persistentAgents
		.filter(p => p.id !== excludeAgentId)
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
}

/** Idempotent find-or-create for a well-known agent (Jan / Darryl). */
export function findOrCreatePersistentAgent(
	persistentAgents: PersistentAgent[],
	name: string,
	roleShort: string,
	roleFull: string,
	workspacePath: string,
): PersistentAgent {
	let agent = persistentAgents.find(p => p.name === name);
	if (!agent) {
		agent = { id: generateAgentId(), name, roleShort, roleFull, workspacePath };
		persistentAgents.push(agent);
		savePersistentAgents(persistentAgents);
	}
	return agent;
}

// ── Shared batch dispatch ────────────────────────────────────

export interface OrchestratorBatchSpec<S extends string> {
	/** Display name used in logs — e.g. "Darryl", "Jan". */
	name: string;
	ensureAgent: (persistentAgents: PersistentAgent[]) => PersistentAgent;
	buildSystemPrompt: (agent: PersistentAgent, roster: RosterEntry[]) => string;
	buildInitialTask: (
		batch: Array<{ id: string; name: string; url: string; status: S }>,
	) => string;
}

/**
 * Launch an orchestrator with a batch of tickets. The orchestrator processes
 * them sequentially in one session, firing a dispatch curl per ticket; the
 * dispatched workers run in parallel on their own machines.
 */
export function dispatchOrchestratorBatch<S extends string>(
	spec: OrchestratorBatchSpec<S>,
	batch: Array<TicketInfo & { status: S }>,
	ctx: ServerContext,
): void {
	if (batch.length === 0) return;
	const { persistentAgents } = ctx;

	const agent = spec.ensureAgent(persistentAgents);
	if (agent.currentSessionId) {
		console.log(`[Standalone] ${spec.name} already has an active session ${agent.currentSessionId}, skipping batch dispatch of ${batch.length}`);
		return;
	}

	const roster = buildRoster(persistentAgents, agent.id);
	const systemPrompt = spec.buildSystemPrompt(agent, roster);
	const initialTask = spec.buildInitialTask(
		batch.map(t => ({ id: t.ticketId, name: t.ticketName, url: t.ticketUrl, status: t.status })),
	) + EXIT_REMINDER;

	// Track only the first ticket on the persistent-agent record (used for UI
	// labels); the rest are listed in the initial task.
	const first = batch[0];
	const result = launchPersistentAgentSession(
		agent,
		systemPrompt,
		initialTask,
		first,
		ctx,
		persistentAgents,
	);
	if (!result.success) {
		console.log(`[Standalone] Failed to launch ${spec.name} batch of ${batch.length}`);
	}
}

// ── Orchestrator specs + public wrappers ────────────────────

export function ensureDarryl(persistentAgents: PersistentAgent[]): PersistentAgent {
	return findOrCreatePersistentAgent(
		persistentAgents,
		'Darryl',
		DARRYL_ROLE_SHORT,
		'The Foreman. Assesses tickets, decides which agents should work on them, and launches them.',
		DARRYL_WORKSPACE,
	);
}

export function ensureJan(persistentAgents: PersistentAgent[]): PersistentAgent {
	return findOrCreatePersistentAgent(
		persistentAgents,
		'Jan',
		JAN_ROLE_SHORT,
		'The Art Director. Receives design briefings, delegates to PM and designers, reviews output, and maintains design quality standards.',
		JAN_WORKSPACE,
	);
}

export function handleDarrylBatchDispatch(
	batch: Array<TicketInfo & { status: 'to do' | 'ai review' }>,
	ctx: ServerContext,
): void {
	dispatchOrchestratorBatch(
		{
			name: 'Darryl',
			ensureAgent: ensureDarryl,
			buildSystemPrompt: (agent, roster) => buildDarrylSystemPrompt(agent, roster, SERVER_PORT),
			buildInitialTask: buildDarrylBatchInitialTask,
		},
		batch,
		ctx,
	);
}

/**
 * Auto Mode: launch Darryl to CLASSIFY a single ticket (pick the best worker)
 * without dispatching. He POSTs a recommendation to /api/darryl-recommendation;
 * a human confirms it in the kantoor. Singleton-gated on Darryl's session, like
 * every other orchestrator launch — never claims the dispatch registry.
 */
export function dispatchDarrylClassify(
	ticket: TicketInfo,
	ctx: ServerContext,
): void {
	const { persistentAgents } = ctx;

	const darryl = ensureDarryl(persistentAgents);
	if (darryl.currentSessionId) {
		console.log(`[Standalone] Darryl already has an active session ${darryl.currentSessionId}, skipping classify of ${ticket.ticketId}`);
		return;
	}

	const knownProjects = loadKnownProjects();
	const workers: ClassifyWorkerOption[] = persistentAgents
		.filter(p => p.id !== darryl.id && isDevWorker(p) && p.workspacePath)
		.map(p => {
			const projName = path.basename(p.workspacePath);
			const proj = knownProjects.find(k => k.name === projName);
			return {
				id: p.id,
				name: p.name,
				roleShort: p.roleShort,
				workspacePath: p.workspacePath,
				projectName: proj?.name ?? projName,
				isOnline: !!p.currentSessionId,
			};
		});

	const roster = buildRoster(persistentAgents, darryl.id);
	const systemPrompt = buildDarrylSystemPrompt(darryl, roster, SERVER_PORT);
	const initialTask = buildDarrylClassifyInitialTask(
		{ id: ticket.ticketId, name: ticket.ticketName, url: ticket.ticketUrl },
		workers,
		SERVER_PORT,
	) + EXIT_REMINDER;

	console.log(`[Standalone] Auto-pickup: Darryl classifying ticket ${ticket.ticketId} (${workers.length} eligible workers)`);
	const result = launchPersistentAgentSession(
		darryl,
		systemPrompt,
		initialTask,
		ticket,
		ctx,
		persistentAgents,
	);
	if (!result.success) {
		console.log(`[Standalone] Failed to launch Darryl to classify ticket ${ticket.ticketId}`);
	}
}

export function handleJanBatchDispatch(
	batch: Array<TicketInfo & { status: 'to do' | 'ai review' | 'revision needed' }>,
	ctx: ServerContext,
): void {
	dispatchOrchestratorBatch(
		{
			name: 'Jan',
			ensureAgent: ensureJan,
			buildSystemPrompt: (agent, roster) => buildJanSystemPrompt(agent, roster, SERVER_PORT, getJanDesignConfig()),
			buildInitialTask: buildJanBatchInitialTask,
		},
		batch,
		ctx,
	);
}
