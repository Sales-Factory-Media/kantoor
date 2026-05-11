/**
 * Building list / switching / configuration handlers. The webview top-left
 * dropdown drives these: list buildings, switch active, create new, configure
 * connector. The server holds a single "active building" — switching it
 * stops the current connector polling, swaps the caches, and starts the new
 * connector. All connected webviews see the new building (it's a server-
 * global active building, not per-connection).
 */

import type { ServerContext } from './serverContext.js';
import type { Building } from '../src/db/schema.js';
import { switchActiveBuilding, listBuildings } from '../src/db/activeBuilding.js';
import {
	initAgentStore,
	loadPersistentAgents,
	loadPersistentAgentsForBuilding,
	savePersistentAgents,
	savePersistentAgentsForBuilding,
	seedDesignTeams,
} from './agentStore.js';
import { initProjectStore, loadKnownProjects, listAllProjectsWithMembership, setProjectMembership } from '../src/projectStore.js';
import { initSeatStore, loadSeats } from '../src/db/seatStore.js';
import { initWorkerAssignmentStore, loadWorkerAssignments } from '../src/db/workerAssignmentStore.js';
import { connectorForBuilding } from '../src/connectors/registry.js';
import { stopClickupPolling, startClickupPolling, handleClickupRefresh } from './clickupHandlers.js';
import { buildOrganogram } from './organogram.js';
import { getOfflineAgents } from './serverHelpers.js';
import { getLiveSessionIds } from './projectScanner.js';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { buildings as buildingsTable } from '../src/db/schema.js';
import { patchActiveBuildingConnectorConfig } from '../src/db/settingsStore.js';

export async function handleListBuildings(ws: { send: (s: string) => void }, ctx: ServerContext): Promise<void> {
	ctx.allBuildings = await listBuildings();
	ws.send(JSON.stringify({
		type: 'buildingsList',
		buildings: ctx.allBuildings.map(serializeBuilding),
		activeBuildingId: ctx.activeBuilding?.id ?? null,
	}));
}

export function broadcastBuildings(ctx: ServerContext): void {
	ctx.broadcastSink.postMessage({
		type: 'buildingsList',
		buildings: ctx.allBuildings.map(serializeBuilding),
		activeBuildingId: ctx.activeBuilding?.id ?? null,
	});
}

/**
 * Hot-swap the active building. Steps:
 *  1. Stop the current connector's polling.
 *  2. Switch the activeBuilding module to the new slug.
 *  3. Re-init every store cache (load this building's rows from DB).
 *  4. Build the new connector from the new building's connector_config.
 *  5. Update ctx fields, clear stale agent sessions, broadcast fresh state.
 *  6. Start polling on the new connector if configured.
 */
