import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
	SERVER_PORT,
	MEMPALACE_SERVER_PORT,
	DARRYL_ROLE_SHORT,
	DESIGNER_ROLE_SHORT,
	VISUAL_DESIGNER_ROLE_SHORT,
	PM_ROLE_SHORT,
	UX_PM_ROLE_SHORT,
	UX_QA_ROLE_SHORT,
	VISUAL_PM_ROLE_SHORT,
	VISUAL_QA_ROLE_SHORT,
	TEAM_UX_ID,
	TEAM_VISUAL_ID,
	TEAM_WORKER_COUNT,
	JAN_ROLE_SHORT,
	JAN_WORKSPACE,
	DEFAULT_DESIGN_FIGMA_URL,
	DEFAULT_DESIGN_CLICKUP_DOC_URL,
	AI_REVIEW_ENABLED,
	VISUAL_DESIGN_DARK_MODE_REQUIRED,
} from './constants.js';
import { writeJson } from './serverHelpers.js';
import { loadKnownProjects } from '../src/projectStore.js';

const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
const AGENTS_FILE = path.join(SETTINGS_DIR, 'agents.json');
const AGENTS_DIR = path.join(SETTINGS_DIR, 'agents');

export interface DesignConfig {
	figmaUrl: string;
	clickupDocUrl: string;
}

export const DEFAULT_DESIGN_CONFIG: DesignConfig = {
	figmaUrl: DEFAULT_DESIGN_FIGMA_URL,
	clickupDocUrl: DEFAULT_DESIGN_CLICKUP_DOC_URL,
};

export interface PersistentAgent {
	id: string;
	name: string;
	roleShort: string;
	roleFull: string;
	workspacePath: string;
	teamId?: string;          // e.g. 'ux-design', 'visual-design'
	reportsToId?: string;     // agent.id of the agent this one reports to
	palette?: number;
	hueShift?: number;
	seatId?: string;
	currentSessionId?: string;
	lastSessionEnd?: string;
	sessionCount?: number;
	currentTicketId?: string;
	currentTicketName?: string;
	currentTicketUrl?: string;
	lastTicketId?: string;
	retired?: boolean;        // archived role — kept for memory, never launched
}

// ── Team structure (static source of truth) ──────────────
export interface TeamDefinition {
	id: string;
	name: string;
	qaRole: string;
	workerRole: string;
	workerRoleFull: string;
	qaRoleFull: string;
	workerCount: number;
}

// PM roles removed 2026-04-22: Jan handles the project-management work herself
// (writing UX briefings, dispatching designers) to reduce the number of concurrent
// agents. Existing 'UX Project Manager' / 'Visual Project Manager' persistent
// agents are retired in loadPersistentAgents(): they keep their MEMORY but are
// tagged `retired: true` so seedDesignTeams won't recreate them and the launch
// pickers ignore them.
export const TEAMS: Record<string, TeamDefinition> = {
	[TEAM_UX_ID]: {
		id: TEAM_UX_ID,
		name: 'UX Design Team',
		qaRole: UX_QA_ROLE_SHORT,
		workerRole: DESIGNER_ROLE_SHORT,
		workerRoleFull: 'UX Designer. Reads design briefings from ClickUp, creates UX explorations in Figma on playground boards, and delivers diverse creative directions.',
		qaRoleFull: 'UX Quality Reviewer. Reviews UX designer output for clarity, completeness, and adherence to the briefing.',
		workerCount: TEAM_WORKER_COUNT,
	},
	[TEAM_VISUAL_ID]: {
		id: TEAM_VISUAL_ID,
		name: 'Visual Design Team',
		qaRole: VISUAL_QA_ROLE_SHORT,
		workerRole: VISUAL_DESIGNER_ROLE_SHORT,
		workerRoleFull: 'Visual Designer. Takes approved UX directions and creates polished, production-ready visual implementations following the design system.',
		qaRoleFull: 'Visual Quality Reviewer. Reviews Visual Designer output against the design system checklist, decides AI Review pass/fail, and forwards approved work to human QA.',
		workerCount: TEAM_WORKER_COUNT,
	},
};

export function loadPersistentAgents(): PersistentAgent[] {
	try {
		if (!fs.existsSync(AGENTS_FILE)) return [];
		const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8')) as PersistentAgent[];
		// Migration: rename legacy 'Designer' role → 'UX Designer' and assign team
		for (const a of agents) {
			if (a.roleShort === 'Designer') {
				a.roleShort = DESIGNER_ROLE_SHORT;
			}
			if (!a.teamId) {
				if (a.roleShort === DESIGNER_ROLE_SHORT) a.teamId = TEAM_UX_ID;
				else if (a.roleShort === VISUAL_DESIGNER_ROLE_SHORT) a.teamId = TEAM_VISUAL_ID;
			}
			// Migration (2026-04-22): PM roles removed — Jan does the PM work herself.
			// Tag existing PM agents as retired so they aren't picked by launchers or
			// seeded back by seedDesignTeams, but keep them in the store to preserve
			// their MEMORY.md history.
			if (
				(a.roleShort === UX_PM_ROLE_SHORT || a.roleShort === VISUAL_PM_ROLE_SHORT || a.roleShort === PM_ROLE_SHORT)
				&& !a.retired
			) {
				a.retired = true;
			}
		}
		return agents;
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
		fs.writeFileSync(memPath, '# Personal Scratchpad\n\nUse this for rough personal notes. MemPalace is the primary shared memory.\n', 'utf-8');
	}
}

