import * as path from 'path';
import * as crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { MessageSink } from '../src/types.js';
import { loadKnownProjects, addKnownProject, initProjectStore } from '../src/projectStore.js';
import { SERVER_PORT, DESIGNER_ROLE_SHORT, VISUAL_DESIGNER_ROLE_SHORT, VISUAL_QA_ROLE_SHORT, JAN_ROLE_SHORT, DEFAULT_WORKER_ROLES } from './constants.js';
import { ProjectScanner, decodeProjectHash, getLiveSessionIds } from './projectScanner.js';
import { StandaloneAgentManager } from './standaloneAgentManager.js';
import {
	loadPersistentAgents,
	savePersistentAgents,
	pickRandomName,
	seedDesignTeams,
	initAgentStore,
	loadPersistentAgentsForBuilding,
	savePersistentAgentsForBuilding,
	addAgentSession,
	removeAgentSession,
	pruneDeadSessions,
	findAgentBySessionId,
	agentSessionIds,
	isUnidentified,
} from './agentStore.js';
import { buildOrganogram } from './organogram.js';
import type { PersistentAgent } from './agentStore.js';
import { readJson, writeJson, getOfflineAgents, buildNewWorkerPopup } from './serverHelpers.js';
import { preloadAssets, WORKER_IDENTITY_FILE } from './serverContext.js';
import type { ServerContext, WorkerIdentity } from './serverContext.js';
import { createDispatchRegistry, releaseTicket } from './dispatchRegistry.js';
import { createDelegationStore, getPendingDelegations } from './delegationStore.js';
import { handleConfirmDelegation, handleDiscardDelegation, handlePostponeDelegation, loadDelegationsIntoStore } from './delegationHandlers.js';
import { openUrlInExternalBrowser } from './openExternal.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrateLegacyJsonIntoDb } from '../src/db/migrateFromJson.js';
import { initActiveBuilding, listBuildings, switchActiveBuilding } from '../src/db/activeBuilding.js';
import { connectorForBuilding } from '../src/connectors/registry.js';
import { initSeatStore, loadSeats } from '../src/db/seatStore.js';
import { initSettingsStore, getAppSetting } from '../src/db/settingsStore.js';
import { initWorkerAssignmentStore } from '../src/db/workerAssignmentStore.js';
import { initSessionHistoryStore, lookupSessionOwner } from '../src/db/sessionHistoryStore.js';
import {
	handleFocusAgent,
	handleSaveAgentSeats,
	handleSaveAgentIdentity,
	handleDeleteAgentIdentity,
	handleIdentifyWorker,
	handleReassignTask,
	handleLaunchAgent,
	handleRestartAgent,
	handleForgetAgent,
	handleRemoveRoom,
	handleSetSoundEnabled,
	handleUpdateProjectDescription,
	getJanDesignConfig,
	handleSetJanDesignConfig,
	handleSetAutoMode,
	getAutoModeEnabled,
} from './agentHandlers.js';
import {
	startClickupPolling,
	handleClickupRefresh,
	handleClickupConfigure,
	handleJanDesignBriefing,
	loadActiveClickupConfig,
} from './clickupHandlers.js';
import {
	handleListBuildings,
	handleSwitchBuilding,
	handleCreateBuilding,
	handleConfigureBuildingConnector,
	handleListProjects,
	handleSetProjectMembership,
	handleSetProjectLogo,
} from './buildingHandlers.js';
import {
	handleClickupStartWork,
	handleLaunchDesigner,
	handleLaunchVisualDesigner,
	handleDesignerSessionEnded,
} from './workerDispatch.js';
import {
	handleStartConference,
	handleEndConference,
	PEERS_BROKER_URL,
} from './conferenceHandlers.js';
import { createHttpServer } from './httpServer.js';
import {
	registerWorker,
	handleWorkerHeartbeat,
	handleWorkerDisconnect,
	handleTicketStarted,
	handleTicketComplete,
	handleTicketFailed,
	handleWorkerResponse,
	checkWorkerHeartbeats,
	broadcastWorkerStatus,
	loadAssignments,
} from './workerRegistry.js';
import { startWorkerMode, stopWorkerMode, reportDesignerSessionEndedToHub, reportTicketCompleteToHub } from './workerMode.js';

// ── CLI argument parsing ────────────────────────────────────

