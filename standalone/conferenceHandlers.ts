import * as os from 'os';
import * as crypto from 'crypto';
import { loadKnownProjects } from '../src/projectStore.js';
import { CONFERENCE_AGENT_DELAY_MS, PEERS_BROKER_URL } from './constants.js';
import { launchAgentSession } from './itermFocus.js';
import {
	savePersistentAgents,
	expandHome,
	ensureMempalaceMcpConfig,
	mergeMcpConfigs,
} from './agentStore.js';
import { buildSystemPrompt, buildConferencePrompt } from './systemPrompts.js';
import { ensureMcpConfig, startConference, endConference } from './conferenceManager.js';
import type { ConferenceState } from './conferenceManager.js';
import type { ServerContext } from './serverContext.js';

export { PEERS_BROKER_URL };

export function handleStartConference(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, broadcastSink } = ctx;
	const agent1Id = msg.agent1Id as string;
	const agent2Id = msg.agent2Id as string;
	const topic = msg.topic as string;

	const pa1 = persistentAgents.find(p => p.id === agent1Id);
	const pa2 = persistentAgents.find(p => p.id === agent2Id);
	if (!pa1 || !pa2) {
		console.log(`[Standalone] Conference: one or both agents not found (${agent1Id}, ${agent2Id})`);
		return;
	}

	const peersMcpConfigPath = ensureMcpConfig();
	const mempalaceMcpConfigPath = ensureMempalaceMcpConfig();
	const mcpConfigPath = mergeMcpConfigs(peersMcpConfigPath, mempalaceMcpConfigPath);
	const conferenceId = crypto.randomUUID();
	const sid1 = crypto.randomUUID();
	const sid2 = crypto.randomUUID();

	const launchOptions = {
		mcpConfigPath,
		extraFlags: ['--allowedTools', 'mcp__peers__send_message,mcp__peers__check_messages,mcp__peers__list_peers,mcp__peers__set_summary'],
	};

	// Build prompts
	const knownProjects = loadKnownProjects();
	const project1 = knownProjects.find(p => p.workspacePath === pa1.workspacePath);
	const project2 = knownProjects.find(p => p.workspacePath === pa2.workspacePath);
	// Conferences are user-triggered from the UI — skip the self-exit block so
	// neither participant auto-closes its iTerm tab when the chat wraps up.
	const prompt1 = buildSystemPrompt(pa1, project1?.description, false) + buildConferencePrompt(pa1, pa2.name, topic);
	const prompt2 = buildSystemPrompt(pa2, project2?.description, false) + buildConferencePrompt(pa2, pa1.name, topic);
	const initialPrompt1 = `Conference topic: ${topic}. Start NOW: call mcp__peers__list_peers with scope="machine" to find ${pa2.name}, then send_message with your introduction. Use ONLY MCP peer tools, NOT SendMessage/Agent.`;
	const initialPrompt2 = `Conference topic: ${topic}. Start NOW: call mcp__peers__check_messages to see if ${pa1.name} has messaged you, then reply via mcp__peers__send_message. If no message yet, call mcp__peers__list_peers with scope="machine" to find them. Use ONLY MCP peer tools, NOT SendMessage/Agent.`;

	// Launch agent 1
	pa1.currentSessionId = sid1;
	savePersistentAgents(persistentAgents);
	const cwd1 = expandHome(pa1.workspacePath || '~');
	console.log(`[Standalone] Conference: launching ${pa1.name} (${sid1})`);
	launchAgentSession(sid1, cwd1, prompt1, initialPrompt1, launchOptions);

	// Launch agent 2 after delay
	setTimeout(() => {
		pa2.currentSessionId = sid2;
		savePersistentAgents(persistentAgents);
		const cwd2 = expandHome(pa2.workspacePath || '~');
		console.log(`[Standalone] Conference: launching ${pa2.name} (${sid2})`);
		launchAgentSession(sid2, cwd2, prompt2, initialPrompt2, launchOptions);
	}, CONFERENCE_AGENT_DELAY_MS);

	// Track conference
	const conf: ConferenceState = {
		id: conferenceId,
		topic,
		agent1Id,
		agent2Id,
		agent1SessionId: sid1,
		agent2SessionId: sid2,
		startedAt: new Date().toISOString(),
		status: 'launching',
	};
	startConference(conf);

	broadcastSink.postMessage({
		type: 'conferenceStarted',
		conferenceId,
		agent1Id,
		agent2Id,
		topic,
		agent1SessionId: sid1,
		agent2SessionId: sid2,
	});
}

export function handleEndConference(msg: Record<string, unknown>, ctx: ServerContext): void {
	const conferenceId = msg.conferenceId as string;
	const conf = endConference(conferenceId);
	if (conf) {
		console.log(`[Standalone] Conference ended: ${conferenceId}`);
	}
	ctx.broadcastSink.postMessage({ type: 'conferenceEnded', conferenceId });
}