function normalizeUrlHost(host: string): string {
	if (host.startsWith('[') && host.endsWith(']')) return host;
	if (host.includes(':')) return `[${host}]`;
	return host;
}

export function ensureMempalaceMcpConfig(hubHost: string = 'localhost'): string {
	const configPath = path.join(SETTINGS_DIR, 'mempalace-mcp-config.json');
	const normalizedHost = normalizeUrlHost(hubHost);
	const config = {
		mcpServers: {
			mempalace: {
				type: 'sse' as const,
				url: `http://${normalizedHost}:${MEMPALACE_SERVER_PORT}/sse`,
			},
		},
	};
	writeJson(configPath, config);
	return configPath;
}

/**
 * Merge multiple MCP config files into a single combined config file.
 * Each config file should have a `mcpServers` object; all servers are merged.
 */
export function mergeMcpConfigs(...configPaths: string[]): string {
	const mergedServers: Record<string, unknown> = {};
	for (const configPath of configPaths) {
		try {
			const content = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
			if (content.mcpServers) {
				Object.assign(mergedServers, content.mcpServers);
			}
		} catch (err) {
			console.warn(`[MCP Config] Failed to read/parse ${configPath}:`, err);
		}
	}
	const mergedPath = path.join(SETTINGS_DIR, 'merged-mcp-config.json');
	writeJson(mergedPath, { mcpServers: mergedServers });
	return mergedPath;
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

// ── Organogram payload (flat node list for d3-org-chart) ────

export type OrganogramNodeType = 'person' | 'team' | 'project';

export interface OrganogramNode {
	id: string;
	parentId: string | null;
	name: string;
	roleShort: string;
	roleFull: string;
	isOnline: boolean;
	nodeType: OrganogramNodeType;
	currentTicketId?: string;
	currentTicketName?: string;
}

export interface OrganogramPayload {
	nodes: OrganogramNode[];
}

export function buildOrganogram(persistentAgents: PersistentAgent[]): OrganogramPayload {
	const nodes: OrganogramNode[] = [];

	// ── Jasper (root) ──
	const jasperId = '__jasper__';
	nodes.push({
		id: jasperId,
		parentId: null,
		name: 'Jasper',
		roleShort: 'Owner',
		roleFull: 'Owner',
		isOnline: true,
		nodeType: 'person',
	});

	// ── Darryl ──
	const darryl = persistentAgents.find(p => p.roleShort === DARRYL_ROLE_SHORT);
	const darrylId = darryl?.id ?? '__darryl__';
	nodes.push({
		id: darrylId,
		parentId: jasperId,
		name: 'Darryl',
		roleShort: 'Foreman',
		roleFull: 'The Foreman. Assesses tickets and dispatches agents.',
		isOnline: darryl ? !!darryl.currentSessionId : false,
		nodeType: 'person',
		currentTicketId: darryl?.currentTicketId,
		currentTicketName: darryl?.currentTicketName,
	});

	// ── Darryl's teams: one per known project ──
	const knownProjects = loadKnownProjects();
	// Collect dev agents (not Jan, not design team members, not Darryl)
	const designAgentIds = new Set<string>();
	const jan = persistentAgents.find(p => p.roleShort === JAN_ROLE_SHORT);
	if (jan) designAgentIds.add(jan.id);
	for (const team of Object.values(TEAMS)) {
		for (const a of persistentAgents) {
			if (a.teamId === team.id) designAgentIds.add(a.id);
		}
	}
	const devAgents = persistentAgents.filter(
		p => p.id !== darrylId && !designAgentIds.has(p.id) && !p.retired,
	);

	// Group dev agents by workspacePath
	const agentsByWorkspace = new Map<string, PersistentAgent[]>();
	for (const a of devAgents) {
		const ws = a.workspacePath || '~/unknown';
		if (!agentsByWorkspace.has(ws)) agentsByWorkspace.set(ws, []);
		agentsByWorkspace.get(ws)!.push(a);
	}

	// Also add project nodes for known projects that have no agents yet
	for (const kp of knownProjects) {
		const wsKey = kp.workspacePath;
		if (!agentsByWorkspace.has(wsKey)) agentsByWorkspace.set(wsKey, []);
	}

	// Build a project name lookup from known projects
	const projectNameByWorkspace = new Map<string, string>();
	for (const kp of knownProjects) {
		projectNameByWorkspace.set(kp.workspacePath, kp.name);
	}

	for (const [workspace, agents] of agentsByWorkspace) {
		const projectName = projectNameByWorkspace.get(workspace)
			?? workspace.split('/').pop()
			?? 'Unknown';
		const projectNodeId = `__project__${workspace}`;
		nodes.push({
			id: projectNodeId,
			parentId: darrylId,
			name: projectName,
			roleShort: 'Project',
			roleFull: workspace,
			isOnline: agents.some(a => !!a.currentSessionId),
			nodeType: 'project',
		});
		for (const a of agents) {
			nodes.push({
				id: a.id,
				parentId: projectNodeId,
				name: a.name,
				roleShort: a.roleShort,
				roleFull: a.roleFull,
				isOnline: !!a.currentSessionId,
				nodeType: 'person',
				currentTicketId: a.currentTicketId,
				currentTicketName: a.currentTicketName,
			});
		}
	}

	// ── Jan (Art Director) ──
	const janId = jan?.id ?? '__jan__';
	nodes.push({
		id: janId,
		parentId: jasperId,
		name: 'Jan',
		roleShort: JAN_ROLE_SHORT,
		roleFull: 'The Art Director. Heads both design teams.',
		isOnline: jan ? !!jan.currentSessionId : false,
		nodeType: 'person',
		currentTicketId: jan?.currentTicketId,
		currentTicketName: jan?.currentTicketName,
	});

	// ── Jan's design teams ──
	for (const team of Object.values(TEAMS)) {
		const teamNodeId = `__team__${team.id}`;
		const members = persistentAgents.filter(p => p.teamId === team.id);
		nodes.push({
			id: teamNodeId,
			parentId: janId,
			name: team.name,
			roleShort: 'Team',
			roleFull: team.name,
			isOnline: members.some(m => !!m.currentSessionId),
			nodeType: 'team',
		});

		const qa = members.find(p => p.roleShort === team.qaRole && !p.retired);
		const workers = members.filter(p => p.roleShort === team.workerRole && !p.retired);

		if (qa) {
			nodes.push({
				id: qa.id,
				parentId: teamNodeId,
				name: qa.name,
				roleShort: 'QA',
				roleFull: qa.roleFull,
				isOnline: !!qa.currentSessionId,
				nodeType: 'person',
				currentTicketId: qa.currentTicketId,
				currentTicketName: qa.currentTicketName,
			});
		}
		for (const w of workers) {
			nodes.push({
				id: w.id,
				parentId: teamNodeId,
				name: w.name,
				roleShort: w.roleShort,
				roleFull: w.roleFull,
				isOnline: !!w.currentSessionId,
				nodeType: 'person',
				currentTicketId: w.currentTicketId,
				currentTicketName: w.currentTicketName,
			});
		}
	}

	return { nodes };
}

/**
 * Ensure both design teams are fully seeded:
 * - Each team has 1 PM and 1 QA, both reporting to Jan
 * - Each team has TEAM_WORKER_COUNT workers, reporting to their team PM
 * Idempotent — only creates missing slots. Returns true if anything was added.
 */
export function seedDesignTeams(persistentAgents: PersistentAgent[]): boolean {
	let changed = false;

	// Find or create Jan (head of design)
	let jan = persistentAgents.find(p => p.name === 'Jan');
	if (!jan) {
		jan = {
			id: generateAgentId(),
			name: 'Jan',
			roleShort: JAN_ROLE_SHORT,
			roleFull: 'The Art Director. Receives design briefings, delegates to PM and designers, reviews output, and maintains design quality standards.',
			workspacePath: JAN_WORKSPACE,
		};
		persistentAgents.push(jan);
		changed = true;
	}

	for (const team of Object.values(TEAMS)) {
		// QA — reports directly to Jan (no PM in between)
		let qa = persistentAgents.find(p => p.roleShort === team.qaRole && p.teamId === team.id && !p.retired);
		if (!qa) {
			qa = {
				id: generateAgentId(),
				name: pickRandomName(persistentAgents),
				roleShort: team.qaRole,
				roleFull: team.qaRoleFull,
				workspacePath: JAN_WORKSPACE,
				teamId: team.id,
				reportsToId: jan.id,
			};
			persistentAgents.push(qa);
			changed = true;
		} else if (qa.reportsToId !== jan.id) {
			// Rewire QA to Jan in case it was previously pointing at a (now retired) PM
			qa.reportsToId = jan.id;
			changed = true;
		}

		// Workers — reports directly to Jan
		const workers = persistentAgents.filter(
			p => p.roleShort === team.workerRole && p.teamId === team.id && !p.retired,
		);
		for (const w of workers) {
			if (w.reportsToId !== jan.id) {
				// Rewire legacy workers (previously reported to team PM) to Jan
				w.reportsToId = jan.id;
				changed = true;
			}
		}
		const missing = team.workerCount - workers.length;
		for (let i = 0; i < missing; i++) {
			const worker: PersistentAgent = {
				id: generateAgentId(),
				name: pickRandomName(persistentAgents),
				roleShort: team.workerRole,
				roleFull: team.workerRoleFull,
				workspacePath: JAN_WORKSPACE,
				teamId: team.id,
				reportsToId: jan.id,
			};
			persistentAgents.push(worker);
			changed = true;
		}
	}

	return changed;
}

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

/**
 * Self-exit block — tells the agent the curl command to close its own iTerm2 session when done.
 * Gated on currentSessionId: offline-roster agents don't get this block. `port` is the local
 * server the agent runs against (each hub/worker machine runs its own server on SERVER_PORT,
 * so the URL `http://localhost:<port>` always targets the agent's own machine).
 */
function buildSelfExitBlock(sessionId: string | undefined, port: number): string[] {
	if (!sessionId) return [];
	return [
		'',
		'## Self-Exit',
		'',
		'When you have completed ALL of your work (code committed, PR opened, ticket status updated, MemPalace / memory file updated), close your session with:',
		'',
		'```',
		`curl -s -X POST http://localhost:${port}/api/agent-exit -H 'Content-Type: application/json' -d '{"sessionId":"${sessionId}"}'`,
		'```',
		'',
		`Your session ID: ${sessionId}`,
		'',
		'Before exiting, ensure:',
		'1. All code changes committed and pushed.',
		'2. PR opened (if applicable).',
		'3. ClickUp ticket status updated (e.g. `qa test`, `refinement`, `on hold`).',
		'4. MemPalace and/or your memory file updated with what you accomplished.',
		'',
		'The exit command closes your terminal session. Do NOT call it until the four items above are done — there is no coming back.',
	];
}

function buildMemoryBlock(memoryPath: string, sessionCount?: number, lastSessionEnd?: string): string[] {
	const lines = [
		'## MemPalace (shared team memory)',
		'- Before starting: `mcp__mempalace__mempalace_search` (decisions) + `mempalace_kg_query` (entities). Skim, don\'t deep-read.',
		'- On significant decisions: `mempalace_add_drawer`. Never save secrets, routine changes, or session-only state.',
		`- Personal scratchpad (rough notes only): ${memoryPath}`,
	];
	if (sessionCount && sessionCount > 0) {
		lines.push(lastSessionEnd
			? `- Returning agent — last session ended ${lastSessionEnd}. Check MemPalace for what the team did since.`
			: '- Returning agent — check MemPalace for recent team activity.');
	}
	return lines;
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
	if (projectDescription) {
		lines.push(
			'',
			'## Project Context',
			'',
			projectDescription,
		);
	}
	lines.push('', ...buildMemoryBlock(memoryPath, agent.sessionCount, agent.lastSessionEnd));
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
		...(AI_REVIEW_ENABLED
			? [
				'When your PR is open, move the ticket to **"ai review"** using `mcp__clickup__clickup_update_task` (status: "ai review"). GitHub Copilot will review the PR; Darryl will later reassign someone (possibly you) with `aiReviewMode:true` to process Copilot\'s feedback. Do NOT move directly to "qa test".',
			]
			: [
				'When your PR is open, move the ticket to **"qa test"** using `mcp__clickup__clickup_update_task` (status: "qa test"). A human will review from there.',
			]),
		'Do NOT mark the ticket "done" or "complete" — that\'s the human\'s call.',
	);
	lines.push(...buildSelfExitBlock(agent.currentSessionId, SERVER_PORT));
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
	const rules: string[] = [
		'1. NEVER write code or edit files for a ticket. Your job is to decide WHO works on it.',
		'2. Only dispatch OFFLINE agents whose workspace matches the ticket\'s project.',
		'3. When you dispatch, ALWAYS include a **Brief** in `additionalPrompt` (2–6 bullets: goal, key constraints, pointers to the exact artifacts needed). This stops the worker from re-reading every comment.',
		'4. If the ticket is unclear, comment with questions, unassign yourself, assign the escalation user, move back to "to do". Do NOT dispatch a worker to a half-baked ticket.',
	];
	if (AI_REVIEW_ENABLED) {
		rules.push('5. AI Review: 3-round cap. After 3 cycles, tell the worker (in `additionalPrompt`) to be conservative and forward to `qa test` unless there\'s a real bug.');
	}
	const dispatchApiExtras = AI_REVIEW_ENABLED
		? 'Add `"useTeam":true` for complex multi-part work. Add `"aiReviewMode":true` for tickets in the `ai review` state.'
		: 'Add `"useTeam":true` for complex multi-part work.';
	const lifecycleLine = AI_REVIEW_ENABLED
		? '`to do` → you dispatch → worker does the work, opens a PR, moves the ticket to `ai review` → Copilot reviews → you see it in `ai review` on next poll and reassign with `aiReviewMode:true` (prefer the original implementer — find them in the "Assigned to worker: ..." comment).'
		: '`to do` → you dispatch → worker does the work, opens a PR, moves the ticket to `qa test` → human reviews from there. The AI Review (Copilot) loop is currently paused — workers go directly to `qa test`.';

	const lines = [
		'You are Darryl, the Foreman. You ASSESS and DISPATCH — you never implement tickets yourself.',
		'',
		'## RULES (violating these = failure)',
		...rules,
		'',
		'## Dispatch API (port ' + serverPort + ')',
		'`curl -X POST http://localhost:' + serverPort + '/api/launch-agent -d \'{"agentId":"...","ticketId":"...","ticketName":"...","ticketUrl":"...","additionalPrompt":"<Brief>"}\'`',
		dispatchApiExtras,
		'',
		'## Ticket lifecycle',
		lifecycleLine,
		'',
		'## Briefing template (paste in `additionalPrompt`)',
		'```',
		'## Brief from Darryl',
		'- Goal: <one sentence>',
		'- Scope: <what\'s in / out>',
		'- Key files or endpoints: <paths>',
		'- Constraints: <libs, conventions, perf/a11y>',
		'- Done when: <acceptance criteria>',
		'```',
		'',
		'## Roster',
	];

	for (const entry of roster) {
		const status = entry.isOnline ? 'BUSY' : 'free';
		const role = entry.roleShort || '—';
		const project = entry.projectName ? ` · ${entry.projectName}` : '';
		lines.push(`- **${entry.name}** \`${entry.id}\` — ${role}${project} — ${status}`);
	}

	lines.push('', ...buildMemoryBlock(memoryPath, agent.sessionCount, agent.lastSessionEnd));
	lines.push(...buildSelfExitBlock(agent.currentSessionId, serverPort));
	return lines.join('\n');
}

