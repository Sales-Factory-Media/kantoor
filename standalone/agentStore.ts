import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { eq, inArray, and, ne } from 'drizzle-orm';
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

/**
 * One live session (= one iTerm tab / task) an agent is running. An agent can
 * hold several of these concurrently (see PersistentAgent.currentSessions).
 */
export interface AgentSession {
	sessionId: string;
	ticketId?: string;
	ticketName?: string;
	ticketUrl?: string;
}

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
	/**
	 * Primary live session — a MIRROR of `currentSessions[0]`. Kept so the many
	 * "is this agent online / busy" / orchestrator-singleton readers can stay a
	 * simple truthy check. Always kept in sync via addAgentSession /
	 * removeAgentSession / pruneDeadSessions. `currentSessions` is authoritative.
	 */
	currentSessionId?: string;
	/** All concurrent live sessions (one per task/tab). Empty/undefined = idle. */
	currentSessions?: AgentSession[];
	lastSessionEnd?: string;
	sessionCount?: number;
	currentTicketId?: string;     // mirror of currentSessions[0].ticketId
	currentTicketName?: string;   // mirror of currentSessions[0].ticketName
	currentTicketUrl?: string;    // mirror of currentSessions[0].ticketUrl
	lastTicketId?: string;
	retired?: boolean;        // archived role — kept for memory, never launched
	avatarConfig?: string;    // DiceBear pixel-art combo as a JSON string ({ seed, options? })
}

// ── Multi-session helpers ──────────────────────────────────────
// One PersistentAgent can run N concurrent sessions. `currentSessions` is the
// authoritative list; the scalar currentSessionId/currentTicket* fields mirror
// the primary (first) entry so legacy readers keep working unchanged.

/** Re-derive the scalar mirror fields from the primary session. */
function syncSessionMirror(pa: PersistentAgent): void {
	const primary = pa.currentSessions?.[0];
	pa.currentSessionId = primary?.sessionId;
	pa.currentTicketId = primary?.ticketId;
	pa.currentTicketName = primary?.ticketName;
	pa.currentTicketUrl = primary?.ticketUrl;
}

/** All live session ids of an agent (array-aware, with legacy scalar fallback). */
export function agentSessionIds(pa: PersistentAgent): string[] {
	if (pa.currentSessions && pa.currentSessions.length > 0) {
		return pa.currentSessions.map(s => s.sessionId);
	}
	return pa.currentSessionId ? [pa.currentSessionId] : [];
}

/** How many concurrent sessions/tasks this agent is currently running. */
export function agentSessionCount(pa: PersistentAgent): number {
	return agentSessionIds(pa).length;
}

/** Find the agent that owns a given live session id (array-aware). */
export function findAgentBySessionId(agents: PersistentAgent[], sessionId: string): PersistentAgent | undefined {
	return agents.find(pa => agentSessionIds(pa).includes(sessionId));
}

/** Attach a new live session (a concurrent task) to an agent. Idempotent. */
export function addAgentSession(pa: PersistentAgent, session: AgentSession): void {
	if (!pa.currentSessions) pa.currentSessions = [];
	if (!pa.currentSessions.some(s => s.sessionId === session.sessionId)) {
		pa.currentSessions.push(session);
	}
	syncSessionMirror(pa);
}

/**
 * Remove one session by id. Returns the removed entry (so callers can release
 * its ticket / record history). Re-syncs the scalar mirror afterwards.
 */
export function removeAgentSession(pa: PersistentAgent, sessionId: string): AgentSession | undefined {
	let removed: AgentSession | undefined;
	if (pa.currentSessions) {
		const idx = pa.currentSessions.findIndex(s => s.sessionId === sessionId);
		if (idx >= 0) {
			removed = pa.currentSessions[idx];
			pa.currentSessions.splice(idx, 1);
		}
	}
	// Legacy: a scalar-only session never mirrored into the array.
	if (!removed && pa.currentSessionId === sessionId) {
		removed = {
			sessionId,
			ticketId: pa.currentTicketId,
			ticketName: pa.currentTicketName,
			ticketUrl: pa.currentTicketUrl,
		};
	}
	syncSessionMirror(pa);
	return removed;
}

/**
 * Drop any sessions that aren't in `liveIds` (e.g. stale refs after a restart
 * or building switch). Returns true if anything changed.
 */
export function pruneDeadSessions(pa: PersistentAgent, liveIds: Set<string>): boolean {
	const before = agentSessionCount(pa);
	// Normalize legacy scalar-only into the array first so we operate uniformly.
	if ((!pa.currentSessions || pa.currentSessions.length === 0) && pa.currentSessionId) {
		pa.currentSessions = [{
			sessionId: pa.currentSessionId,
			ticketId: pa.currentTicketId,
			ticketName: pa.currentTicketName,
			ticketUrl: pa.currentTicketUrl,
		}];
	}
	pa.currentSessions = (pa.currentSessions ?? []).filter(s => liveIds.has(s.sessionId));
	syncSessionMirror(pa);
	return agentSessionCount(pa) !== before;
}