export async function handleSwitchBuilding(msg: Record<string, unknown>, ctx: ServerContext): Promise<void> {
	if (ctx.isWorkerMode) {
		console.warn('[Buildings] Workers cannot switch buildings — hub-only operation');
		return;
	}
	const slug = msg.slug as string | undefined;
	if (!slug) return;
	if (ctx.activeBuilding?.slug === slug) return;

	console.log(`[Buildings] Switching active building → "${slug}"`);

	stopClickupPolling(ctx);

	const newBuilding = await switchActiveBuilding(slug);
	await Promise.all([
		initAgentStore(),
		initProjectStore(),
		initSeatStore(),
		initWorkerAssignmentStore(),
	]);

	const newConnector = connectorForBuilding(newBuilding);
	ctx.activeBuilding = newBuilding;
	ctx.connector = newConnector;
	ctx.allBuildings = await listBuildings();

	// Reset transient state tied to the previous building
	ctx.clickupTickets = [];
	ctx.clickupNextFetchAt = null;
	ctx.persistentAgents = loadPersistentAgents();
	ctx.setPersistentAgents(loadPersistentAgents());
	ctx.workerAssignments = loadWorkerAssignments();

	// Clear stale current-session refs that point at sessions that don't exist
	// in the new building's roster.
	const liveIds = getLiveSessionIds();
	let cleared = false;
	for (const pa of ctx.persistentAgents) {
		if (pa.currentSessionId && !liveIds.has(pa.currentSessionId)) {
			pa.currentSessionId = undefined;
			cleared = true;
		}
	}
	if (cleared) savePersistentAgents(ctx.persistentAgents);

	// Reflect ClickUp config alias for legacy callers
	const cfg = newBuilding.connectorConfig as Record<string, unknown>;
	const apiToken = cfg.apiToken as string | undefined;
	const listId = cfg.listId as string | undefined;
	ctx.clickupConfig = (apiToken && listId) ? { apiToken, listId } : null;

	// Broadcast new state to all webviews
	ctx.broadcastSink.postMessage({
		type: 'buildingSwitched',
		building: serializeBuilding(newBuilding),
	});
	broadcastBuildings(ctx);
	ctx.broadcastSink.postMessage({ type: 'knownProjects', projects: loadKnownProjects() });
	ctx.broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(ctx.agentManager, ctx.persistentAgents) });
	ctx.broadcastSink.postMessage({ type: 'organogramSnapshot', organogram: buildOrganogram(ctx.persistentAgents) });
	ctx.broadcastSink.postMessage({
		type: 'clickupConfigured',
		configured: !!(newConnector && newConnector.isConfigured()),
		listId: ctx.clickupConfig?.listId,
	});
	ctx.broadcastSink.postMessage({ type: 'clickupTickets', statuses: [], nextFetchAt: null });

	// The webview also needs to rebuild seats — push the seat metadata
	// for the new building so the office repopulates.
	const seats = loadSeats();
	ctx.broadcastSink.postMessage({ type: 'seatsLoaded', seats });

	// Start polling the new connector
	if (newConnector && newConnector.isConfigured()) {
		startClickupPolling(ctx);
		handleClickupRefresh(ctx).catch(err => console.error('[Buildings] Initial refresh failed:', err));
	}
}

/**
 * Create a new building and immediately switch to it. Connector type is set
 * at creation; connector_config starts empty (user fills in via the
 * configure UI on the new building's view).
 */
export async function handleCreateBuilding(msg: Record<string, unknown>, ctx: ServerContext): Promise<void> {
	if (ctx.isWorkerMode) return;
	const slug = (msg.slug as string | undefined)?.trim().toLowerCase();
	const name = (msg.name as string | undefined)?.trim();
	const connectorType = (msg.connectorType as string | undefined) ?? 'clickup';

	if (!slug || !name) {
		ctx.broadcastSink.postMessage({ type: 'buildingCreateError', error: 'slug and name required' });
		return;
	}
	if (!/^[a-z0-9-]+$/.test(slug)) {
		ctx.broadcastSink.postMessage({ type: 'buildingCreateError', error: 'slug must be lowercase letters/digits/hyphens' });
		return;
	}

	const db = getDb();
	const existing = await db.select({ id: buildingsTable.id }).from(buildingsTable).where(eq(buildingsTable.slug, slug)).limit(1);
	if (existing.length > 0) {
		ctx.broadcastSink.postMessage({ type: 'buildingCreateError', error: `Building "${slug}" already exists` });
		return;
	}

	const sortOrder = (ctx.allBuildings.at(-1)?.sortOrder ?? -1) + 1;
	await db.insert(buildingsTable).values({
		slug,
		name,
		connectorType,
		connectorConfig: {},
		sortOrder,
	});

	// Seed the new building with a full design org chart (Jan + UX + Visual teams).
	const newRow = (await db.select().from(buildingsTable).where(eq(buildingsTable.slug, slug)).limit(1))[0];
	const working = await loadPersistentAgentsForBuilding(newRow.id);
	if (seedDesignTeams(working)) {
		await savePersistentAgentsForBuilding(newRow.id, working);
	}

	console.log(`[Buildings] Created building "${slug}" (${connectorType})`);

	// Switch to the new building immediately so the user lands in it.
	await handleSwitchBuilding({ slug }, ctx);
}

