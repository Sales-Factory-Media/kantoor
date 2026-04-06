import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SERVER_PORT } from './constants.js';

const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
const AGENTS_FILE = path.join(SETTINGS_DIR, 'agents.json');
const AGENTS_DIR = path.join(SETTINGS_DIR, 'agents');

export interface PersistentAgent {
	id: string;
	name: string;
	roleShort: string;
	roleFull: string;
	workspacePath: string;
	palette?: number;
	hueShift?: number;
	seatId?: string;
	currentSessionId?: string;
	lastSessionEnd?: string;
	sessionCount?: number;
}

export function loadPersistentAgents(): PersistentAgent[] {
	try {
		if (!fs.existsSync(AGENTS_FILE)) return [];
		return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8')) as PersistentAgent[];
	} catch { return []; }
}

export function savePersistentAgents(agents: PersistentAgent[]): void {
	if (!fs.existsSync(SETTINGS_DIR)) {
		fs.mkdirSync(SETTINGS_DIR, { recursive: true });
	}
	fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2), 'utf-8');
}

export function getAgentMemoryPath(agentId: string): string {
	return path.join(AGENTS_DIR, agentId, 'MEMORY.md');
}

export function ensureAgentMemory(agentId: string): void {
	const dir = path.join(AGENTS_DIR, agentId);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const memPath = getAgentMemoryPath(agentId);
	if (!fs.existsSync(memPath)) {
		fs.writeFileSync(memPath, '# Memory\n\nThis file is your persistent memory. Update it as you work.\n', 'utf-8');
	}
}

export function deleteAgentData(agentId: string): void {
	const dir = path.join(AGENTS_DIR, agentId);
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true });
	}
}

export function generateAgentId(): string {
	return crypto.randomUUID();
}

/** Expand ~ to the current user's home directory */
export function expandHome(p: string): string {
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	if (p === '~') return os.homedir();
	return p;
}

/** Collapse absolute home dir path back to ~ for portable storage */
export function collapseHome(p: string): string {
	const home = os.homedir();
	if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
	if (p === home) return '~';
	return p;
}

const OFFICE_NAMES = [
	'Michael', 'Dwight', 'Jim', 'Pam', 'Ryan', 'Andy', 'Stanley',
	'Kevin', 'Meredith', 'Angela', 'Oscar', 'Phyllis', 'Kelly',
	'Toby', 'Creed', 'Darryl', 'Jan', 'Holly', 'Erin', 'Gabe',
	'Clark', 'Pete', 'Nellie', 'Robert', 'Karen', 'Roy', 'Todd',
	'Devon', 'Madge', 'Lonny', 'Hank', 'Nate', 'Val', 'Cathy',
	'Jordan', 'Hannah', 'Troy', 'Nick', 'Sadiq', 'Hidetoshi',
];

/** Pick a random name not already used by existing persistent agents */
export function pickRandomName(existingAgents: PersistentAgent[]): string {
	const usedNames = new Set(existingAgents.map(a => a.name));
	const available = OFFICE_NAMES.filter(n => !usedNames.has(n));
	if (available.length > 0) {
		return available[Math.floor(Math.random() * available.length)];
	}
	// All names taken — pick a random one with a suffix
	const base = OFFICE_NAMES[Math.floor(Math.random() * OFFICE_NAMES.length)];
	let suffix = 2;
	while (usedNames.has(`${base} ${suffix}`)) suffix++;
	return `${base} ${suffix}`;
}

