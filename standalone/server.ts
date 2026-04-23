import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { MessageSink } from '../src/types.js';
import { loadKnownProjects, addKnownProject } from '../src/projectStore.js';
import { SERVER_PORT, DESIGNER_ROLE_SHORT, VISUAL_DESIGNER_ROLE_SHORT, VISUAL_QA_ROLE_SHORT, JAN_ROLE_SHORT, REVIEW_TRIGGER_DELAY_MS, DEFAULT_WORKER_ROLES, AI_REVIEW_AUTO_ESCALATE } from './constants.js';
import { ProjectScanner, decodeProjectHash, getLiveSessionIds } from './projectScanner.js';
import { StandaloneAgentManager } from './standaloneAgentManager.js';
import {
	loadPersistentAgents,
	savePersistentAgents,
	pickRandomName,
	ensureAgentMemory,
	seedDesignTeams,
	getAgentMemoryPath,
} from './agentStore.js';
import { buildOrganogram } from './organogram.js';
import type { PersistentAgent } from './agentStore.js';
import type { ClickUpConfig } from './clickupClient.js';
import { readJson, writeJson, getOfflineAgents } from './serverHelpers.js';
import { preloadAssets, SEATS_FILE, SETTINGS_FILE, WORKER_IDENTITY_FILE } from './serverContext.js';
import type { ServerContext, WorkerIdentity } from './serverContext.js';
import {
	handleFocusAgent,
	handleSaveAgentSeats,
	handleSaveAgentIdentity,
	handleDeleteAgentIdentity,
	handleLaunchAgent,
	handleRestartAgent,
	handleForgetAgent,
	handleRemoveRoom,
	handleSetSoundEnabled,
	handleUpdateProjectDescription,
	getJanDesignConfig,
	handleSetJanDesignConfig,
} from './agentHandlers.js';
import {
	startClickupPolling,
	handleClickupRefresh,
	handleClickupStartWork,
	handleClickupConfigure,
	handleDarrylHandleTicket,
	handleJanDesignBriefing,
	handleLaunchDesigner,
	handleLaunchVisualDesigner,
	handleJanReviewDesigner,
	handleVisualQaReview,
	handleDesignerSessionEnded,
	autoVisualQaPickup,
	autoDesignerRevisionPickup,
	autoDarrylPickup,
	autoJanPickup,
} from './clickupHandlers.js';
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
import { startWorkerMode, stopWorkerMode, reportDesignerSessionEndedToHub } from './workerMode.js';

// ── CLI argument parsing ────────────────────────────────────