function parseCliArgs(): { hubUrl: string | null; name: string | null; color: string | null; roles: string[] | null; noLocalDev: boolean; serialDev: boolean } {
	const args = process.argv.slice(2);
	let hubUrl: string | null = null;
	let name: string | null = null;
	let color: string | null = null;
	let roles: string[] | null = null;
	let noLocalDev = false;
	let serialDev = false;

	for (const arg of args) {
		if (arg.startsWith('--hub=')) hubUrl = arg.slice('--hub='.length);
		else if (arg.startsWith('--name=')) name = arg.slice('--name='.length);
		else if (arg.startsWith('--color=')) color = arg.slice('--color='.length);
		else if (arg.startsWith('--roles=')) {
			roles = arg.slice('--roles='.length).split(',').map(r => r.trim()).filter(r => r.length > 0);
		}
		else if (arg === '--no-local-dev') noLocalDev = true;
		else if (arg === '--serial-dev') serialDev = true;
	}

	// Also check env vars as fallback
	if (!hubUrl && process.env.HUB) hubUrl = process.env.HUB;
	if (!roles && process.env.WORKER_ROLES) {
		roles = process.env.WORKER_ROLES.split(',').map(r => r.trim()).filter(r => r.length > 0);
	}
	if (!noLocalDev && process.env.NO_LOCAL_DEV && process.env.NO_LOCAL_DEV !== '0' && process.env.NO_LOCAL_DEV.toLowerCase() !== 'false') {
		noLocalDev = true;
	}
	if (!serialDev && process.env.SERIAL_DEV && process.env.SERIAL_DEV !== '0' && process.env.SERIAL_DEV.toLowerCase() !== 'false') {
		serialDev = true;
	}

	return { hubUrl, name, color, roles, noLocalDev, serialDev };
}

function loadOrCreateWorkerIdentity(
	cliName: string | null,
	cliColor: string | null,
	cliRoles: string[] | null,
): WorkerIdentity {
	const saved = readJson(WORKER_IDENTITY_FILE) as WorkerIdentity | null;
	const defaultRoles = [...DEFAULT_WORKER_ROLES];

	const identity: WorkerIdentity = {
		name: cliName || saved?.name || 'Hub',
		color: cliColor || saved?.color || '#4CAF50',
		roles: cliRoles ?? saved?.roles ?? defaultRoles,
	};

	if (cliName || cliColor || cliRoles || !saved) {
		writeJson(WORKER_IDENTITY_FILE, identity);
	}
	return identity;
}

// ── Worker message types ────────────────────────────────────

const WORKER_MESSAGE_TYPES = new Set([
	'workerRegister', 'workerHeartbeat',
	'ticketStarted', 'ticketComplete', 'ticketFailed',
	'workerResponse', 'designerSessionEnded',
]);

// ── WebviewReady handler (touches all domains) ───────────────

