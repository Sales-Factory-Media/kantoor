import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { MessageSink } from '../src/types.js';
import {
	loadFurnitureAssets,
	loadFloorTiles,
	loadWallTiles,
	loadCharacterSprites,
} from '../src/assetLoader.js';
import { loadKnownProjects, addKnownProject, removeKnownProjectByName } from '../src/projectStore.js';
import { SERVER_PORT, CLICKUP_POLL_INTERVAL_MS } from './constants.js';
import { ProjectScanner, decodeProjectHash } from './projectScanner.js';
import { StandaloneAgentManager } from './standaloneAgentManager.js';
import { focusItermSession, launchItermSession, launchAgentSession } from './itermFocus.js';
import {
	loadPersistentAgents,
	savePersistentAgents,
	pickRandomName,
	ensureAgentMemory,
	deleteAgentData,
	buildSystemPrompt,
} from './agentStore.js';
import type { PersistentAgent } from './agentStore.js';
import type { OfflineAgent } from './types.js';
import { fetchListTasks } from './clickupClient.js';
import type { ClickUpConfig, ClickUpStatusGroup } from './clickupClient.js';

// ── Paths ────────────────────────────────────────────────────
const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
const SEATS_FILE = path.join(SETTINGS_DIR, 'seats.json');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

// Webview dist directory (built by Vite)
const WEBVIEW_DIR = path.join(__dirname, 'webview');

// Assets directory
const ASSETS_DIR = path.join(__dirname, 'assets');

// ── Persistence & offline agent helpers (extracted for testability) ──
import { readJson, writeJson, getOfflineAgents } from './serverHelpers.js';

// ── Pre-load assets ──────────────────────────────────────────
interface PreloadedAssets {
	characterSprites: unknown | null;
	floorTiles: unknown | null;
	wallTiles: unknown | null;
	furnitureAssets: { catalog: unknown; sprites: Map<string, string[][]> } | null;
}

async function preloadAssets(): Promise<PreloadedAssets> {
	const assetsRoot = fs.existsSync(path.join(ASSETS_DIR)) ? path.dirname(ASSETS_DIR) : null;
	if (!assetsRoot) {
		console.log('[Standalone] No assets directory found at', ASSETS_DIR);
		return { characterSprites: null, floorTiles: null, wallTiles: null, furnitureAssets: null };
	}

	console.log('[Standalone] Loading assets from', assetsRoot);
	const characterSprites = await loadCharacterSprites(assetsRoot);
	const floorTiles = await loadFloorTiles(assetsRoot);
	const wallTiles = await loadWallTiles(assetsRoot);
	const furnitureAssets = await loadFurnitureAssets(assetsRoot);

	return { characterSprites, floorTiles, wallTiles, furnitureAssets };
}

// ── Server context ───────────────────────────────────────────
interface ServerContext {
	agentManager: StandaloneAgentManager;
	assets: PreloadedAssets;
	broadcastSink: MessageSink;
	persistentAgents: PersistentAgent[];
	setPersistentAgents: (agents: PersistentAgent[]) => void;
	clickupConfig: ClickUpConfig | null;
	clickupTickets: ClickUpStatusGroup[];
	clickupTimer: ReturnType<typeof setInterval> | null;
}

// ── Launch helper (shared by saveAgentIdentity + launchAgent) ─
function launchPersistentAgent(pa: PersistentAgent, persistentAgents: PersistentAgent[], callInTask?: string): boolean {
	const newSessionId = crypto.randomUUID();
	pa.currentSessionId = newSessionId;
	savePersistentAgents(persistentAgents);

	const prompt = buildSystemPrompt(pa);
	const cwd = pa.workspacePath || os.homedir();
	console.log(`[Standalone] Launching agent "${pa.name}" with session ${newSessionId} in ${cwd}${callInTask ? ` with task: ${callInTask}` : ''}`);
	return launchAgentSession(newSessionId, cwd, prompt, callInTask);
}

function startClickupPolling(ctx: ServerContext): void {
	if (ctx.clickupTimer) return; // already polling
	if (!ctx.clickupConfig) return;
	console.log('[Standalone] Starting ClickUp polling...');
	ctx.clickupTimer = setInterval(() => { handleClickupRefresh(ctx).catch(() => {}); }, CLICKUP_POLL_INTERVAL_MS);
}

// ── Message handlers ─────────────────────────────────────────

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

	// Send offline agents
	ws.send(JSON.stringify({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) }));

	// Send current tool/waiting statuses
	const wsSink: MessageSink = { postMessage: (m) => ws.send(JSON.stringify(m)) };
	agentManager.sendAgentStatuses(wsSink);

	// Send ClickUp state
	ws.send(JSON.stringify({ type: 'clickupConfigured', configured: !!ctx.clickupConfig, listId: ctx.clickupConfig?.listId }));
	if (ctx.clickupTickets.length > 0) {
		ws.send(JSON.stringify({ type: 'clickupTickets', statuses: ctx.clickupTickets }));
	}
}