function parseCliArgs(): { hubUrl: string | null; name: string | null; color: string | null; roles: string[] | null } {
	const args = process.argv.slice(2);
	let hubUrl: string | null = null;
	let name: string | null = null;
	let color: string | null = null;
	let roles: string[] | null = null;

	for (const arg of args) {
		if (arg.startsWith('--hub=')) hubUrl = arg.slice('--hub='.length);
		else if (arg.startsWith('--name=')) name = arg.slice('--name='.length);
		else if (arg.startsWith('--color=')) color = arg.slice('--color='.length);
		else if (arg.startsWith('--roles=')) {
			roles = arg.slice('--roles='.length).split(',').map(r => r.trim()).filter(r => r.length > 0);
		}
	}

	// Also check env vars as fallback
	if (!hubUrl && process.env.HUB) hubUrl = process.env.HUB;
	if (!roles && process.env.WORKER_ROLES) {
		roles = process.env.WORKER_ROLES.split(',').map(r => r.trim()).filter(r => r.length > 0);
	}

	return { hubUrl, name, color, roles };
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
	const seatsData = readJson(SEATS_FILE) ?? {};
	for (const [sid, rawMeta] of Object.entries(seatsData)) {
		agentMeta[sid] = rawMeta as Record<string, unknown>;
	}
	for (const pa of persistentAgents) {
		if (pa.currentSessionId) {
			agentMeta[pa.currentSessionId] = {
				...agentMeta[pa.currentSessionId],
				name: pa.name,
				palette: pa.palette,
				hueShift: pa.hueShift,
				seatId: pa.seatId,
				roleShort: pa.roleShort,
				roleFull: pa.roleFull,
				workspacePath: pa.workspacePath,
				persistentAgentId: pa.id,
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
	}));

	// Signal layout ready
	ws.send(JSON.stringify({ type: 'layoutLoaded', layout: null }));

	// Send settings
	const settings = readJson(SETTINGS_FILE);
	const soundEnabled = settings?.soundEnabled !== false;
	ws.send(JSON.stringify({ type: 'settingsLoaded', soundEnabled }));

	// Send Jan's design config
	ws.send(JSON.stringify({ type: 'janDesignConfigLoaded', config: getJanDesignConfig() }));

	// Send offline agents
	ws.send(JSON.stringify({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) }));

	// Send current tool/waiting statuses
	const wsSink: MessageSink = { postMessage: (m) => ws.send(JSON.stringify(m)) };
	agentManager.sendAgentStatuses(wsSink);

	// Send ClickUp state
	ws.send(JSON.stringify({ type: 'clickupConfigured', configured: !!ctx.clickupConfig, listId: ctx.clickupConfig?.listId }));
	if (ctx.clickupTickets.length > 0) {
		ws.send(JSON.stringify({ type: 'clickupTickets', statuses: ctx.clickupTickets, nextFetchAt: ctx.clickupNextFetchAt }));
	}

	// Check peers broker availability
	fetch(PEERS_BROKER_URL + '/health')
		.then(() => ws.send(JSON.stringify({ type: 'peersBrokerStatus', available: true })))
		.catch(() => ws.send(JSON.stringify({ type: 'peersBrokerStatus', available: false })));

	// Send worker status
	broadcastWorkerStatus(ctx);

	// Send organogram snapshot
	ws.send(JSON.stringify({ type: 'organogramSnapshot', organogram: buildOrganogram(persistentAgents) }));

	// Try auto-pickup on client connect (agents may have become free since last poll)
	if (!ctx.isWorkerMode) {
		autoDarrylPickup(ctx);
		autoJanPickup(ctx);
		autoDesignerRevisionPickup(ctx);
	}
}

// ── Message dispatch ─────────────────────────────────────────