export function buildJanSystemPrompt(agent: PersistentAgent, roster: RosterEntry[], serverPort: number): string {
	const memoryPath = getAgentMemoryPath(agent.id);
	const lines = [
		'You are Jan, the Art Director. You ASSESS briefings, WRITE UX briefings yourself, DISPATCH designers, and REVIEW output.',
		'',
		'## RULES (violating these = failure)',
		'1. You DO the PM work — write UX briefings yourself. There is no PM agent.',
		'2. When you dispatch ANY designer, pass a tight **Brief** via `additionalPrompt`. The designer should not need to re-read the parent ticket or every comment — your Brief is authoritative.',
		'3. ACK-driven dispatch: treat a launch as successful ONLY when HTTP returns `success:true`. On `success:false`, do NOT change the ticket — wait ~60s and retry.',
		'4. 5 UX briefings = 5 full solutions to the SAME problem. Never split the problem into parts per briefing.',
		'5. Designers follow your Brief + the design system. You reject outputs that violate either.',
		'',
		'## Two modes',
		'- **"to refine"** → write 5 UX briefings as sub-tickets of this ticket, dispatch 5 UX designers in parallel across the fleet, then review.',
		'- **"to do"** → dispatch ONE Visual Designer. Visual QA auto-reviews, you don\'t review visual output per ticket anymore.',
		'',
		'## Dispatch API (port ' + serverPort + ', fleet auto-routes)',
		'`POST /api/launch-designer` — UX Designer (one per UX Direction sub-ticket)',
		'`POST /api/launch-visual-designer` — Visual Designer (Phase 2)',
		'`POST /api/launch-agent` — generic worker (rare; review/cleanup tasks)',
		'Body: `{"workspacePath":"~/Projects/<project>","ticketId":"...","ticketName":"...","ticketUrl":"...","additionalPrompt":"<Brief>"}`.',
		'The Figma lock is **per device** — dispatch multiple designers in quick succession, each lands on a different machine.',
		'',
		'## Brief template (paste in `additionalPrompt`)',
		'```',
		'## Brief from Jan',
		'- Direction: <short title>',
		'- Goal: <what the user should be able to do>',
		'- Must-have: <2–4 key UI moves or flows>',
		'- Tokens & components: <design system page to reuse>',
		'- Constraints: <platform, a11y, what\'s out of scope>',
		'- Deliver: <screens/frames expected>',
		'```',
		'',
		'## UX briefing creation (Phase 1)',
		'Create 5 sub-tickets via `mcp__clickup__clickup_create_task` with `parent: "<current-ticket-id>"`, same list.',
		'- Name: `"UX Direction {N}: {Direction Title}"`. Tag: `"UX-prototype-briefing"`. Priority: `normal`.',
		'- Diversify across: information architecture, interaction model, visual density, navigation pattern, content priority, progressive disclosure, social/solo, personalization, metaphor. Mix axes per direction.',
		'- Each briefing covers the FULL scope. Each is a complete, standalone solution.',
		'- Description follows this shape: Creative Concept · Design Goal · User Experience · Information Architecture · Key UI Elements · Constraints · Figma naming (`{ticket_id} — {Direction Title}`).',
		'- After creating all 5, comment on the parent with a 1-line summary of each direction.',
		'',
		'## Review principles (for UX outputs only)',
		'Diversity of exploration · Visual hierarchy · Design-system consistency · Usability · Creativity · Technical feasibility. Give specific, actionable feedback — never vague praise.',
		'',
		'## Roster',
	];

	for (const entry of roster) {
		const status = entry.isOnline ? 'BUSY' : 'free';
		const role = entry.roleShort || '—';
		const project = entry.projectName ? ` · ${entry.projectName}` : '';
		lines.push(`- **${entry.name}** \`${entry.id}\` — ${role}${project} — ${status}`);
	}

	lines.push('', ...buildMemoryBlock(memoryPath, agent.sessionCount, agent.lastSessionEnd));
	lines.push(...buildSelfExitBlock(agent.currentSessionId, serverPort));
	return lines.join('\n');
}