function handleFocusAgent(msg: Record<string, unknown>, ctx: ServerContext): void {
	const agentId = msg.id as number;
	const sessionId = ctx.agentManager.getSessionIdForAgent(agentId);
	if (sessionId) {
		const focused = focusItermSession(sessionId);
		if (!focused) {
			console.log(`[Standalone] Could not focus iTerm session for agent ${agentId}`);
		}
	}
}

function handleSaveAgentSeats(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { agentManager, persistentAgents } = ctx;
	const seats = msg.seats as Record<string, Record<string, unknown>>;

	// Enrich with project info from live agents
	for (const agent of agentManager.agents.values()) {
		const entry = seats[agent.sessionId];
		if (entry) {
			entry.projectDir = agent.projectDir;
			entry.projectName = agent.projectName;
			if (agent.workspacePath) {
				entry.workspacePath = agent.workspacePath;
			}
		}
	}
	writeJson(SEATS_FILE, seats);

	// Sync persistent agent metadata from seat saves
	let changed = false;
	for (const agent of agentManager.agents.values()) {
		if (!agent.persistentAgentId) continue;
		const pa = persistentAgents.find(p => p.id === agent.persistentAgentId);
		const seatData = seats[agent.sessionId] as Record<string, unknown> | undefined;
		if (pa && seatData) {
			if (seatData.palette !== undefined) pa.palette = seatData.palette as number;
			if (seatData.hueShift !== undefined) pa.hueShift = seatData.hueShift as number;
			if (seatData.seatId !== undefined) pa.seatId = seatData.seatId as string;
			if (seatData.name !== undefined) pa.name = seatData.name as string;
			if (seatData.roleShort !== undefined) pa.roleShort = seatData.roleShort as string;
			if (seatData.roleFull !== undefined) pa.roleFull = seatData.roleFull as string;
			changed = true;
		}
	}
	if (changed) {
		savePersistentAgents(persistentAgents);
	}
}

function handleSaveAgentIdentity(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, broadcastSink, agentManager, setPersistentAgents } = ctx;
	const agentData = msg.agent as { id?: string; name: string; roleShort: string; roleFull: string; workspacePath: string; palette?: number; hueShift?: number; seatId?: string; currentSessionId?: string };
	const shouldLaunch = msg.launch as boolean | undefined;
	const isNew = !agentData.id;
	const agentId = agentData.id || crypto.randomUUID();

	const existing = persistentAgents.find(p => p.id === agentId);
	if (existing) {
		existing.name = agentData.name;
		existing.roleShort = agentData.roleShort;
		existing.roleFull = agentData.roleFull;
		existing.workspacePath = agentData.workspacePath;
		if (agentData.palette !== undefined) existing.palette = agentData.palette;
		if (agentData.hueShift !== undefined) existing.hueShift = agentData.hueShift;
		if (agentData.seatId !== undefined) existing.seatId = agentData.seatId;
	} else {
		const newAgent: PersistentAgent = {
			id: agentId,
			name: agentData.name,
			roleShort: agentData.roleShort,
			roleFull: agentData.roleFull,
			workspacePath: agentData.workspacePath,
			palette: agentData.palette,
			hueShift: agentData.hueShift,
			seatId: agentData.seatId,
			currentSessionId: agentData.currentSessionId,
		};
		persistentAgents.push(newAgent);
	}

	ensureAgentMemory(agentId);
	savePersistentAgents(persistentAgents);
	setPersistentAgents(persistentAgents);
	console.log(`[Standalone] ${isNew ? 'Created' : 'Updated'} persistent agent: ${agentData.name} (${agentId})`);

	broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
	broadcastSink.postMessage({ type: 'agentIdentitySaved', agentId, agent: persistentAgents.find(p => p.id === agentId) });

	if (shouldLaunch) {
		const pa = persistentAgents.find(p => p.id === agentId)!;
		if (!launchPersistentAgent(pa, persistentAgents)) {
			console.log(`[Standalone] Failed to launch agent session for ${pa.name}`);
		}
	}
}

function handleDeleteAgentIdentity(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, broadcastSink, agentManager, setPersistentAgents } = ctx;
	const agentId = msg.agentId as string;
	console.log(`[Standalone] Deleting persistent agent ${agentId}`);
	const updated = persistentAgents.filter(p => p.id !== agentId);
	savePersistentAgents(updated);
	setPersistentAgents(updated);
	deleteAgentData(agentId);
	broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, updated) });
}

