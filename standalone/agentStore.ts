import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import {
	MEMPALACE_SERVER_PORT,
	DESIGNER_ROLE_SHORT,
	VISUAL_DESIGNER_ROLE_SHORT,
	UX_QA_ROLE_SHORT,
	VISUAL_QA_ROLE_SHORT,
	TEAM_UX_ID,
	TEAM_VISUAL_ID,
	TEAM_WORKER_COUNT,
	JAN_ROLE_SHORT,
	JAN_WORKSPACE,
	DEFAULT_DESIGN_FIGMA_URL,
	DEFAULT_DESIGN_CLICKUP_DOC_URL,
	DEFAULT_DESIGN_EXAMPLES_URL,
} from './constants.js';
import { writeJson } from './serverHelpers.js';
import { getDb } from '../src/db/client.js';
import { persistentAgents as agentsTable } from '../src/db/schema.js';
import { getActiveBuildingId, tryGetActiveBuildingId } from '../src/db/activeBuilding.js';

const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
const AGENTS_DIR = path.join(SETTINGS_DIR, 'agents');

export interface DesignConfig {
	figmaUrl: string;
	clickupDocUrl: string;
	examplesUrl: string;
}

export const DEFAULT_DESIGN_CONFIG: DesignConfig = {
	figmaUrl: DEFAULT_DESIGN_FIGMA_URL,
	clickupDocUrl: DEFAULT_DESIGN_CLICKUP_DOC_URL,
	examplesUrl: DEFAULT_DESIGN_EXAMPLES_URL,
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
// agents are retired in loadPersistentAgents(): they are tagged `retired: true`
// so seedDesignTeams won't recreate them and the launch pickers ignore them.
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

// In-memory cache of agents for the active building. Loaded once at boot via
// initAgentStore(); subsequent loadPersistentAgents() calls return the cache.
// Mutations go through savePersistentAgents() which rewrites the cache and
// flushes the full set to the DB (matches the previous JSON-write-everything
// pattern; we can switch to per-row upserts later if it gets slow).
let agentCache: PersistentAgent[] = [];

function rowToAgent(r: typeof agentsTable.$inferSelect): PersistentAgent {
	return {
		id: r.id,
		name: r.name,
		roleShort: r.roleShort,
		roleFull: r.roleFull,
		workspacePath: r.workspacePath,
		teamId: r.teamId ?? undefined,
		reportsToId: r.reportsToId ?? undefined,
		palette: r.palette ?? undefined,
		hueShift: r.hueShift ?? undefined,
		seatId: r.seatId ?? undefined,
		currentSessionId: r.currentSessionId ?? undefined,
		lastSessionEnd: r.lastSessionEnd ?? undefined,
		sessionCount: r.sessionCount ?? undefined,
		currentTicketId: r.currentTicketId ?? undefined,
		currentTicketName: r.currentTicketName ?? undefined,
		currentTicketUrl: r.currentTicketUrl ?? undefined,
		lastTicketId: r.lastTicketId ?? undefined,
		retired: r.retired ?? undefined,
	};
}

function agentToRow(a: PersistentAgent, buildingId: string): typeof agentsTable.$inferInsert {
	return {
		id: a.id,
		buildingId,
		name: a.name,
		roleShort: a.roleShort,
		roleFull: a.roleFull,
		workspacePath: a.workspacePath,
		teamId: a.teamId ?? null,
		reportsToId: a.reportsToId ?? null,
		palette: a.palette ?? null,
		hueShift: a.hueShift ?? null,
		seatId: a.seatId ?? null,
		currentSessionId: a.currentSessionId ?? null,
		lastSessionEnd: a.lastSessionEnd ?? null,
		sessionCount: a.sessionCount ?? null,
		currentTicketId: a.currentTicketId ?? null,
		currentTicketName: a.currentTicketName ?? null,
		currentTicketUrl: a.currentTicketUrl ?? null,
		lastTicketId: a.lastTicketId ?? null,
		retired: a.retired ?? null,
	};
}

export async function initAgentStore(): Promise<void> {
	const db = getDb();
	const buildingId = getActiveBuildingId();
	const rows = await db.select().from(agentsTable).where(eq(agentsTable.buildingId, buildingId));
	agentCache = rows.map(rowToAgent);
}

/**
 * Direct DB read for a specific building, bypassing the active-building cache.
 * Used by boot-time team seeding which runs against every building.
 */
export async function loadPersistentAgentsForBuilding(buildingId: string): Promise<PersistentAgent[]> {
	const db = getDb();
	const rows = await db.select().from(agentsTable).where(eq(agentsTable.buildingId, buildingId));
	return rows.map(rowToAgent);
}

/**
 * Direct DB write for a specific building. If `buildingId` is the active
 * building, the cache is also refreshed so subsequent loadPersistentAgents()
 * sees the changes.
 */
export async function savePersistentAgentsForBuilding(buildingId: string, agents: PersistentAgent[]): Promise<void> {
	const db = getDb();
	const rows = agents.map(a => agentToRow(a, buildingId));
	await db.transaction(async (tx) => {
		await tx.delete(agentsTable).where(eq(agentsTable.buildingId, buildingId));
		if (rows.length > 0) {
			for (let i = 0; i < rows.length; i += 200) {
				await tx.insert(agentsTable).values(rows.slice(i, i + 200));
			}
		}
	});
	if (buildingId === tryGetActiveBuildingId()) {
		agentCache = agents;
	}
}

export function loadPersistentAgents(): PersistentAgent[] {
	return agentCache;
}

export function savePersistentAgents(agents: PersistentAgent[]): void {
	agentCache = agents;
	const buildingId = tryGetActiveBuildingId();
	if (!buildingId) {
		// Not initialized (e.g. unit tests that exercise pure in-memory logic).
		// Cache update happened above; durable write is skipped.
		return;
	}
	const db = getDb();
	const rows = agents.map(a => agentToRow(a, buildingId));
	// Fire-and-forget: cache is the source of truth in memory; DB write is
	// durable persistence. Errors are logged but don't block the caller.
	(async () => {
		try {
			await db.transaction(async (tx) => {
				await tx.delete(agentsTable).where(eq(agentsTable.buildingId, buildingId));
				if (rows.length > 0) {
					for (let i = 0; i < rows.length; i += 200) {
						await tx.insert(agentsTable).values(rows.slice(i, i + 200));
					}
				}
			});
		} catch (err) {
			console.error('[agentStore] Failed to persist agents:', err);
		}
	})();
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
