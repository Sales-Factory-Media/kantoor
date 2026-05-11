import {
	pgTable,
	uuid,
	text,
	jsonb,
	timestamp,
	integer,
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
	currentSessionId: text('current_session_id'),
	lastSessionEnd: text('last_session_end'),
	sessionCount: integer('session_count'),
	currentTicketId: text('current_ticket_id'),
	currentTicketName: text('current_ticket_name'),
	currentTicketUrl: text('current_ticket_url'),
	lastTicketId: text('last_ticket_id'),
	retired: boolean('retired'),
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