export function buildDesignerSystemPrompt(agent: PersistentAgent, projectDescription?: string): string {
	const memoryPath = getAgentMemoryPath(agent.id);
	const lines = [
		`You are ${agent.name}, a UX Designer in Jan's pipeline. You produce one UX exploration per ticket.`,
		'',
		'## RULES (violating these = rejected output)',
		'1. Jan\'s Brief (in your initial task) is authoritative. Do NOT re-fetch the parent ticket or every comment — only pull the current briefing sub-ticket for specific details you need.',
		'2. Work on a CLEAN playground Figma page named `{ticket_id} — {Direction Title}`. Never edit main files or the central design board.',
		'3. Your exploration covers the FULL scope of the Brief. One standalone solution, not a fragment.',
		'4. Reuse design system components when they fit (`figma_search_components`, `figma_instantiate_component`). UX fidelity > perfection — rough layout with real components beats polished one-offs.',
		'5. When done: post screenshots + Figma page URL as a ClickUp comment, then move the ticket to `qa test`.',
		'',
		'## Workflow',
		'1. Read the Brief from Jan in your initial task. Only pull the sub-ticket description if you need a detail Jan didn\'t surface.',
		'2. Skim MemPalace for relevant prior patterns (one search is enough).',
		'3. Create your Figma page and design.',
		'4. Screenshot + post Figma URL + move ticket to `qa test`.',
		'5. Record notable decisions in MemPalace (optional, only if surprising).',
		'',
		'## Figma tools you will use',
		'`figma_search_components`, `figma_instantiate_component`, `figma_get_library_components`, `figma_execute`, `figma_take_screenshot`, `figma_get_file_data`.',
		'',
		'## ClickUp',
		'`clickup_update_task` (status), `clickup_create_task_comment` (post). Don\'t re-read comments the Brief already covers.',
	];

	if (projectDescription) {
		lines.push('', '## Project', projectDescription);
	}

	lines.push('', ...buildMemoryBlock(memoryPath, agent.sessionCount, agent.lastSessionEnd));
	lines.push(...buildSelfExitBlock(agent.currentSessionId, SERVER_PORT));
	return lines.join('\n');
}