function handleWebviewReady(ws: WebSocket, ctx: ServerContext): void {
	const { assets, agentManager, persistentAgents } = ctx;

	// Send all pre-loaded assets
	if (assets.characterSprites) {
		const cs = assets.characterSprites as { characters: unknown };
		ws.send(JSON.stringify({ type: 'characterSpritesLoaded', characters: cs.characters }));
	}
	if (assets.floorTiles) {
		const ft = assets.floorTiles as { sprites: unknown };
		ws.send(JSON.stringify({ type: 'floorTilesLoaded', sprites: ft.sprites }));
	}
	if (assets.wallTiles) {
		const wt = assets.wallTiles as { sprites: unknown };
		ws.send(JSON.stringify({ type: 'wallTilesLoaded', sprites: wt.sprites }));
	}
	if (assets.furnitureAssets) {
		const fa = assets.furnitureAssets;
		const spritesObj: Record<string, string[][]> = {};
		for (const [id, spriteData] of fa.sprites) {
			spritesObj[id] = spriteData;
		}
		ws.send(JSON.stringify({
			type: 'furnitureAssetsLoaded',
			catalog: fa.catalog,
			sprites: spritesObj,
		}));
	}

	// Send known projects
	ws.send(JSON.stringify({ type: 'knownProjects', projects: loadKnownProjects() }));

	// Build agent meta from persistent agents
	const agentMeta: Record<string, Record<string, unknown>> = {};
	const seatsData = loadSeats();
	for (const [sid, rawMeta] of Object.entries(seatsData)) {
		agentMeta[sid] = rawMeta as Record<string, unknown>;
	}
	for (const pa of persistentAgents) {
		// One agent can run several concurrent sessions — emit meta for each so
		// every live tab's character is restored on reconnect.
		for (const sid of agentSessionIds(pa)) {
			agentMeta[sid] = {
				...agentMeta[sid],
				name: pa.name,
				palette: pa.palette,
				hueShift: pa.hueShift,
				seatId: pa.seatId,
				roleShort: pa.roleShort,
				roleFull: pa.roleFull,
				workspacePath: pa.workspacePath,
				persistentAgentId: pa.id,
				avatarConfig: pa.avatarConfig,
				sessionCount: pa.sessionCount,
				lastSessionEnd: pa.lastSessionEnd,
			};
		}
	}

	// Send existing agents BEFORE layout
	const agentIds = agentManager.getExistingAgentIds();
	const folderNames: Record<number, string> = {};
	for (const id of agentIds) {
		const agent = agentManager.agents.get(id);
		if (agent) folderNames[id] = agent.projectName;
	}
	ws.send(JSON.stringify({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		sessionIds: agentManager.getSessionIds(),
		folderNames,
		taskTitles: agentManager.getTaskTitles(),
	}));

	// Replay the "who's this?" popup for any live session still attached to an
	// unidentified (provisional) agent. The popup is normally fired once, live,
	// from onNewSession — but if it went out before any client was connected
	// (e.g. the server discovered already-running sessions at boot) it was lost.
	// Re-surfacing it here means a freshly-opened webview always gets to assign
	// those sessions instead of letting them stick under a throwaway random name.
	for (const id of agentIds) {
		const agent = agentManager.agents.get(id);
		if (!agent) continue;
		const owner = findAgentBySessionId(persistentAgents, agent.sessionId);
		if (owner && isUnidentified(owner)) {
			ws.send(JSON.stringify(buildNewWorkerPopup(
				persistentAgents,
				agent.sessionId,
				owner,
				agent.projectName,
				agent.workspacePath || owner.workspacePath || '',
			)));
		}
	}

	// Signal layout ready
	ws.send(JSON.stringify({ type: 'layoutLoaded', layout: null }));

	// Send settings
	const soundEnabled = getAppSetting<boolean>('soundEnabled') !== false;
	ws.send(JSON.stringify({ type: 'settingsLoaded', soundEnabled }));

	// Auto Mode state + any delegations awaiting confirmation
	ws.send(JSON.stringify({ type: 'autoModeLoaded', enabled: getAutoModeEnabled() }));
	ws.send(JSON.stringify({ type: 'delegationPending', delegations: getPendingDelegations(ctx.delegationStore) }));

	// Send Jan's design config
	ws.send(JSON.stringify({ type: 'janDesignConfigLoaded', config: getJanDesignConfig() }));

	// Send offline agents
	ws.send(JSON.stringify({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) }));

	// Send current tool/waiting statuses
	const wsSink: MessageSink = { postMessage: (m) => ws.send(JSON.stringify(m)) };
	agentManager.sendAgentStatuses(wsSink);

	// Send ClickUp state
	ws.send(JSON.stringify({ type: 'clickupConfigured', configured: !!ctx.clickupConfig, listIds: ctx.clickupConfig?.listIds ?? [] }));
	if (ctx.clickupTickets.length > 0) {
		ws.send(JSON.stringify({ type: 'clickupTickets', statuses: ctx.clickupTickets, nextFetchAt: ctx.clickupNextFetchAt }));
	}

	// Send building list + active building so the switcher knows what to render.
	handleListBuildings(ws, ctx).catch(err => console.error('[Standalone] webviewReady listBuildings failed:', err));

	// Check peers broker availability
	fetch(PEERS_BROKER_URL + '/health')
		.then(() => ws.send(JSON.stringify({ type: 'peersBrokerStatus', available: true })))
		.catch(() => ws.send(JSON.stringify({ type: 'peersBrokerStatus', available: false })));

	// Send worker status
	broadcastWorkerStatus(ctx);

	// Send organogram snapshot
	ws.send(JSON.stringify({ type: 'organogramSnapshot', organogram: buildOrganogram(persistentAgents) }));

	// No auto-pickup on webview connect. Specialists only start via the 3-min
	// ClickUp poll or an explicit manual refresh from the kantoor interface.
}

// ── Message dispatch ─────────────────────────────────────────