const messageHandlers: Record<string, (ws: WebSocket, msg: Record<string, unknown>, ctx: ServerContext) => void> = {
	webviewReady: (ws, _msg, ctx) => handleWebviewReady(ws, ctx),
	focusAgent: (_ws, msg, ctx) => handleFocusAgent(msg, ctx),
	saveAgentSeats: (_ws, msg, ctx) => handleSaveAgentSeats(msg, ctx),
	saveAgentIdentity: (_ws, msg, ctx) => handleSaveAgentIdentity(msg, ctx),
	deleteAgentIdentity: (_ws, msg, ctx) => handleDeleteAgentIdentity(msg, ctx),
	launchAgent: (_ws, msg, ctx) => handleLaunchAgent(msg, ctx),
	restartAgent: (_ws, msg) => handleRestartAgent(msg),
	forgetAgent: (_ws, msg, ctx) => handleForgetAgent(msg, ctx),
	removeRoom: (_ws, msg, ctx) => handleRemoveRoom(msg, ctx),
	setSoundEnabled: (_ws, msg) => handleSetSoundEnabled(msg),
	setJanDesignConfig: (_ws, msg, ctx) => handleSetJanDesignConfig(msg, ctx),
	clickupRefresh: (_ws, _msg, ctx) => { handleClickupRefresh(ctx).catch(() => {}); },
	clickupStartWork: (_ws, msg, ctx) => handleClickupStartWork(msg, ctx),
	clickupConfigure: (_ws, msg, ctx) => handleClickupConfigure(msg, ctx),
	startConference: (_ws, msg, ctx) => handleStartConference(msg, ctx),
	endConference: (_ws, msg, ctx) => handleEndConference(msg, ctx),
	updateProjectDescription: (_ws, msg, ctx) => handleUpdateProjectDescription(msg, ctx),
	darrylHandleTicket: (_ws, msg, ctx) => handleDarrylHandleTicket(msg, ctx),
	janDesignBriefing: (_ws, msg, ctx) => handleJanDesignBriefing(msg, ctx),
	launchDesigner: (_ws, msg, ctx) => {
		handleLaunchDesigner(msg, ctx).then(result => {
			ctx.broadcastSink.postMessage({ type: 'designerLaunched', ...result });
		}).catch(err => {
			ctx.broadcastSink.postMessage({ type: 'designerLaunched', success: false, error: String(err) });
		});
	},
	launchVisualDesigner: (_ws, msg, ctx) => {
		handleLaunchVisualDesigner(msg, ctx).then(result => {
			ctx.broadcastSink.postMessage({ type: 'visualDesignerLaunched', ...result });
		}).catch(err => {
			ctx.broadcastSink.postMessage({ type: 'visualDesignerLaunched', success: false, error: String(err) });
		});
	},
	getOrganogram: (ws, _msg, ctx) => {
		ws.send(JSON.stringify({ type: 'organogramSnapshot', organogram: buildOrganogram(ctx.persistentAgents) }));
	},
	janReviewDesigner: (_ws, msg, ctx) => handleJanReviewDesigner({
		ticketId: msg.ticketId as string,
		ticketName: (msg.ticketName as string) || '',
		ticketUrl: (msg.ticketUrl as string) || '',
		designerName: (msg.designerName as string) || 'unknown',
		workspacePath: (msg.workspacePath as string) || '',
	}, ctx),
};

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

	const assets = await preloadAssets();

	const agentManager = new StandaloneAgentManager();
	let persistentAgents = loadPersistentAgents();

	// ── Clear stale session IDs on startup ───────────────────
	// Persistent agents may have currentSessionId from a previous server run
	// where the session ended after the server stopped. Clear any that don't
	// have a live claude process.
	const liveOnStartup = getLiveSessionIds();
	let clearedStale = false;
	for (const pa of persistentAgents) {
		if (pa.currentSessionId && !liveOnStartup.has(pa.currentSessionId)) {
			console.log(`[Standalone] Clearing stale session ${pa.currentSessionId} from agent "${pa.name}"`);
			pa.lastSessionEnd = pa.lastSessionEnd || new Date().toISOString();
			pa.currentSessionId = undefined;
			clearedStale = true;
		}
	}
	if (clearedStale) {
		savePersistentAgents(persistentAgents);
	}

	// ── Seed design teams (UX + Visual: 1 PM + 1 QA + 5 workers each) ──
	if (!isWorkerMode) {
		const seeded = seedDesignTeams(persistentAgents);
		if (seeded) {
			savePersistentAgents(persistentAgents);
			console.log('[Standalone] Seeded design teams (UX + Visual)');
		}
	}

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
	const settings = readJson(SETTINGS_FILE) as Record<string, unknown> | null;
	const clickupConfig: ClickUpConfig | null = settings?.clickup
		? settings.clickup as ClickUpConfig
		: null;

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
		// Multi-worker
		isWorkerMode,
		workerIdentity,
		workers: new Map(),
		workerAssignments: isWorkerMode ? [] : loadAssignments(),
		pendingWorkerRequests: new Map(),
		mempalaceServerUrl: null,
		hubWs: null,
	};

	// ── Workspace path cache (decoded from project hash) ────
	const workspacePathCache = new Map<string, string | null>();
	function getWorkspacePath(projectDir: string): string | undefined {
		if (!workspacePathCache.has(projectDir)) {
			const dirName = path.basename(projectDir);
			workspacePathCache.set(projectDir, decodeProjectHash(dirName));
		}
		return workspacePathCache.get(projectDir) ?? undefined;
	}

	/** Find persistent agent linked to a session ID */
	function findPersistentAgentBySession(sessionId: string): PersistentAgent | undefined {
		return persistentAgents.find(pa => pa.currentSessionId === sessionId);
	}

	// ── Project scanner ──────────────────────────────────────
	const scanner = new ProjectScanner({
		onNewSession(projectDir, jsonlFile, projectName) {
			if (!agentManager.hasSession(jsonlFile)) {
				const workspacePath = getWorkspacePath(projectDir);
				addKnownProject(projectName, workspacePath || projectDir);
				const sessionId = path.basename(jsonlFile, '.jsonl');
				let pa = findPersistentAgentBySession(sessionId);

				// Auto-persist newly discovered agents
				if (!pa) {
					pa = {
						id: crypto.randomUUID(),
						name: pickRandomName(persistentAgents),
						roleShort: '',
						roleFull: '',
						workspacePath: workspacePath || '',
						currentSessionId: sessionId,
					};
					persistentAgents.push(pa);
					ensureAgentMemory(pa.id);
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
				});
				broadcastSink.postMessage({ type: 'knownProjects', projects: loadKnownProjects() });
				broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
			}
		},
		onSessionStale(jsonlFile) {
			// Update persistent agent session history before removing
			const sessionId = path.basename(jsonlFile, '.jsonl');
			const pa = findPersistentAgentBySession(sessionId);
			if (pa) {
				// Capture ticket info before clearing
				const completedTicket = pa.currentTicketId ? {
					ticketId: pa.currentTicketId,
					ticketName: pa.currentTicketName || '',
					ticketUrl: pa.currentTicketUrl || '',
					designerName: pa.name,
					workspacePath: pa.workspacePath,
				} : null;

				pa.lastSessionEnd = new Date().toISOString();
				pa.sessionCount = (pa.sessionCount || 0) + 1;
				if (pa.currentTicketId) {
					pa.lastTicketId = pa.currentTicketId;
				}
				pa.currentSessionId = undefined;
				pa.currentTicketId = undefined;
				pa.currentTicketName = undefined;
				pa.currentTicketUrl = undefined;
				savePersistentAgents(persistentAgents);

				const isDesignRole = pa.roleShort === VISUAL_DESIGNER_ROLE_SHORT
					|| pa.roleShort === DESIGNER_ROLE_SHORT
					|| pa.roleShort === VISUAL_QA_ROLE_SHORT
					|| pa.roleShort === JAN_ROLE_SHORT;

				if (isWorkerMode && isDesignRole) {
					// On a remote worker: forward the session-end to the hub so Jan
					// review / Visual QA / revision pickup still trigger centrally.
					let memoryContent: string | undefined;
					try {
						const memPath = getAgentMemoryPath(pa.id);
						if (fs.existsSync(memPath)) {
							memoryContent = fs.readFileSync(memPath, 'utf-8');
						}
					} catch { /* ignore */ }
					reportDesignerSessionEndedToHub({
						agentRole: pa.roleShort ?? '',
						ticketId: completedTicket?.ticketId ?? '',
						ticketName: completedTicket?.ticketName ?? '',
						ticketUrl: completedTicket?.ticketUrl ?? '',
						designerName: pa.name,
						workspacePath: pa.workspacePath,
						updatedMemory: memoryContent,
						agentId: pa.id,
					}, ctx);
				} else {
					// On the hub: trigger the existing local review pipeline.
					if (AI_REVIEW_AUTO_ESCALATE && pa.roleShort === VISUAL_DESIGNER_ROLE_SHORT && completedTicket) {
						console.log(`[Standalone] Visual Designer "${pa.name}" finished ticket ${completedTicket.ticketId}, triggering Visual QA AI Review`);
						setTimeout(() => { handleVisualQaReview(completedTicket, ctx).catch(err => console.error('[Standalone] Visual QA dispatch failed:', err)); }, REVIEW_TRIGGER_DELAY_MS);
					}
					if (pa.roleShort === DESIGNER_ROLE_SHORT && completedTicket) {
						console.log(`[Standalone] UX Designer "${pa.name}" finished ticket ${completedTicket.ticketId}, triggering Jan review`);
						setTimeout(() => handleJanReviewDesigner(completedTicket, ctx), REVIEW_TRIGGER_DELAY_MS);
					}
					if (AI_REVIEW_AUTO_ESCALATE && pa.roleShort === VISUAL_QA_ROLE_SHORT) {
						setTimeout(() => autoDesignerRevisionPickup(ctx), REVIEW_TRIGGER_DELAY_MS);
					}
					if (pa.roleShort === JAN_ROLE_SHORT) {
						setTimeout(() => autoDesignerRevisionPickup(ctx), REVIEW_TRIGGER_DELAY_MS);
					}
				}
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