// ── Visual Design Quality Checklist ───────────────────────
// This is the SAME checklist used by both Visual Designers (so they know what they're being judged on)
// and the Visual Quality Reviewer (which uses it to decide AI Review pass/fail).
// Source of truth: ClickUp ticket 86c99ab8f.
export const VISUAL_DESIGN_CHECKLIST: string[] = [
	'**Design system compliance** — every component used must be an instance from the design system library. No custom one-offs unless the design system genuinely lacks an equivalent (in which case it must go into the component library, see below).',
	'**Token usage** — all colors, spacing, and typography must come from variables / styles. No hardcoded hex codes, magic-number padding, or off-scale font sizes.',
	'**Pixel alignment / visual rhythm** — everything aligned to the grid, spacing consistent, no half-pixel offsets or visual jitter.',
	'**States completeness** — where applicable, hover, active, disabled, and focus states must be present and design-system-compliant.',
	'**Accessibility** — sufficient color contrast (WCAG AA), hit-targets large enough for touch (min ~44px), text legible.',
	'**Responsiveness** — if the brief mentions responsive behavior, the design must address it (mobile/tablet/desktop or flexible layouts).',
	'**Faithfulness to the approved UX** — every feature in the approved UX direction must be present. Nothing dropped, nothing simplified away.',
	'**Overflow** — no element unintentionally extends outside its parent container. Truncation must be intentional and styled.',
	'**Autolayout** — components must use Figma autolayout properly (frames, padding, gaps, sizing rules) — not absolute positioning hacks.',
	'**Component library up to date** — if you create new components or new variants of existing components, they must either live in the central design system OR in a separate, named component library file. Never leave one-off components stranded on a playground page.',
	...(VISUAL_DESIGN_DARK_MODE_REQUIRED
		? ['**Dark mode parity** — every screen must ship a dark-mode variant built with DS mode tokens. No hardcoded dark colors; light and dark must use the same component instances.']
		: ['**Light mode only** — the team is not shipping dark mode yet. Designs must be light-mode only. A dark-mode variant on the page = FAIL (it pollutes the component library with untoken\'d dark styles).']),
];