export function buildSystemPrompt(agent: PersistentAgent, projectDescription?: string): string {
	const memoryPath = getAgentMemoryPath(agent.id);
	const lines = [
		`You are ${agent.name}.`,
	];
	if (agent.roleFull) {
		lines.push('', agent.roleFull);
	} else if (agent.roleShort) {
		lines.push(`Your role: ${agent.roleShort}.`);
	}
	lines.push(
		'',
		`Your persistent memory file is at: ${memoryPath}`,
		'Read this file at the start of each session to recall context from previous sessions.',
		'Update it as you work with important decisions, progress, patterns, and context you want to remember across sessions.',
	);
	if (agent.sessionCount && agent.sessionCount > 0) {
		lines.push(
			'',
			"You're returning to work. Check your memory file for context from your previous sessions.",
		);
		if (agent.lastSessionEnd) {
			lines.push(`Your last session ended on ${agent.lastSessionEnd}.`);
		}
	}
	if (projectDescription) {
		lines.push(
			'',
			'## Project Context',
			'',
			projectDescription,
		);
	}
	lines.push(
		'',
		'## Git Conventions (Gitflow + ClickUp Integration)',
		'',
		'This project uses Gitflow. When making commits and pull requests, follow these conventions so ClickUp automatically tracks the work:',
		'',
		'**Branch naming**: Create a feature branch off `develop` using the Gitflow convention with the ClickUp ticket ID:',
		'`feature/CU-<ticketId>-<short-description>` (e.g. `feature/CU-abc123-fix-login-bug`).',
		'',
		'**Commit messages**: Include the ticket ID in your commit messages using one of these formats:',
		'- `CU-<ticketId> <message>` (e.g. `CU-abc123 fix null pointer in auth flow`)',
		'- Or include `#<ticketId>` anywhere in the commit message',
		'',
		'**Pull request titles**: Include `CU-<ticketId>` in the PR title (e.g. `CU-abc123 Fix login authentication bug`).',
		'',
		'**Pull request base branch**: Always target `develop`, never `main`/`master` directly.',
		'',
		'**Pull request body**: Always include a link to the ClickUp ticket in the PR description.',
		'',
		'## Ticket Status on Completion',
		'',
		'When you are done with work on a ClickUp ticket, do NOT mark it as "done" or "complete".',
		'Instead, update the ticket status to "QA Test" using the ClickUp MCP tools.',
		'A human developer will review and validate the work before it can be considered done.',
	);
	if (agent.currentSessionId) {
		lines.push(
			'',
			'## Self-Exit',
			'',
			'When you have completed ALL of your work (code committed, PR created, ticket status updated, memory file updated), exit your session by running:',
			'',
			'```',
			`curl -s -X POST http://localhost:${SERVER_PORT}/api/agent-exit -H 'Content-Type: application/json' -d '{"sessionId":"${agent.currentSessionId}"}'`,
			'```',
			'',
			`Your session ID is: ${agent.currentSessionId}`,
			'',
			'Before exiting, ensure:',
			'1. All code changes are committed and pushed',
			'2. A pull request has been created (if applicable)',
			'3. The ClickUp ticket status has been updated:',
			'   - "qa test" — if work is complete and ready for review',
			'   - "refinement" — if the ticket is unclear and needs human clarification',
			'   - "on hold" — if the work cannot be done or is already done',
			'4. Your memory file has been updated with what you accomplished',
			'',
			'The exit command closes your terminal session. Make sure all work is saved before calling it.',
		);
	}
	return lines.join('\n');
}

export interface RosterEntry {
	id: string;
	name: string;
	roleShort: string;
	roleFull: string;
	workspacePath: string;
	projectName?: string;
	projectDescription?: string;
	isOnline: boolean;
}

