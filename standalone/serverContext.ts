import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { MessageSink } from '../src/types.js';
import {
	loadFurnitureAssets,
	loadFloorTiles,
	loadWallTiles,
	loadCharacterSprites,
} from '../src/assetLoader.js';
import type { WebSocket } from 'ws';
import type { StandaloneAgentManager } from './standaloneAgentManager.js';
import type { PersistentAgent } from './agentStore.js';
import type { ClickUpConfig, ClickUpStatusGroup } from '../src/connectors/clickupClient.js';
import type { DispatchRegistry } from './dispatchRegistry.js';
import type { DelegationStore } from './delegationStore.js';
import type { ProjectConnector } from '../src/connectors/types.js';
import type { Building } from '../src/db/schema.js';

// ── Worker types ────────────────────────────────────────────
export interface WorkerInfo {
	name: string;
	color: string;
	hostname: string;
	ws: WebSocket;
	lastHeartbeat: number;
	currentTicketId: string | null;
	currentTicketName: string | null;
	roles: string[]; // e.g. ['dev', 'designer']
}

export interface WorkerAssignment {
	ticketId: string;
	ticketName: string;
	worker: string; // worker name
	workerHost: string;
	startedAt: string;
	status: 'in_progress' | 'completed' | 'failed';
}

export interface WorkerIdentity {
	name: string;
	color: string;
	roles?: string[];
}

export interface PendingWorkerRequest {
	resolve: (result: { success: boolean; error?: string; workerName?: string }) => void;
	timer: ReturnType<typeof setTimeout>;
	workerName: string;
}

// ── Paths ────────────────────────────────────────────────────
export const SETTINGS_DIR = path.join(os.homedir(), '.pixel-agents');
export const SEATS_FILE = path.join(SETTINGS_DIR, 'seats.json');
export const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
export const WORKER_IDENTITY_FILE = path.join(SETTINGS_DIR, 'worker-identity.json');
export const WORKER_ASSIGNMENTS_FILE = path.join(SETTINGS_DIR, 'worker-assignments.json');
export const WEBVIEW_DIR = path.join(__dirname, 'webview');
export const ASSETS_DIR = path.join(__dirname, 'assets');

// ── Pre-loaded assets ────────────────────────────────────────
export interface PreloadedAssets {
	characterSprites: unknown | null;
	floorTiles: unknown | null;
	wallTiles: unknown | null;
	furnitureAssets: { catalog: unknown; sprites: Map<string, string[][]> } | null;
}

export async function preloadAssets(): Promise<PreloadedAssets> {
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
export interface ServerContext {
	agentManager: StandaloneAgentManager;
	assets: PreloadedAssets;
	broadcastSink: MessageSink;
	persistentAgents: PersistentAgent[];
	setPersistentAgents: (agents: PersistentAgent[]) => void;
	clickupConfig: ClickUpConfig | null;
	clickupTickets: ClickUpStatusGroup[];
	clickupNextFetchAt: number | null;
	clickupTimer: ReturnType<typeof setInterval> | null;
	/** Active building's connector. The polling loop uses this. Null if the
	 *  building's connector_config is empty (e.g. PC before GitHub creds). */
	connector: ProjectConnector | null;
	/** Active building metadata exposed to the WS protocol. */
	activeBuilding: Building | null;
	/** All buildings — kept in sync with DB so the WS switcher can list them. */
	allBuildings: Building[];
	// Multi-worker
	isWorkerMode: boolean;
	workerIdentity: WorkerIdentity | null;
	/**
	 * When true, the hub refuses to run dev (Darryl-dispatched) work locally
	 * and always cascades to a remote worker — useful when the hub machine is
	 * also being used for hands-on programming and the user doesn't want
	 * Darryl-launched implementation sessions stealing focus or resources.
	 *
	 * Hub-only flag; ignored on remote workers (they accept whatever the hub
	 * sends them).
	 */
	noLocalDev: boolean;
	workers: Map<string, WorkerInfo>; // keyed by worker name
	workerAssignments: WorkerAssignment[];
	pendingWorkerRequests: Map<string, PendingWorkerRequest>; // keyed by requestId
	// MemPalace (worker-only: URL received from hub during registration)
	mempalaceServerUrl: string | null;
	// Worker-mode: WS connection back to hub, used to forward session-end events
	hubWs: WebSocket | null;
	// In-flight dispatch claims — one entry per ticket currently being worked.
	// Hub-only; workers don't run auto-pickup so their registry is unused.
	// See standalone/dispatchRegistry.ts for semantics.
	dispatchRegistry: DispatchRegistry;
	// Auto Mode: tickets Darryl has classified that are waiting for a human to
	// confirm the worker. Hub-only. See standalone/delegationStore.ts.
	delegationStore: DelegationStore;
}