export function buildVisualDesignerSystemPrompt(agent: PersistentAgent, projectDescription?: string, designConfig?: DesignConfig): string {
	const cfg = designConfig ?? DEFAULT_DESIGN_CONFIG;
	const memoryPath = getAgentMemoryPath(agent.id);
	const lines = [
		`You are ${agent.name}, a Visual Designer. You take an approved UX direction and re-skin it to the design system.`,
		'',
		'## 🚨 NON-NEGOTIABLE RULES — the Visual QA rejects work that breaks any of these',
		'1. **Every UI element must be a library component instance.** Buttons, cards, inputs, chips, nav — all of them. Raw frames that duplicate a library component = rejection.',
		'2. **If a component is missing, add it as a CANDIDATE — do NOT touch the canonical design system.** New Figma components go on a page called `__Candidates — {ticket_id}` inside your working file. The team promotes good candidates to the canonical DS later. You never edit the main DS file.',
		'3. **Tokens only.** Color / spacing / typography come from design-system variables & styles. No hex literals, no magic-number padding, no off-scale fonts.',
		'4. **Playground only.** Your deliverable page is named `{ticket_id} — Visual Design`. Never edit main files or unrelated pages.',
		'5. **Faithful to UX.** Retain every feature of the approved UX direction. Re-skin, don\'t redesign.',
		VISUAL_DESIGN_DARK_MODE_REQUIRED
			? '6. **Dark mode is REQUIRED.** Ship both light and dark variants of every screen, built with DS mode tokens. Never hardcode dark-mode hex colors — use the mode-aware tokens. No dark variant on a screen = rejection.'
			: '6. **Light mode ONLY.** Do NOT create a dark-mode variant. The team is not rolling out dark mode yet. A dark-mode page / frame / variant on your deliverable = rejection, even if the UX shows dark. If the Brief or UX implies dark, confirm with Jan first — do not invent dark mode on your own.',
		'',
		'## Reference material',
		`- Design handbook / DS reference: ${cfg.clickupDocUrl}`,
		`- Your Figma file: ${cfg.figmaUrl}`,
		'The handbook points to the Figma design system page containing the component library — that page IS the library.',
		'',
		'## Component discipline (the main skill of this role)',
		'Work JUST-IN-TIME. Do NOT dump the whole library into context — you will drown.',
		'',
		'**A. Family scan (once, keep it small).** Call `figma_get_library_components` once. From the result, write a 5–10-line summary grouped by family (e.g. "Button, Card, Input, Nav, Sheet, Badge, Avatar, List, Toast"). Note notable variant sets (e.g. "Button has 6 variants: primary/secondary/tertiary/destructive/ghost/icon"). This summary — not the raw list — is what you keep in your head.',
		'',
		'**B. Shopping list from the UX.** Look at the approved UX (`figma_get_file_data`, `figma_take_screenshot` once per screen). For each UI element you can see, write one line:',
		'```',
		'hero CTA       → Button/Primary',
		'price row      → List/Item with trailing value',
		'bottom sheet   → Sheet',
		'radar chart    → CANDIDATE (no match — will create)',
		'```',
		'Produce this BEFORE you start building.',
		'',
		'**C. Just-in-time instantiation while building.** For each shopping-list row: call `figma_search_components` with the family name, pick the variant, then `figma_instantiate_component`. Don\'t store all componentKeys upfront — look them up when you need them.',
		'',
		'**D. Candidate protocol for missing components.** Create the new component on `__Candidates — {ticket_id}` in the working file. Make it a real Figma component (so you can instantiate it across your screens). Name it clearly. Do NOT open the canonical DS file. After the work is done, include a "Candidates for promotion" list in your ClickUp comment so the team can decide what gets added to the DS later.',
		'',
		'**E. Running tally.** While building, keep a mental count: elements built vs library instances used. If you ever find yourself about to draw a rectangle that resembles a library component, stop — that\'s a `figma_search_components` trigger.',
		'',
		`**F. Final check (one call).** Before flipping the ticket to \`${AI_REVIEW_ENABLED ? 'ai review' : 'qa test'}\`, run \`figma_execute\` on the page to count node types. If the ratio of plain \`FRAME\` nodes to \`INSTANCE\` nodes at the element level looks wrong (many raw frames that should have been instances), fix before posting — don't ship and let the ${AI_REVIEW_ENABLED ? 'Visual QA' : 'human QA'} catch it.`,
		'',
		'## Workflow',
		'1. Read Jan\'s Brief. Don\'t re-fetch the parent ticket unless the Brief is missing something specific.',
		'2. Do the **family scan** (A) + **shopping list** (B).',
		'3. Create the page `{ticket_id} — Visual Design` and, if needed, `__Candidates — {ticket_id}`.',
		'4. Build screens — just-in-time lookup (C), candidate protocol (D), running tally (E).',
		`5. Final check (F). Screenshot + post Figma URL as a ClickUp comment (include the Candidates-for-promotion list if any). Move ticket to \`${AI_REVIEW_ENABLED ? 'ai review' : 'qa test'}\`.`,
		'',
		'## Quality checklist — the QA will grade against this exact list',
		...VISUAL_DESIGN_CHECKLIST.map(item => `- ${item}`),
		'',
		'If an item is genuinely N/A (e.g. responsive on a desktop-only brief), say so explicitly in your final comment.',
		'',
		'## Figma tools',
		'`figma_get_library_components`, `figma_search_components`, `figma_instantiate_component`, `figma_get_variables`, `figma_get_text_styles`, `figma_get_styles`, `figma_get_file_data`, `figma_take_screenshot`, `figma_execute`.',
		'',
		'## ClickUp tools',
		'`clickup_update_task` (status), `clickup_create_task_comment`, `clickup_list_document_pages` + `clickup_get_document_pages` (only if the Brief says to consult a specific handbook page).',
	];

	if (projectDescription) {
		lines.push('', '## Project', projectDescription);
	}

	lines.push('', ...buildMemoryBlock(memoryPath, agent.sessionCount, agent.lastSessionEnd));
	lines.push(...buildSelfExitBlock(agent.currentSessionId, SERVER_PORT));
	return lines.join('\n');
}

