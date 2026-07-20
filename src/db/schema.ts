import {
	pgTable,
	uuid,
	text,
	jsonb,
	timestamp,
	integer,
	bigint,
	boolean,
	primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * A building represents one company / workspace context. Each building has
 * its own connector (e.g. ClickUp or GitHub) and its own org chart, agents,
 * worker assignments, etc. The webview shows one building at a time and
 * users switch via the top-left dropdown.
 */
export const buildings = pgTable('buildings', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(), // e.g. 'vibelab', 'pc'
	name: text('name').notNull(),          // display name
	connectorType: text('connector_type').notNull(), // 'clickup' | 'github'
	/**
	 * Connector-specific config. For ClickUp: { apiToken, listId }. For GitHub:
	 * { token, owner, repo }. Schema is intentionally loose — connector
	 * implementations validate their own config.
	 */
	connectorConfig: jsonb('connector_config').$type<Record<string, unknown>>().notNull().default({}),
	sortOrder: integer('sort_order').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const persistentAgents = pgTable('persistent_agents', {
	id: text('id').primaryKey(), // existing UUIDs from agents.json
	buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	roleShort: text('role_short').notNull().default(''),
	roleFull: text('role_full').notNull().default(''),
	workspacePath: text('workspace_path').notNull().default(''),
	teamId: text('team_id'),
	reportsToId: text('reports_to_id'),
	palette: integer('palette'),
	hueShift: integer('hue_shift'),
	seatId: text('seat_id'),
	// Primary live session (mirror of currentSessions[0]). Kept for the many
	// "is this agent online / busy" readers that only care whether ANY session
	// is running. The authoritative multi-session list is `currentSessions`.
	currentSessionId: text('current_session_id'),
	// All concurrent live sessions for this agent (one per iTerm tab / task).
	// One PersistentAgent can run N tasks at once; each entry carries its own
	// optional ticket. Null/empty when the agent is idle.
	currentSessions: jsonb('current_sessions').$type<Array<{ sessionId: string; ticketId?: string; ticketName?: string; ticketUrl?: string }>>(),
	lastSessionEnd: text('last_session_end'),
	sessionCount: integer('session_count'),
	currentTicketId: text('current_ticket_id'),
	currentTicketName: text('current_ticket_name'),
	currentTicketUrl: text('current_ticket_url'),
	lastTicketId: text('last_ticket_id'),
	retired: boolean('retired'),
	// DiceBear pixel-art avatar "combo" for this employee, stored as a JSON
	// string ({ seed, options? }). Null until the user picks a face in the
	// identify popup / employee file.
	avatarConfig: text('avatar_config'),
});

/**
 * Seat metadata keyed by sessionId. Stored as opaque JSON because the
 * webview owns the schema (it's just visual state — palette, hueShift,
 * seatId, role labels, etc.) and we never query into it server-side.
 */
export const seats = pgTable('seats', {
	buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
	sessionId: text('session_id').notNull(),
	data: jsonb('data').$type<Record<string, unknown>>().notNull(),
}, (t) => ({
	pk: primaryKey({ columns: [t.buildingId, t.sessionId] }),
}));

/**
 * Global pool of known projects (codebases). Identified uniquely by their
 * absolute workspace path. The same project can be associated with multiple
 * buildings via the `building_projects` junction.
 *
 * Replaces the old `known_projects` table which was building-scoped — that
 * table is dropped in migration 0001 after the rows are folded into here.
 */
export const projects = pgTable('projects', {
	id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
	name: text('name').notNull(),
	workspacePath: text('workspace_path').notNull().unique(),
	description: text('description'),
	/** Optional project logo as a data URI (e.g. data:image/png;base64,...).
	 *  Rendered in front of the project name in the sidebar and on agent cards. */
	logo: text('logo'),
});

/**
 * Many-to-many membership: which projects belong to which buildings. A
 * project may live in zero or more buildings. Removing the row just removes
 * the membership; the project itself stays in the global pool.
 */
export const buildingProjects = pgTable('building_projects', {
	buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
	projectId: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
}, (t) => ({
	pk: primaryKey({ columns: [t.buildingId, t.projectId] }),
}));

/**
 * Durable session → agent ownership. The JSONL file at
 * ~/.claude/projects/<hash>/<sessionId>.jsonl is conceptually owned by exactly
 * one PersistentAgent for life. Independent of `persistent_agents.current_sessions`
 * (which is "what's live right now") so that a transient `ps aux` failure or
 * an aggressive prune cannot break the binding — `onNewSession` consults this
 * table before minting a duplicate provisional employee.
 */
export const sessionHistory = pgTable('session_history', {
	sessionId: text('session_id').primaryKey(),
	agentId: text('agent_id')
		.notNull()
		.references(() => persistentAgents.id, { onDelete: 'cascade' }),
	buildingId: uuid('building_id')
		.notNull()
		.references(() => buildings.id, { onDelete: 'cascade' }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workerAssignments = pgTable('worker_assignments', {
	id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
	buildingId: uuid('building_id').notNull().references(() => buildings.id, { onDelete: 'cascade' }),
	ticketId: text('ticket_id').notNull(),
	ticketName: text('ticket_name').notNull(),
	worker: text('worker').notNull(),
	workerHost: text('worker_host').notNull(),
	startedAt: text('started_at').notNull(),
	status: text('status').notNull(), // 'in_progress' | 'completed' | 'failed'
});

/**
 * Global app settings (not building-scoped). Currently: soundEnabled,
 * janDesignConfig, and any other UI toggles that apply across buildings.
 */
export const appSettings = pgTable('app_settings', {
	key: text('key').primaryKey(),
	value: jsonb('value').$type<unknown>().notNull(),
});

/**
 * Auto Mode pending delegations — Darryl's classification results awaiting a
 * human's Start/Discard/Postpone decision. Previously in-memory only (lost on
 * restart); persisted here so recommendations survive a hub reboot.
 *
 * `lastEvaluatedAt` records when Darryl last classified the ticket and
 * `ticketUpdatedAt` snapshots the connector's date_updated at that moment. When
 * the ticket is updated after evaluation, auto-pickup re-classifies it (a stale
 * recommendation shouldn't outlive the ticket it was made against). Keyed by
 * ticket id (globally unique across connectors).
 */
export const pendingDelegations = pgTable('pending_delegations', {
	ticketId: text('ticket_id').primaryKey(),
	buildingId: uuid('building_id').references(() => buildings.id, { onDelete: 'cascade' }),
	ticketName: text('ticket_name').notNull().default(''),
	ticketUrl: text('ticket_url').notNull().default(''),
	recommendedAgentId: text('recommended_agent_id').notNull(),
	recommendedAgentName: text('recommended_agent_name').notNull().default(''),
	recommendedAgentRole: text('recommended_agent_role').notNull().default(''),
	recommendedWorkspacePath: text('recommended_workspace_path').notNull().default(''),
	reasoning: text('reasoning').notNull().default(''),
	brief: text('brief').notNull().default(''),
	createdAt: bigint('created_at', { mode: 'number' }).notNull(),
	lastEvaluatedAt: bigint('last_evaluated_at', { mode: 'number' }).notNull(),
	/** Connector date_updated (epoch ms) snapshotted at evaluation time. */
	ticketUpdatedAt: bigint('ticket_updated_at', { mode: 'number' }),
	/** Snoozed-until (epoch ms); null = visible now. */
	postponedUntil: bigint('postponed_until', { mode: 'number' }),
});

export type Building = typeof buildings.$inferSelect;
export type NewBuilding = typeof buildings.$inferInsert;
export type PersistentAgentRow = typeof persistentAgents.$inferSelect;
export type NewPersistentAgentRow = typeof persistentAgents.$inferInsert;
export type SeatRow = typeof seats.$inferSelect;
export type NewSeatRow = typeof seats.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type BuildingProjectRow = typeof buildingProjects.$inferSelect;
export type NewBuildingProjectRow = typeof buildingProjects.$inferInsert;
export type WorkerAssignmentRow = typeof workerAssignments.$inferSelect;
export type NewWorkerAssignmentRow = typeof workerAssignments.$inferInsert;
export type SessionHistoryRow = typeof sessionHistory.$inferSelect;
export type NewSessionHistoryRow = typeof sessionHistory.$inferInsert;