export function buildDarrylSystemPrompt(agent: PersistentAgent, roster: RosterEntry[], serverPort: number): string {
	const memoryPath = getAgentMemoryPath(agent.id);
	const lines = [
		'You are Darryl, the Foreman of this development team.',
		'',
		`Your persistent memory file is at: ${memoryPath}`,
		'Read this file at the start of each session to recall context from previous sessions.',
		'Update it as you work with important decisions, progress, patterns, and context you want to remember across sessions.',
		'',
		'## Decision Framework',
		'',
		'When you receive a ticket to assess, follow these steps:',
		'',
		'1. **Read the ticket** using `mcp__clickup__clickup_get_task` with the task_id provided.',
		'2. **Assess completeness**: Does the ticket have a clear description? Are there acceptance criteria? Is the scope well-defined?',
		'3. **If NOT complete**: Use `mcp__clickup__clickup_create_task_comment` to comment on the ticket with specific questions about what is missing or unclear. Do NOT assign anyone.',
		'4. **If complete**: Match the ticket to the best available agent based on their role, project, and expertise, then launch them using the HTTP API.',
		'',
		'## HTTP API — Launching Agents',
		'',
		`Use curl to launch agents via the Pixel Agents server at http://localhost:${serverPort}:`,
		'',
		'**Solo assignment** (single agent works on the ticket):',
		'```',
		`curl -X POST http://localhost:${serverPort}/api/launch-agent -H 'Content-Type: application/json' -d '{"agentId":"<id>","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>"}'`,
		'```',
		'',
		'**Team assignment** (agent spawns sub-agents for complex work):',
		'```',
		`curl -X POST http://localhost:${serverPort}/api/launch-agent -H 'Content-Type: application/json' -d '{"agentId":"<id>","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>","useTeam":true}'`,
		'```',
		'',
		'**With additional instructions**:',
		'```',
		`curl -X POST http://localhost:${serverPort}/api/launch-agent -H 'Content-Type: application/json' -d '{"agentId":"<id>","ticketId":"<id>","ticketName":"<name>","ticketUrl":"<url>","additionalPrompt":"..."}'`,
		'```',
		'',
		'## Agent Roster',
		'',
	];

	for (const entry of roster) {
		lines.push(`- **${entry.name}** (id: \`${entry.id}\`)`);
		lines.push(`  - Role: ${entry.roleShort || 'unspecified'}${entry.roleFull ? ` — ${entry.roleFull}` : ''}`);
		lines.push(`  - Workspace: ${entry.workspacePath}`);
		if (entry.projectDescription) {
			lines.push(`  - Project: ${entry.projectName || 'unknown'} — ${entry.projectDescription}`);
		} else if (entry.projectName) {
			lines.push(`  - Project: ${entry.projectName}`);
		}
		lines.push(`  - Status: ${entry.isOnline ? 'ONLINE (busy)' : 'OFFLINE (available)'}`);
	}

	lines.push(
		'',
		'## Rules',
		'',
		'- Only assign OFFLINE agents. Online agents are already busy with other work.',
		'- Match the agent\'s workspace and role to the ticket\'s project and requirements.',
		'- Use team mode for complex, multi-part tickets that benefit from parallel work.',
		'- Update your memory file after each decision with what you decided and why.',
	);

	if (agent.currentSessionId) {
		lines.push(
			'',
			'## Self-Exit',
			'',
			'When you have completed ALL of your work (code committed, PR created, ticket status updated, memory file updated), exit your session by running:',
			'',
			'```',
			`curl -s -X POST http://localhost:${serverPort}/api/agent-exit -H 'Content-Type: application/json' -d '{"sessionId":"${agent.currentSessionId}"}'`,
			'```',
			'',
			`Your session ID is: ${agent.currentSessionId}`,
			'',
			'Before exiting, ensure:',
			'1. All code changes are committed and pushed',
			'2. A pull request has been created (if applicable)',
			'3. The ClickUp ticket status has been updated:',
			'   - "qa test" — if work is complete and ready for review',
			'   - "refinement" — if the ticket is unclear and needs human clarification',
			'   - "on hold" — if the work cannot be done or is already done',
			'4. Your memory file has been updated with what you accomplished',
			'',
			'The exit command closes your terminal session. Make sure all work is saved before calling it.',
		);
	}

	return lines.join('\n');
}

export function buildConferencePrompt(agent: PersistentAgent, partnerName: string, topic: string): string {
	const lines = [
		'',
		'## Conference Mode',
		'',
		`You are in a conference with ${partnerName}. Topic: ${topic}`,
		'',
		'### CRITICAL — How to communicate',
		'',
		'You have access to MCP tools from the "peers" MCP server. These are the ONLY tools you may use to communicate.',
		'The tool names are EXACTLY as listed below — use these literal tool names:',
		'',
		'1. Tool name: `mcp__peers__list_peers` — call with scope="machine" (IMPORTANT: always use "machine" scope, NOT "repo" or "directory", because your partner may be in a different repo)',
		'2. Tool name: `mcp__peers__send_message` — call with to_id (from list_peers) and message parameters',
		'3. Tool name: `mcp__peers__check_messages` — call to check for replies',
		'',
		'WARNING: Do NOT use SendMessage, Agent, or any built-in Claude Code tools to communicate.',
		'SendMessage is a DIFFERENT tool that sends messages to subagents — it CANNOT reach ' + partnerName + '.',
		'Only `mcp__peers__send_message` (the MCP tool) can reach other peers. This is non-negotiable.',
		'',
		'### Guidelines',
		'- ALWAYS use scope="machine" when calling list_peers — your partner may be working in a different repository',
		'- Start by introducing yourself and your perspective on the topic',
		'- Take turns — send a message via `mcp__peers__send_message`, then check for replies via `mcp__peers__check_messages`',
		'- After sending a message, wait ~10 seconds then call `mcp__peers__check_messages` to see if a reply arrived',
		`- If ${partnerName} hasn't registered yet, wait a few seconds and retry \`mcp__peers__list_peers\` (with scope="machine")`,
		'- When discussion is complete, call `mcp__peers__set_summary` with a summary of the outcomes, then also save to your memory file',
	];
	return lines.join('\n');
}
