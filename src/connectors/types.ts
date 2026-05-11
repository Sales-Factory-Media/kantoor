/**
 * Project connectors abstract over the ticket-tracking system a building uses.
 * Today: ClickUp (Vibelab) and GitHub Issues (PC). Adding a new system means
 * implementing this interface and registering it in the connector registry.
 *
 * Connectors return data in a normalized shape (`Ticket`, `StatusGroup`) so the
 * orchestration layer (Darryl/Jan pickup, dispatch, capacity) doesn't need to
 * branch on connector type.
 */

export interface Ticket {
	/** Connector-native ticket ID (ClickUp task id, GitHub issue number as string). */
	id: string;
	/** Display title. */
	name: string;
	/** Current status — connector-native status string (the connector decides
	 *  the canonical names; orchestrators match on these). */
	status: { status: string; color: string };
	/** Direct URL the user can click to open the ticket in its native UI. */
	url: string;
	/** Usernames of assigned people in the connector's namespace. ClickUp
	 *  usernames or GitHub logins. Empty array if none. */
	assignees: Array<{ username: string }>;
	/** Optional ordering hint — connector-native priority indicator. */
	priority: { id: string } | null;
	/** Parent ticket id, if this is a subtask. */
	parent: string | null;
}

export interface StatusGroup {
	name: string;
	color: string;
	tasks: Ticket[];
}

/**
 * Per-building configuration for a connector. Stored as `connector_config`
 * jsonb on the buildings table; the connector implementation knows how to
 * read its own fields.
 */
export type ConnectorConfig = Record<string, unknown>;

export interface ProjectConnector {
	/** Stable identifier — 'clickup', 'github', etc. */
	readonly type: string;

	/** True if this connector has enough config to actually fetch. */
	isConfigured(): boolean;

	/** Fetch all open tickets, grouped by status. */
	fetchTickets(): Promise<StatusGroup[]>;

	/** Post a comment on a ticket. */
	addComment(ticketId: string, body: string): Promise<void>;
}

export interface ConnectorFactory {
	/** Connector-type identifier matching `buildings.connector_type`. */
	readonly type: string;
	/** Construct a connector for a given building's config. */
	create(config: ConnectorConfig): ProjectConnector;
}