/**
 * An agent with no job title AND no job description is treated as new/unknown:
 * it was minted provisionally for a freshly-discovered session and the user
 * hasn't said who it is yet. Such agents still need the "who's this?" popup
 * (including across a server restart, since the provisional row was persisted).
 */
export function isUnidentified(pa: PersistentAgent): boolean {
	return !pa.roleShort?.trim() && !pa.roleFull?.trim();
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
		// Normalize: if the DB row predates currentSessions, synthesize it from
		// the legacy scalar so the rest of the code always sees the array form.
		currentSessions: (r.currentSessions && r.currentSessions.length > 0)
			? r.currentSessions
			: (r.currentSessionId
				? [{
					sessionId: r.currentSessionId,
					ticketId: r.currentTicketId ?? undefined,
					ticketName: r.currentTicketName ?? undefined,
					ticketUrl: r.currentTicketUrl ?? undefined,
				}]
				: undefined),
		lastSessionEnd: r.lastSessionEnd ?? undefined,
		sessionCount: r.sessionCount ?? undefined,
		currentTicketId: r.currentTicketId ?? undefined,
		currentTicketName: r.currentTicketName ?? undefined,
		currentTicketUrl: r.currentTicketUrl ?? undefined,
		lastTicketId: r.lastTicketId ?? undefined,
		retired: r.retired ?? undefined,
		avatarConfig: r.avatarConfig ?? undefined,
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
		currentSessions: (a.currentSessions && a.currentSessions.length > 0) ? a.currentSessions : null,
		lastSessionEnd: a.lastSessionEnd ?? null,
		sessionCount: a.sessionCount ?? null,
		currentTicketId: a.currentTicketId ?? null,
		currentTicketName: a.currentTicketName ?? null,
		currentTicketUrl: a.currentTicketUrl ?? null,
		lastTicketId: a.lastTicketId ?? null,
		retired: a.retired ?? null,
		avatarConfig: a.avatarConfig ?? null,
	};
}

/**
 * Defensive: collapse a list of persistent agents to one-per-id, last-wins.
 * The PK on `persistent_agents.id` is global (single column), so the same
 * id appearing twice will trip a constraint violation on save. We've seen
 * legacy data + race-prone seed paths leave duplicates in the in-memory
 * cache; dedup here so the cache is always sane regardless of how it got
 * loaded. Logs a warning when duplicates are found.
 */
export function dedupePersistentAgentsById(agents: PersistentAgent[]): PersistentAgent[] {
	const byId = new Map<string, PersistentAgent>();
	let droppedCount = 0;
	for (const a of agents) {
		if (byId.has(a.id)) droppedCount++;
		byId.set(a.id, a);
	}
	if (droppedCount > 0) {
		console.warn(`[agentStore] Dropped ${droppedCount} duplicate persistent agent(s) (same id).`);
	}
	return [...byId.values()];
}

export async function initAgentStore(): Promise<void> {
	const db = getDb();
	const buildingId = getActiveBuildingId();
	const rows = await db.select().from(agentsTable).where(eq(agentsTable.buildingId, buildingId));
	agentCache = dedupePersistentAgentsById(rows.map(rowToAgent));
}

/**
 * Direct DB read for a specific building, bypassing the active-building cache.
 * Used by boot-time team seeding which runs against every building.
 */
export async function loadPersistentAgentsForBuilding(buildingId: string): Promise<PersistentAgent[]> {
	const db = getDb();
	const rows = await db.select().from(agentsTable).where(eq(agentsTable.buildingId, buildingId));
	return dedupePersistentAgentsById(rows.map(rowToAgent));
}

// Per-building save serializer. Concurrent fire-and-forget save calls
// (e.g. scanner's onNewSession firing in rapid succession during boot)
// would otherwise race each other's `DELETE buildingId=X; INSERT` and
// produce PK-violation errors when the second insert hits rows the first
// just wrote. Each building's saves are chained on a Promise.
const saveQueues = new Map<string, Promise<unknown>>();

/**
 * Direct DB write for a specific building. If `buildingId` is the active
 * building, the cache is also refreshed so subsequent loadPersistentAgents()
 * sees the changes.
 *
 * The PK on `persistent_agents.id` is global (single column). If any agent's
 * id collides with a row in a DIFFERENT building, the insert would fail with
 * a unique-constraint violation and abort the whole save. To stay resilient
 * against legacy data corruption (cross-building id duplicates from earlier
 * buggy versions), we filter such collisions out and log a warning; the
 * surviving row in the other building is left untouched. The user can
 * inspect/clean those up manually with the diagnostic SQL in the comment
 * at the end of this file.
 *
 * All writes for the same building are serialized through a per-building
 * Promise chain so concurrent calls cannot race each other.
 */