function handleLaunchAgent(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents } = ctx;
	const agentId = msg.agentId as string;
	const callInTask = msg.callInTask as string | undefined;
	const useTeam = msg.useTeam as boolean | undefined;
	const pa = persistentAgents.find(p => p.id === agentId);
	if (!pa) {
		console.log(`[Standalone] Persistent agent ${agentId} not found`);
		return;
	}
	ensureAgentMemory(agentId);
	const task = useTeam && callInTask
		? `${callInTask}\n\nCreate an agent team to work on this. Break the work into parallel tasks and spawn teammates to handle them.`
		: callInTask;
	if (!launchPersistentAgent(pa, persistentAgents, task)) {
		console.log(`[Standalone] Failed to launch agent session for ${pa.name}`);
	}
}

function handleRestartAgent(msg: Record<string, unknown>): void {
	const sessionId = msg.sessionId as string;
	const workspacePath = msg.workspacePath as string | undefined;
	console.log(`[Standalone] Restarting session ${sessionId} in ${workspacePath || '~'}`);
	const launched = launchItermSession(sessionId, workspacePath);
	if (!launched) {
		console.log(`[Standalone] Failed to launch iTerm session for ${sessionId}`);
	}
}

function handleForgetAgent(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents, broadcastSink, agentManager } = ctx;
	const sessionId = msg.sessionId as string;
	console.log(`[Standalone] Forgetting agent ${sessionId}`);
	const seats = readJson(SEATS_FILE) as Record<string, unknown> | null;
	if (seats && sessionId in seats) {
		delete seats[sessionId];
		writeJson(SEATS_FILE, seats);
	}
	broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
}

function handleRemoveRoom(msg: Record<string, unknown>, ctx: ServerContext): void {
	const roomName = msg.roomName as string;
	if (!roomName) return;
	console.log(`[Standalone] Removing room: ${roomName}`);
	removeKnownProjectByName(roomName);
	ctx.broadcastSink.postMessage({ type: 'knownProjects', projects: loadKnownProjects() });
}

function handleSetSoundEnabled(msg: Record<string, unknown>): void {
	const settings = readJson(SETTINGS_FILE) ?? {};
	writeJson(SETTINGS_FILE, { ...settings, soundEnabled: msg.enabled });
}

let clickupRefreshInFlight = false;

async function handleClickupRefresh(ctx: ServerContext): Promise<void> {
	if (!ctx.clickupConfig) return;
	if (clickupRefreshInFlight) return;
	clickupRefreshInFlight = true;
	try {
		const statuses = await fetchListTasks(ctx.clickupConfig);
		ctx.clickupTickets = statuses;
		ctx.broadcastSink.postMessage({ type: 'clickupTickets', statuses });
	} catch (err) {
		console.error('[Standalone] ClickUp fetch error:', err);
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: String(err) });
	} finally {
		clickupRefreshInFlight = false;
	}
}

function handleClickupStartWork(msg: Record<string, unknown>, ctx: ServerContext): void {
	const { persistentAgents } = ctx;
	const agentId = msg.agentId as string;
	const ticketId = msg.ticketId as string;
	const ticketName = msg.ticketName as string;
	const ticketUrl = msg.ticketUrl as string;
	const useTeam = msg.useTeam as boolean | undefined;
	const additionalPrompt = msg.additionalPrompt as string | undefined;

	const pa = persistentAgents.find(p => p.id === agentId);
	if (!pa) {
		console.log(`[Standalone] Persistent agent ${agentId} not found for ClickUp task`);
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: `Agent not found: ${agentId}` });
		return;
	}

	let callInTask = `Work on ClickUp ticket ${ticketId}: "${ticketName}". Use the ClickUp MCP tools to read the ticket details, update status, and add comments as you make progress. Ticket URL: ${ticketUrl}`;

	if (additionalPrompt) {
		callInTask += `\n\n## Additional Instructions\n\n${additionalPrompt}`;
	}

	if (useTeam) {
		callInTask += '\n\nCreate an agent team to work on this ticket. Break the work into parallel tasks and spawn teammates to handle them.';
	}

	ensureAgentMemory(agentId);
	if (!launchPersistentAgent(pa, persistentAgents, callInTask)) {
		console.log(`[Standalone] Failed to launch agent for ClickUp task ${ticketId}`);
	}
}

