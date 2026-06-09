/**
 * Shared boilerplate for launching a persistent-agent session.
 *
 * Every handler that dispatches a worker / designer / reviewer was doing the
 * same dance: pick an agent, stamp `currentSessionId` + ticket info, save,
 * resolve `cwd`, build mempalace MCP config, call `launchAgentSession` with
 * `--permission-mode auto`. Extracted here so the dance lives in one place.
 */

import * as crypto from 'crypto';
import { launchAgentSession } from './itermFocus.js';
import {
	expandHome,
	savePersistentAgents,
	addAgentSession,
	removeAgentSession,
	ensureMempalaceMcpConfig,
	mergeMcpConfigs,
} from './agentStore.js';
import type { PersistentAgent } from './agentStore.js';
import { ensureMcpConfig as ensurePeersMcpConfig } from './conferenceManager.js';
import type { ServerContext } from './serverContext.js';

/** Compact record of the ticket a session is being launched against. */
export interface TicketInfo {
	ticketId: string;
	ticketName: string;
	ticketUrl: string;
}

/**
 * Append this to every initial task so the agent remembers to close its
 * iTerm tab when work is complete. The matching bash block lives in the
 * agent's system prompt under "## Self-Exit" (buildSelfExitBlock).
 */
export const EXIT_REMINDER =
	'\n\nWhen you have finished this work (PR open, ticket status flipped, MemPalace updated), ' +
	'run the `## Self-Exit` bash block from your system prompt to close your iTerm tab. ' +
	'Don\'t run it until everything is saved — there is no coming back.';

export interface LaunchOptions {
	/**
	 * If true, also include the `claude-peers` MCP in the config so the agent
	 * can message peers. Used by Visual QA to ping the designer.
	 */
	withPeers?: boolean;
	/**
	 * If true, the new iTerm2 tab opens without bringing iTerm2 to the front.
	 * Defaults to true here because every caller of `launchPersistentAgentSession`
	 * is an auto-dispatch path (Jan/Darryl orchestrator batches, worker dispatch,
	 * legacy Jan briefing) and those should not interrupt the user.
	 */
	noFocus?: boolean;
}

export interface LaunchResult {
	success: boolean;
	error?: string;
}

/**
 * Launch a session for the given persistent agent against a specific ticket.
 *
 * Mutates the persistent agent: sets `currentSessionId` + ticket fields,
 * calls `savePersistentAgents` so the state survives server restarts.
 *
 * On launch failure, rolls back `currentSessionId` so a retry can take the
 * slot.
 */
export function launchPersistentAgentSession(
	agent: PersistentAgent,
	systemPrompt: string,
	initialTask: string,
	ticket: TicketInfo,
	ctx: ServerContext,
	persistentAgents: PersistentAgent[],
	options: LaunchOptions = {},
): LaunchResult {
	const newSessionId = crypto.randomUUID();
	addAgentSession(agent, {
		sessionId: newSessionId,
		ticketId: ticket.ticketId,
		ticketName: ticket.ticketName,
		ticketUrl: ticket.ticketUrl,
	});
	savePersistentAgents(persistentAgents);

	let mempalaceHost: string | undefined;
	if (ctx.mempalaceServerUrl) {
		try {
			mempalaceHost = new URL(ctx.mempalaceServerUrl).hostname;
		} catch {
			mempalaceHost = undefined;
		}
	}

	const mempalaceConfigPath = ensureMempalaceMcpConfig(mempalaceHost);
	const mcpConfigPath = options.withPeers
		? mergeMcpConfigs(ensurePeersMcpConfig(), mempalaceConfigPath)
		: mempalaceConfigPath;

	const cwd = expandHome(agent.workspacePath || '~');
	const noFocus = options.noFocus ?? true;
	const launched = launchAgentSession(
		newSessionId,
		cwd,
		systemPrompt,
		initialTask,
		{ mcpConfigPath, extraFlags: ['--permission-mode', 'auto'], noFocus },
	);

	if (launched) {
		return { success: true };
	}

	// Rollback so the slot is free for retry.
	removeAgentSession(agent, newSessionId);
	savePersistentAgents(persistentAgents);
	return { success: false, error: 'Failed to launch agent session' };
}