export async function savePersistentAgentsForBuilding(buildingId: string, agents: PersistentAgent[]): Promise<void> {
	const prev = saveQueues.get(buildingId) ?? Promise.resolve();
	const next = prev
		.catch(() => {})
		.then(() => doSavePersistentAgentsForBuilding(buildingId, agents));
	saveQueues.set(buildingId, next);
	return next;
}

async function doSavePersistentAgentsForBuilding(buildingId: string, agents: PersistentAgent[]): Promise<void> {
	const db = getDb();
	const deduped = dedupePersistentAgentsById(agents);
	const colliding = await findCrossBuildingIdCollisions(db, buildingId, deduped.map(a => a.id));
	const safe = colliding.size > 0
		? deduped.filter(a => {
			if (colliding.has(a.id)) {
				console.warn(`[agentStore] Skipping save of agent ${a.id} ("${a.name}") — id already exists in another building. Run the cleanup SQL at the bottom of agentStore.ts.`);
				return false;
			}
			return true;
		})
		: deduped;
	const rows = safe.map(a => agentToRow(a, buildingId));
	await db.transaction(async (tx) => {
		await tx.delete(agentsTable).where(eq(agentsTable.buildingId, buildingId));
		if (rows.length > 0) {
			for (let i = 0; i < rows.length; i += 200) {
				await tx.insert(agentsTable).values(rows.slice(i, i + 200));
			}
		}
	});
	if (buildingId === tryGetActiveBuildingId()) {
		agentCache = safe;
	}
}

async function findCrossBuildingIdCollisions(
	db: ReturnType<typeof getDb>,
	currentBuildingId: string,
	candidateIds: string[],
): Promise<Set<string>> {
	if (candidateIds.length === 0) return new Set();
	const colliding = new Set<string>();
	// Chunk to stay well below Postgres' ~32k parameter limit.
	for (let i = 0; i < candidateIds.length; i += 500) {
		const slice = candidateIds.slice(i, i + 500);
		const rows = await db
			.select({ id: agentsTable.id })
			.from(agentsTable)
			.where(and(
				inArray(agentsTable.id, slice),
				ne(agentsTable.buildingId, currentBuildingId),
			));
		for (const r of rows) colliding.add(r.id);
	}
	return colliding;
}

export function loadPersistentAgents(): PersistentAgent[] {
	return agentCache;
}

export function savePersistentAgents(agents: PersistentAgent[]): void {
	const deduped = dedupePersistentAgentsById(agents);
	agentCache = deduped;
	const buildingId = tryGetActiveBuildingId();
	if (!buildingId) {
		// Not initialized (e.g. unit tests that exercise pure in-memory logic).
		// Cache update happened above; durable write is skipped.
		return;
	}
	// Fire-and-forget durable write — cache is the source of truth in memory.
	// Errors are logged but don't block the caller. Delegate to the per-building
	// path so the cross-building-collision defense applies here too.
	(async () => {
		try {
			await savePersistentAgentsForBuilding(buildingId, deduped);
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

// ─────────────────────────────────────────────────────────────────────────
// Diagnostic SQL for cross-building / duplicate-id agent corruption
// ─────────────────────────────────────────────────────────────────────────
//
// Saves automatically skip ids that collide with rows in another building
// (see `savePersistentAgentsForBuilding`). If you see those warnings, run
// these against the database to inspect and clean up. The runtime will
// always tolerate the corruption, but skipping means writes silently lose
// the conflicting row's updates until the duplicate is resolved.
//
// 1. Find ids that exist in more than one building:
//
//     SELECT id, COUNT(*) AS cnt, array_agg(building_id::text) AS buildings,
//            array_agg(name) AS names
//     FROM persistent_agents
//     GROUP BY id
//     HAVING COUNT(*) > 1;
//
// 2. Inspect a specific id across buildings:
//
//     SELECT id, building_id, name, role_short, workspace_path,
//            current_session_id, last_session_end
//     FROM persistent_agents
//     WHERE id = '<the-id>';
//
// 3. Delete the duplicate from whichever building doesn't own it
//    (replace <building_id> with the building you want to clear FROM):
//
//     DELETE FROM persistent_agents
//     WHERE id = '<the-id>' AND building_id = '<building_id>';
//
// 4. Find duplicate NAMES within a single building (different ids, same
//    name — the "duplicate agents per project" symptom):
//
//     SELECT building_id, name, COUNT(*) AS cnt, array_agg(id) AS ids
//     FROM persistent_agents
//     GROUP BY building_id, name
//     HAVING COUNT(*) > 1;