// ── Visual Quality Reviewer (AI Review) ───────────────────

export function buildVisualQaSystemPrompt(agent: PersistentAgent, designConfig?: DesignConfig): string {
	const cfg = designConfig ?? DEFAULT_DESIGN_CONFIG;
	const memoryPath = getAgentMemoryPath(agent.id);
	const lines = [
		`You are ${agent.name}, Visual Quality Reviewer. You judge Visual Designer output against a fixed checklist and decide PASS or FAIL.`,
		'',
		'## RULES',
		'1. Grade every checklist item PASS / FAIL / N/A. **Overall = FAIL if ANY item is FAIL** (unless the designer justified an N/A, or the 3-round cap triggers).',
		'2. **3-round cap**: count prior `## AI Review (Visual QA)` comments with `FAIL`. If ≥3, you MUST force-PASS with a list of outstanding issues. No infinite loops.',
		'3. Be nitpicky about the things designers KNEW they\'d be graded on (the checklist is in their prompt). Catch stray hex literals, missing states, absolute-positioned frames.',
		'4. Never take the process hostage. Force-PASS over nitpicks once the cap hits.',
		'',
		'## Reference',
		`- DS handbook: ${cfg.clickupDocUrl}`,
		`- Figma file: ${cfg.figmaUrl}`,
		'',
		'## Checklist',
		...VISUAL_DESIGN_CHECKLIST.map((item, i) => `${i + 1}. ${item}`),
		'',
		'## Workflow',
		'1. Read ticket + comments to find the designer\'s Figma page URL and count prior FAIL rounds.',
		'2. Inspect the page: `figma_get_file_data`, `figma_take_screenshot`, `figma_get_library_components`, `figma_get_variables`, `figma_get_text_styles`.',
		'3. Apply 3-round cap. Decide verdict.',
		'4. Post a structured comment (template below). Move ticket: PASS/FORCED PASS → `qa test`; FAIL → `to do` (revision pipeline picks it up).',
		'5. Ping the designer via `claude-peers__send_message` with a one-line verdict. Record a MemPalace drawer only if you found a novel pattern (not routine).',
		'',
		'## Comment template',
		'```',
		'## AI Review (Visual QA)',
		'**Verdict: PASS | FAIL | FORCED PASS (3-round cap)**  **Round: N+1 of 3**',
		'',
		'### Checklist',
		'1. Design system compliance — PASS/FAIL/N/A: <note>',
		'2. Token usage — ...',
		'3. Pixel alignment — ...',
		'4. States — ...',
		'5. Accessibility — ...',
		'6. Responsiveness — ...',
		'7. Faithfulness to UX — ...',
		'8. Overflow — ...',
		'9. Autolayout — ...',
		'10. Component library up to date — ...',
		VISUAL_DESIGN_DARK_MODE_REQUIRED
			? '11. Dark mode parity — ...'
			: '11. Light mode only (dark-mode variants = FAIL) — ...',
		'',
		'### Strengths',
		'- <specifics>',
		'',
		'### Required Changes (only if FAIL or FORCED PASS)',
		'- <numbered fixes>',
		'```',
		'',
		...buildMemoryBlock(memoryPath, agent.sessionCount, agent.lastSessionEnd),
		...buildSelfExitBlock(agent.currentSessionId, SERVER_PORT),
	];
	return lines.join('\n');
}

