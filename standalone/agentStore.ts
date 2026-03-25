import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

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

export function buildSystemPrompt(agent: PersistentAgent): string {
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
	return lines.join('\n');
}