/**
 * Send the global project pool to a specific WS client, with a flag per
 * project indicating membership in the active building. Drives the gear-icon
 * project-membership modal in the webview.
 */
export async function handleListProjects(ws: { send: (s: string) => void }, ctx: ServerContext): Promise<void> {
	const projects = await listAllProjectsWithMembership();
	ws.send(JSON.stringify({
		type: 'projectsList',
		projects,
		activeBuildingId: ctx.activeBuilding?.id ?? null,
	}));
}

/**
 * Toggle a project's membership in the active building. Broadcasts the
 * updated `knownProjects` payload (active-building list) so all webviews
 * re-render their sidebars, plus a fresh `projectsList` so any open
 * settings modal updates its checkboxes.
 */
export async function handleSetProjectMembership(msg: Record<string, unknown>, ctx: ServerContext): Promise<void> {
	if (ctx.isWorkerMode) return;
	const workspacePath = msg.workspacePath as string | undefined;
	const included = msg.included as boolean | undefined;
	if (!workspacePath || included === undefined) return;

	await setProjectMembership(workspacePath, included);

	// Push refreshed active-building project list (drives sidebar)
	ctx.broadcastSink.postMessage({ type: 'knownProjects', projects: loadKnownProjects() });

	// Push fresh global pool with membership flags (drives the modal)
	const allProjects = await listAllProjectsWithMembership();
	ctx.broadcastSink.postMessage({
		type: 'projectsList',
		projects: allProjects,
		activeBuildingId: ctx.activeBuilding?.id ?? null,
	});
}

function serializeBuilding(b: Building): Record<string, unknown> {
	const conn = connectorForBuilding(b);
	return {
		id: b.id,
		slug: b.slug,
		name: b.name,
		connectorType: b.connectorType,
		sortOrder: b.sortOrder,
		// Don't ship secrets to the webview — only mark whether config is present.
		configured: conn?.isConfigured() ?? false,
	};
}

/**
 * Generic connector-config patch handler — supersedes the ClickUp-specific
 * `handleClickupConfigure` for new building types. The webview sends the
 * raw config patch (e.g. { token, owner, repo } for GitHub or
 * { apiToken, listId } for ClickUp); we merge it into the active building's
 * connector_config and rebuild the connector.
 */
export async function handleConfigureBuildingConnector(msg: Record<string, unknown>, ctx: ServerContext): Promise<void> {
	if (ctx.isWorkerMode || !ctx.activeBuilding) return;
	const patch = (msg.config as Record<string, unknown> | undefined) ?? {};
	const merged = await patchActiveBuildingConnectorConfig(patch);

	const refreshed = { ...ctx.activeBuilding, connectorConfig: merged };
	ctx.activeBuilding = refreshed;
	ctx.connector = connectorForBuilding(refreshed);
	ctx.allBuildings = await listBuildings();

	// Sync legacy clickupConfig alias for any callers that still read it.
	if (refreshed.connectorType === 'clickup') {
		const apiToken = merged.apiToken as string | undefined;
		const listId = merged.listId as string | undefined;
		ctx.clickupConfig = (apiToken && listId) ? { apiToken, listId } : null;
	} else {
		ctx.clickupConfig = null;
	}

	stopClickupPolling(ctx);
	if (ctx.connector?.isConfigured()) {
		startClickupPolling(ctx);
		handleClickupRefresh(ctx).catch(err => console.error('[Buildings] Refresh after config change failed:', err));
	}

	broadcastBuildings(ctx);
	ctx.broadcastSink.postMessage({
		type: 'buildingConfigured',
		buildingId: refreshed.id,
		configured: !!ctx.connector?.isConfigured(),
	});
}