function handleClickupConfigure(msg: Record<string, unknown>, ctx: ServerContext): void {
	const rawListId = msg.listId;
	const rawApiToken = msg.apiToken;

	if (typeof rawListId !== 'string' || rawListId.trim().length === 0) {
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: 'Invalid ClickUp configuration: listId must be a non-empty string.' });
		return;
	}

	const incomingApiToken = typeof rawApiToken === 'string' ? rawApiToken.trim() : '';
	const effectiveApiToken = incomingApiToken || ctx.clickupConfig?.apiToken || '';

	if (!effectiveApiToken) {
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: 'Invalid ClickUp configuration: apiToken must be a non-empty string.' });
		return;
	}

	const settings = readJson(SETTINGS_FILE) ?? {};
	const config: ClickUpConfig = {
		apiToken: effectiveApiToken,
		listId: rawListId.trim(),
	};
	writeJson(SETTINGS_FILE, { ...settings, clickup: config });
	ctx.clickupConfig = config;
	ctx.broadcastSink.postMessage({ type: 'clickupConfigured', configured: true, listId: config.listId });

	// Start polling if not already running
	startClickupPolling(ctx);

	// Immediately fetch
	handleClickupRefresh(ctx).catch(() => {});
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
	clickupRefresh: (_ws, _msg, ctx) => { handleClickupRefresh(ctx).catch(() => {}); },
	clickupStartWork: (_ws, msg, ctx) => handleClickupStartWork(msg, ctx),
	clickupConfigure: (_ws, msg, ctx) => handleClickupConfigure(msg, ctx),
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
	const assets = await preloadAssets();

	const agentManager = new StandaloneAgentManager();
	let persistentAgents = loadPersistentAgents();

	// ── WebSocket broadcast sink ─────────────────────────────
	const clients = new Set<WebSocket>();

	const broadcastSink: MessageSink = {
		postMessage(msg: unknown) {
			const data = JSON.stringify(msg);
			for (const ws of clients) {
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
		clickupTimer: null,
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
				addKnownProject(projectName, projectDir);
				const workspacePath = getWorkspacePath(projectDir);
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
				pa.lastSessionEnd = new Date().toISOString();
				pa.sessionCount = (pa.sessionCount || 0) + 1;
				pa.currentSessionId = undefined;
				savePersistentAgents(persistentAgents);
			}
			agentManager.removeSession(jsonlFile);
			broadcastSink.postMessage({ type: 'offlineAgents', agents: getOfflineAgents(agentManager, persistentAgents) });
		},
	});
	scanner.start();

	// ── ClickUp polling ─────────────────────────────────────
	if (ctx.clickupConfig) {
		handleClickupRefresh(ctx).catch(() => {});
		startClickupPolling(ctx);
	}

	// ── HTTP server ──────────────────────────────────────────
	const server = createHttpServer();

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

	wss.on('connection', (ws: WebSocket) => {
		clients.add(ws);
		console.log(`[Standalone] WebSocket client connected (${clients.size} total)`);

		ws.on('message', (raw) => {
			try {
				const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
				handleClientMessage(ws, msg, ctx);
			} catch {
				// Ignore malformed messages
			}
		});

		ws.on('close', () => {
			clients.delete(ws);
			console.log(`[Standalone] WebSocket client disconnected (${clients.size} total)`);
		});
	});

	server.listen(SERVER_PORT, () => {
		console.log(`\n  Pixel Agents standalone server`);
		console.log(`  Listening on http://localhost:${SERVER_PORT}\n`);
		console.log(`  Watching ~/.claude/projects/ for agent sessions...\n`);
	});

	// Graceful shutdown
	process.on('SIGINT', () => {
		console.log('\n[Standalone] Shutting down...');
		if (ctx.clickupTimer) clearInterval(ctx.clickupTimer);
		scanner.stop();
		agentManager.dispose();
		wss.close();
		server.close();
		process.exit(0);
	});
}

// ── HTTP server factory ──────────────────────────────────────
const MIME_TYPES: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
};

function createHttpServer(): http.Server {
	return http.createServer((req, res) => {
		let urlPath = req.url || '/';

		// Strip query strings
		const qIdx = urlPath.indexOf('?');
		if (qIdx >= 0) urlPath = urlPath.slice(0, qIdx);

		// Default to index.html
		if (urlPath === '/') urlPath = '/index.html';

		const filePath = path.join(WEBVIEW_DIR, urlPath);

		// Security: prevent path traversal
		if (!filePath.startsWith(WEBVIEW_DIR)) {
			res.writeHead(403);
			res.end('Forbidden');
			return;
		}

		try {
			if (!fs.existsSync(filePath)) {
				res.writeHead(404);
				res.end('Not Found');
				return;
			}

			const ext = path.extname(filePath);
			const contentType = MIME_TYPES[ext] || 'application/octet-stream';
			const content = fs.readFileSync(filePath);
			res.writeHead(200, { 'Content-Type': contentType });
			res.end(content);
		} catch {
			res.writeHead(500);
			res.end('Internal Server Error');
		}
	});
}

main().catch((err) => {
	console.error('[Standalone] Fatal error:', err);
	process.exit(1);
});