const messageHandlers: Record<string, (ws: WebSocket, msg: Record<string, unknown>, ctx: ServerContext) => void> = {
	webviewReady: (ws, _msg, ctx) => handleWebviewReady(ws, ctx),
	focusAgent: (_ws, msg, ctx) => handleFocusAgent(msg, ctx),
	saveAgentSeats: (_ws, msg, ctx) => handleSaveAgentSeats(msg, ctx),
	saveAgentIdentity: (_ws, msg, ctx) => handleSaveAgentIdentity(msg, ctx),
	deleteAgentIdentity: (_ws, msg, ctx) => handleDeleteAgentIdentity(msg, ctx),
	identifyWorker: (_ws, msg, ctx) => handleIdentifyWorker(msg, ctx),
	reassignTask: (_ws, msg, ctx) => handleReassignTask(msg, ctx),
	launchAgent: (_ws, msg, ctx) => handleLaunchAgent(msg, ctx),
	restartAgent: (_ws, msg) => handleRestartAgent(msg),
	forgetAgent: (_ws, msg, ctx) => handleForgetAgent(msg, ctx),
	removeRoom: (_ws, msg, ctx) => handleRemoveRoom(msg, ctx),
	setSoundEnabled: (_ws, msg) => handleSetSoundEnabled(msg),
	setJanDesignConfig: (_ws, msg, ctx) => handleSetJanDesignConfig(msg, ctx),
	setAutoMode: (_ws, msg, ctx) => {
		if (rejectIfWorker(ctx, 'setAutoMode')) return;
		handleSetAutoMode(msg, ctx);
	},
	confirmDelegation: (_ws, msg, ctx) => {
		if (rejectIfWorker(ctx, 'confirmDelegation')) return;
		handleConfirmDelegation(msg, ctx).catch(() => {});
	},
	discardDelegation: (_ws, msg, ctx) => {
		if (rejectIfWorker(ctx, 'discardDelegation')) return;
		handleDiscardDelegation(msg, ctx);
	},
	postponeDelegation: (_ws, msg, ctx) => {
		if (rejectIfWorker(ctx, 'postponeDelegation')) return;
		handlePostponeDelegation(msg, ctx);
	},
	openExternalUrl: (_ws, msg) => openUrlInExternalBrowser(String(msg.url ?? '')),
	clickupRefresh: (_ws, _msg, ctx) => { handleClickupRefresh(ctx).catch(() => {}); },
	clickupStartWork: (_ws, msg, ctx) => {
		if (rejectIfWorker(ctx, 'clickupStartWork')) return;
		handleClickupStartWork(msg, ctx).catch(() => {});
	},
	clickupConfigure: (_ws, msg, ctx) => { handleClickupConfigure(msg, ctx).catch(err => console.error('[Standalone] clickupConfigure failed:', err)); },
	listBuildings: (ws, _msg, ctx) => { handleListBuildings(ws, ctx).catch(err => console.error('[Standalone] listBuildings failed:', err)); },
	switchBuilding: (_ws, msg, ctx) => { handleSwitchBuilding(msg, ctx).catch(err => console.error('[Standalone] switchBuilding failed:', err)); },
	createBuilding: (_ws, msg, ctx) => { handleCreateBuilding(msg, ctx).catch(err => console.error('[Standalone] createBuilding failed:', err)); },
	configureBuildingConnector: (_ws, msg, ctx) => { handleConfigureBuildingConnector(msg, ctx).catch(err => console.error('[Standalone] configureBuildingConnector failed:', err)); },
	listProjects: (ws, _msg, ctx) => { handleListProjects(ws, ctx).catch(err => console.error('[Standalone] listProjects failed:', err)); },
	setProjectMembership: (_ws, msg, ctx) => { handleSetProjectMembership(msg, ctx).catch(err => console.error('[Standalone] setProjectMembership failed:', err)); },
	setProjectLogo: (_ws, msg, ctx) => { handleSetProjectLogo(msg, ctx).catch(err => console.error('[Standalone] setProjectLogo failed:', err)); },
	startConference: (_ws, msg, ctx) => handleStartConference(msg, ctx),
	endConference: (_ws, msg, ctx) => handleEndConference(msg, ctx),
	updateProjectDescription: (_ws, msg, ctx) => handleUpdateProjectDescription(msg, ctx),
	janDesignBriefing: (_ws, msg, ctx) => {
		if (rejectIfWorker(ctx, 'janDesignBriefing')) return;
		handleJanDesignBriefing(msg, ctx);
	},
	launchDesigner: (_ws, msg, ctx) => {
		if (rejectIfWorker(ctx, 'launchDesigner')) return;
		handleLaunchDesigner(msg, ctx).then(result => {
			ctx.broadcastSink.postMessage({ type: 'designerLaunched', ...result });
		}).catch(err => {
			ctx.broadcastSink.postMessage({ type: 'designerLaunched', success: false, error: String(err) });
		});
	},
	launchVisualDesigner: (_ws, msg, ctx) => {
		if (rejectIfWorker(ctx, 'launchVisualDesigner')) return;
		handleLaunchVisualDesigner(msg, ctx).then(result => {
			ctx.broadcastSink.postMessage({ type: 'visualDesignerLaunched', ...result });
		}).catch(err => {
			ctx.broadcastSink.postMessage({ type: 'visualDesignerLaunched', success: false, error: String(err) });
		});
	},
	getOrganogram: (ws, _msg, ctx) => {
		ws.send(JSON.stringify({ type: 'organogramSnapshot', organogram: buildOrganogram(ctx.persistentAgents) }));
	},
	// janReviewDesigner was removed: Jan is a pure orchestrator and does not
	// open Figma to review designer output. Designers move their own tickets
	// to `qa test` (human review) when they finish; Visual Designer output
	// additionally passes through Visual QA via Jan's ai-review dispatch.
};