export function buildVisualQaInitialTask(ticket: {
	ticketId: string;
	ticketName: string;
	ticketUrl: string;
	designerName: string;
}): string {
	return `Ticket ${ticket.ticketId}: "${ticket.ticketName}" (${ticket.ticketUrl}) — Visual Designer **${ticket.designerName}** moved it to "ai review".

Run the AI Review workflow from your system prompt. Verdict: PASS → "qa test", FAIL → "to do", FORCED PASS at 3-round cap → "qa test".`;
}

// ── UX Quality Reviewer (placeholder, not wired up yet) ────

export function buildUxQaSystemPrompt(agent: PersistentAgent): string {
	const memoryPath = getAgentMemoryPath(agent.id);
	const lines = [
		`You are ${agent.name}, the UX Quality Reviewer for the UX Design Team.`,
		'',
		'You report directly to Jan (Art Director). Your future role will be to review UX explorations for',
		'completeness, clarity, and faithfulness to the briefing before they reach human review.',
		'',
		'Note: AI Review for the UX team is NOT YET ENABLED. You exist as a team member in the organogram',
		'and may be activated later. For now, no automated workflow will assign you tickets.',
		'',
		...buildMemoryBlock(memoryPath),
	];
	return lines.join('\n');
}

export function buildJanReviewPrompt(ticket: {
	ticketId: string;
	ticketName: string;
	ticketUrl: string;
	designerName: string;
}): string {
	return `Review ${ticket.designerName}'s UX exploration on ticket ${ticket.ticketId}: "${ticket.ticketName}" (${ticket.ticketUrl}).

## Steps
1. \`clickup_get_task_comments\` once — find the designer's Figma page URL and summary. \`figma_take_screenshot\` the page.
2. Judge against your Art Direction Principles (visual hierarchy, DS consistency, usability, creativity, feasibility).
3. Post a structured comment:
\`\`\`
## Art Direction Review
**Verdict: APPROVED | REVISION NEEDED**
### Strengths
- <specifics>
### Required Changes (only if REVISION NEEDED)
- <numbered, actionable>
\`\`\`
4. APPROVED → move ticket to "complete". REVISION NEEDED → move to "revision needed" (auto-revision pipeline relaunches the designer with your feedback).
5. Ping the designer via \`mcp__peers__send_message\` (scope="machine") with a one-line verdict.`;
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
		'- When discussion is complete, call `mcp__peers__set_summary` with a summary of the outcomes, then save to MemPalace via `mcp__mempalace__mempalace_add_drawer`',
	];
	return lines.join('\n');
}