/**
 * All pickup / dispatch orchestration should originate on the hub. If a
 * worker's webview triggers one of these actions (user clicked something,
 * stray handler), log and short-circuit so the worker doesn't start a
 * session autonomously.
 */
function rejectIfWorker(ctx: ServerContext, action: string): boolean {
	if (ctx.isWorkerMode) {
		console.warn(`[Worker] Ignoring webview action "${action}" — pickup/dispatch orchestration is hub-only.`);
		return true;
	}
	return false;
}

// Not supported in standalone mode
for (const type of ['openClaude', 'closeAgent', 'openSessionsFolder']) {
	messageHandlers[type] = () => {};
}

function handleClientMessage(
	ws: WebSocket,
	msg: Record<string, unknown>,
	ctx: ServerContext,
): void {
	const handler = messageHandlers[msg.type as string];
	if (handler) {
		handler(ws, msg, ctx);
	}
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
	// ── CLI args ─────────────────────────────────────────────
	const cliArgs = parseCliArgs();
	const isWorkerMode = !!cliArgs.hubUrl;
	const workerIdentity = loadOrCreateWorkerIdentity(cliArgs.name, cliArgs.color, cliArgs.roles);

	// ── Database setup ──────────────────────────────────────
	// Apply pending Drizzle migrations, then run the one-shot JSON → DB
	// import (idempotent — no-op if buildings already exist), then load
	// the active building and prime in-memory caches for all stores.
	await runMigrations();
	await migrateLegacyJsonIntoDb();

	// Seed each building's design teams BEFORE picking the active building,
	// so PC (and any future building) has a full org chart waiting in the DB
	// even if the user has never switched to it.
	const allBuildings = await listBuildings();
	for (const b of allBuildings) {
		const beforeAgents = await loadPersistentAgentsForBuilding(b.id);
		const working = [...beforeAgents];
		const changed = seedDesignTeams(working);
		if (changed) {
			await savePersistentAgentsForBuilding(b.id, working);
			console.log(`[Standalone] Seeded design teams for building "${b.slug}"${isWorkerMode ? ' [worker]' : ''}`);
		}
	}

	const activeBuilding = await initActiveBuilding();
	await Promise.all([
		initAgentStore(),
		initProjectStore(),
		initSeatStore(),
		initSettingsStore(),
		initWorkerAssignmentStore(),
		initSessionHistoryStore(),
	]);
	const connector = connectorForBuilding(activeBuilding);

	const assets = await preloadAssets();

	const agentManager = new StandaloneAgentManager();
	let persistentAgents = loadPersistentAgents();

	// ── Clear stale session IDs on startup ───────────────────
	// Persistent agents may have currentSessionId from a previous server run
	// where the session ended after the server stopped. Clear any that don't
	// have a live claude process.
	const liveOnStartup = getLiveSessionIds();
	// Safety: if `ps aux` failed (timeout / transient load), getLiveSessionIds
	// returns null. Treating that as "everything's dead" would clear every
	// employee's currentSessionId and cause `onNewSession` to mint duplicate
	// provisional employees a moment later when the scanner re-probes
	// successfully. Skip the prune and let the periodic `checkStale` clean
	// things up correctly.
	if (liveOnStartup === null) {
		const claimedCount = persistentAgents.reduce(
			(n, pa) => n + (pa.currentSessions?.length ?? 0),
			0,
		);
		console.warn(`[Standalone] Skipping boot prune: ps aux probe failed (${claimedCount} sessions claimed in DB) — will recover on next checkStale tick.`);
	} else {
		let clearedStale = false;
		for (const pa of persistentAgents) {
			if (pruneDeadSessions(pa, liveOnStartup)) {
				console.log(`[Standalone] Cleared stale session(s) from agent "${pa.name}"`);
				pa.lastSessionEnd = pa.lastSessionEnd || new Date().toISOString();
				clearedStale = true;
			}
		}
		if (clearedStale) {
			savePersistentAgents(persistentAgents);
		}
	}

	// Note: design teams already seeded for every building above. The active
	// building's roster is what's loaded into `persistentAgents` here.

	// ── WebSocket broadcast sink (webview clients only) ──────
	const webviewClients = new Set<WebSocket>();

	const broadcastSink: MessageSink = {
		postMessage(msg: unknown) {
			const data = JSON.stringify(msg);
			for (const ws of webviewClients) {
				if (ws.readyState === ws.OPEN) {
					ws.send(data);
				}
			}
		},
	};

	agentManager.setSink(broadcastSink);

	// ── ClickUp integration ─────────────────────────────────
	const clickupConfig = await loadActiveClickupConfig();

	// ── Server context (shared state for message handlers) ──
	const ctx: ServerContext = {
		agentManager,
		assets,
		broadcastSink,
		persistentAgents,
		setPersistentAgents(updated) { persistentAgents = updated; ctx.persistentAgents = updated; },
		clickupConfig,
		clickupTickets: [],
		clickupNextFetchAt: null,
		clickupTimer: null,
		connector,
		activeBuilding,
		allBuildings,
		// Multi-worker
		isWorkerMode,
		workerIdentity,
		// Hub-only: when true, Darryl never runs dev work on this machine and
		// always cascades to a remote worker. Ignored when this process is itself
		// a worker (workers accept whatever the hub dispatches).
		noLocalDev: !isWorkerMode && cliArgs.noLocalDev,
		// One-dev-session-at-a-time cap (legacy). Off by default so the hub can
		// run several concurrent dev sessions. Hub-only.
		serialDev: !isWorkerMode && cliArgs.serialDev,
		workers: new Map(),
		workerAssignments: isWorkerMode ? [] : loadAssignments(),
		pendingWorkerRequests: new Map(),
		mempalaceServerUrl: null,
		hubWs: null,
		dispatchRegistry: createDispatchRegistry(),
		delegationStore: createDelegationStore(),
	};

	// Rehydrate Auto Mode delegations persisted before the last restart, so the
	// "Awaiting delegation" popups survive a hub reboot (hub-only).
	if (!isWorkerMode) {
		await loadDelegationsIntoStore(ctx);
	}

	// ── Workspace path cache (decoded from project hash) ────
	const workspacePathCache = new Map<string, string | null>();
	function getWorkspacePath(projectDir: string): string | undefined {
		if (!workspacePathCache.has(projectDir)) {
			const dirName = path.basename(projectDir);
			workspacePathCache.set(projectDir, decodeProjectHash(dirName));
		}
		return workspacePathCache.get(projectDir) ?? undefined;
	}

	/** Find persistent agent linked to a session ID (array-aware) */
	function findPersistentAgentBySession(sessionId: string): PersistentAgent | undefined {
		return findAgentBySessionId(persistentAgents, sessionId);
	}

	// ── Project scanner ──────────────────────────────────────
	const scanner = new ProjectScanner({
		onNewSession(projectDir, jsonlFile, projectName) {
			if (!agentManager.hasSession(jsonlFile)) {
				const workspacePath = getWorkspacePath(projectDir);
				addKnownProject(projectName, workspacePath || projectDir);
				const sessionId = path.basename(jsonlFile, '.jsonl');
				let pa = findPersistentAgentBySession(sessionId);

				// Durable fallback: if no agent currently claims this session in
				// memory, session_history may still remember its original owner from
				// before a transient ps-aux failure / over-eager prune cleared their
				// currentSessions. Re-attach to that employee instead of minting a
				// duplicate provisional named "Angela" / "Michael 2" / etc.
				if (!pa) {
					const ownerId = lookupSessionOwner(sessionId);
					if (ownerId) {
						const recovered = persistentAgents.find(p => p.id === ownerId);
						if (recovered) {
							addAgentSession(recovered, { sessionId });
							savePersistentAgents(persistentAgents);
							console.log(`[Standalone] Recovered session ${sessionId} → "${recovered.name}" (${recovered.id}) via session_history`);
							pa = recovered;
						}
					}
				}

				// "Needs the who's-this popup" when there's no owning agent at all,
				// OR the owning agent is still unidentified (no job title/description).
				// The latter covers the restart case: a provisional agent minted on a
				// previous boot was persisted to the DB, so on this boot the session
				// matches it — but it's still nobody, so we must ask again instead of
				// silently adopting it under its throwaway random name.
				const needsIdentification = !pa || isUnidentified(pa);

				// A genuinely new session — mint a provisional agent so the office
				// shows activity immediately, then ask the user who it is via the
				// newWorkerIdentified popup. The user either adopts an existing
				// employee (handleIdentifyWorker re-binds + deletes this provisional)
				// or names it as a new hire.
				if (!pa) {
					pa = {
						id: crypto.randomUUID(),
						name: pickRandomName(persistentAgents),
						roleShort: '',
						roleFull: '',
						workspacePath: workspacePath || '',
					};
					addAgentSession(pa, { sessionId });
					persistentAgents.push(pa);
					savePersistentAgents(persistentAgents);
					console.log(`[Standalone] Auto-persisted new agent "${pa.name}" (${pa.id}) for session ${sessionId}`);
				}

				agentManager.addSession(projectDir, jsonlFile, projectName, workspacePath, pa.id, {
					name: pa.name,
					palette: pa.palette,
					hueShift: pa.hueShift,
					seatId: pa.seatId,
					roleShort: pa.roleShort,
					roleFull: pa.roleFull,
					workspacePath: pa.workspacePath,
					persistentAgentId: pa.id,
					avatarConfig: pa.avatarConfig,
					sessionCount: pa.sessionCount,
					lastSessionEnd: pa.lastSessionEnd,
				});

				if (needsIdentification) {
					broadcastSink.postMessage(buildNewWorkerPopup(persistentAgents, sessionId, pa, projectName, workspacePath || ''));
				}

				broadcastSink.postMessage({ type: 'knownProjects', projects: loadKnownProjects() });
				broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
			}
		},
		onSessionStale(jsonlFile) {
			// Update persistent agent session history before removing
			const sessionId = path.basename(jsonlFile, '.jsonl');
			const pa = findPersistentAgentBySession(sessionId);
			if (pa) {
				// Remove just THIS session (the agent may still be running others).
				// The removed entry carries the ticket this specific task held.
				const removed = removeAgentSession(pa, sessionId);
				const completedTicket = removed?.ticketId ? {
					ticketId: removed.ticketId,
					ticketName: removed.ticketName || '',
					ticketUrl: removed.ticketUrl || '',
					designerName: pa.name,
					workspacePath: pa.workspacePath,
				} : null;

				pa.lastSessionEnd = new Date().toISOString();
				pa.sessionCount = (pa.sessionCount || 0) + 1;
				if (removed?.ticketId) {
					pa.lastTicketId = removed.ticketId;
				}
				savePersistentAgents(persistentAgents);

				// Release the dispatch claim if this session held one. On hub this
				// lets the next autoPickup cycle see the slot as free; on workers
				// the hub releases its own claim via the forwarded session-end
				// messages below, so releasing locally here is also fine (the
				// worker-side registry is a no-op in practice).
				if (completedTicket) {
					releaseTicket(ctx.dispatchRegistry, completedTicket.ticketId);
				}

				const isDesignRole = pa.roleShort === VISUAL_DESIGNER_ROLE_SHORT
					|| pa.roleShort === DESIGNER_ROLE_SHORT
					|| pa.roleShort === VISUAL_QA_ROLE_SHORT
					|| pa.roleShort === JAN_ROLE_SHORT;

				if (isWorkerMode && isDesignRole) {
					// On a remote worker: forward the session-end to the hub so Jan
					// can pick up the next step (Visual QA for finished Visual
					// Designer output, next revision for Jan-owned tickets).
					reportDesignerSessionEndedToHub({
						agentRole: pa.roleShort ?? '',
						ticketId: completedTicket?.ticketId ?? '',
						ticketName: completedTicket?.ticketName ?? '',
						ticketUrl: completedTicket?.ticketUrl ?? '',
						designerName: pa.name,
						workspacePath: pa.workspacePath,
					}, ctx);
				} else if (isWorkerMode && pa.name === 'Darryl' && completedTicket) {
					// On a remote worker: Darryl's session for a hub-dispatched ticket
					// just ended. Report back immediately so the hub releases its
					// own claim and frees the worker's slot.
					reportTicketCompleteToHub(completedTicket.ticketId, ctx);
				}
				// No reactive auto-dispatch on session end. Follow-up work
				// (revisions, AI review, next batch) will be picked up by the
				// next 3-min ClickUp poll or a manual refresh from the kantoor
				// interface — never by a session-end event.
			}
			agentManager.removeSession(jsonlFile);
			broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
		},
	});
	scanner.start();

	// ── ClickUp polling (hub only) ──────────────────────────
	if (!isWorkerMode && ctx.clickupConfig) {
		handleClickupRefresh(ctx).catch(() => {});
		startClickupPolling(ctx);
	}

	// ── HTTP server ──────────────────────────────────────────
	const server = createHttpServer(ctx);

	// ── WebSocket server ─────────────────────────────────────
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req, socket, head) => {
		if (req.url === '/ws') {
			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit('connection', ws, req);
			});
		} else {
			socket.destroy();
		}
	});

	// Track worker WebSocket clients separately
	const workerClients = new Set<WebSocket>();

	wss.on('connection', (ws: WebSocket) => {
		// We don't know if it's a webview or worker yet — add to webview by default
		// Worker clients identify themselves via 'workerRegister' message
		webviewClients.add(ws);
		console.log(`[Standalone] WebSocket client connected (${webviewClients.size} webview)`);

		ws.on('message', (raw) => {
			try {
				const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
				const msgType = msg.type as string;

				// Worker messages (hub-side only)
				if (WORKER_MESSAGE_TYPES.has(msgType)) {
					// Move from webview to worker set on first worker message
					if (!workerClients.has(ws)) {
						webviewClients.delete(ws);
						workerClients.add(ws);
						console.log(`[Standalone] Client identified as worker (${workerClients.size} workers, ${webviewClients.size} webview)`);
					}

					if (msgType === 'workerRegister') registerWorker(ws, msg, ctx);
					else if (msgType === 'workerHeartbeat') handleWorkerHeartbeat(ws, ctx);
					else if (msgType === 'ticketStarted') handleTicketStarted(ws, msg, ctx);
					else if (msgType === 'ticketComplete') handleTicketComplete(ws, msg, ctx);
					else if (msgType === 'ticketFailed') handleTicketFailed(ws, msg, ctx);
					else if (msgType === 'workerResponse') handleWorkerResponse(ws, msg, ctx);
					else if (msgType === 'designerSessionEnded') handleDesignerSessionEnded(msg, ctx, ws);
					return;
				}

				// Regular webview messages
				handleClientMessage(ws, msg, ctx);
			} catch {
				// Ignore malformed messages
			}
		});

		ws.on('close', () => {
			if (workerClients.has(ws)) {
				workerClients.delete(ws);
				handleWorkerDisconnect(ws, ctx);
				console.log(`[Standalone] Worker disconnected (${workerClients.size} workers)`);
			} else {
				webviewClients.delete(ws);
				console.log(`[Standalone] WebSocket client disconnected (${webviewClients.size} webview)`);
			}
		});
	});

	// ── Worker heartbeat checker (hub only) ──────────────────
	let heartbeatChecker: ReturnType<typeof setInterval> | null = null;
	if (!isWorkerMode) {
		heartbeatChecker = setInterval(() => checkWorkerHeartbeats(ctx), 30_000);
	}

	// Listen on all interfaces so workers/browsers on the network can connect
	const listenHost = isWorkerMode ? '127.0.0.1' : '0.0.0.0';

	server.listen(SERVER_PORT, listenHost, () => {
		console.log(`\n  Pixel Agents standalone server`);
		console.log(`  Mode: ${isWorkerMode ? 'WORKER' : 'HUB'}`);
		console.log(`  Identity: ${workerIdentity.name} (${workerIdentity.color})`);
		console.log(`  Listening on http://${listenHost === '0.0.0.0' ? 'localhost' : listenHost}:${SERVER_PORT}\n`);
		if (isWorkerMode) {
			console.log(`  Hub: ${cliArgs.hubUrl}\n`);
		}
		if (ctx.noLocalDev) {
			console.log(`  Dev dispatch: workers-only (--no-local-dev) — Darryl will never run dev work on the hub.\n`);
		} else if (ctx.serialDev) {
			console.log(`  Dev dispatch: serial (--serial-dev) — one dev session at a time on this machine.\n`);
		}
		console.log(`  Watching ~/.claude/projects/ for agent sessions...\n`);
	});

	// ── Worker mode: connect to hub ─────────────────────────
	if (isWorkerMode && cliArgs.hubUrl) {
		const hubUrl = cliArgs.hubUrl.startsWith('http') ? cliArgs.hubUrl : `http://${cliArgs.hubUrl}`;
		const workerRoles = workerIdentity.roles ?? [...DEFAULT_WORKER_ROLES];
		startWorkerMode(hubUrl, workerIdentity.name, workerIdentity.color, ctx, workerRoles);
	}

	// Graceful shutdown
	process.on('SIGINT', () => {
		console.log('\n[Standalone] Shutting down...');
		if (ctx.clickupTimer) clearInterval(ctx.clickupTimer);
		if (heartbeatChecker) clearInterval(heartbeatChecker);
		if (isWorkerMode) stopWorkerMode();
		scanner.stop();
		agentManager.dispose();
		wss.close();
		server.close();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error('[Standalone] Fatal error:', err);
	process.exit(1);
});
