import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sql } from 'drizzle-orm';
import { getDb } from './client.js';
import {
	buildings,
	persistentAgents,
	seats,
	projects,
	buildingProjects,
	workerAssignments,
	appSettings,
} from './schema.js';

/**
 * One-shot import of legacy JSON state into the database. Runs on every
 * server boot but is idempotent — only fires when the buildings table is
 * empty. Reads from JSON files but never modifies or removes them; once
 * everything is verified working from the DB the user can delete the
 * legacy files manually.
 *
 * Two buildings are always seeded: Vibelab (gets the existing data) and
 * PC (empty, awaits manual GitHub config). The user requested that
 * arbitrary additional buildings can be created later via the UI; this
 * just bootstraps the two known ones.
 */
export async function migrateLegacyJsonIntoDb(): Promise<{ imported: boolean }> {
	const db = getDb();

	const existing = await db.select({ id: buildings.id }).from(buildings).limit(1);
	if (existing.length > 0) {
		return { imported: false };
	}

	const settingsDir = path.join(os.homedir(), '.pixel-agents');
	const paths = {
		agents: path.join(settingsDir, 'agents.json'),
		seats: path.join(settingsDir, 'seats.json'),
		settings: path.join(settingsDir, 'settings.json'),
		knownProjects: path.join(settingsDir, 'known-projects.json'),
		workerAssignments: path.join(settingsDir, 'worker-assignments.json'),
	};

	const settings = readJsonOrNull<Record<string, unknown>>(paths.settings) ?? {};
	const clickupConfig = (settings.clickup as Record<string, unknown> | undefined) ?? {};

	console.log('[DB Migration] Seeding buildings and importing legacy JSON state...');

	const insertedBuildings = await db.insert(buildings).values([
		{
			slug: 'vibelab',
			name: 'Vibelab',
			connectorType: 'clickup',
			connectorConfig: clickupConfig,
			sortOrder: 0,
		},
		{
			slug: 'pc',
			name: 'PC',
			connectorType: 'github',
			connectorConfig: {},
			sortOrder: 1,
		},
	]).returning({ id: buildings.id, slug: buildings.slug });

	const vibelabId = insertedBuildings.find(b => b.slug === 'vibelab')!.id;
	const pcId = insertedBuildings.find(b => b.slug === 'pc')!.id;
	void pcId;

	// ── Persistent agents → vibelab ─────────────────────────
	const agentRows = readJsonOrNull<Array<Record<string, unknown>>>(paths.agents) ?? [];
	if (agentRows.length > 0) {
		const values = agentRows.map(a => ({
			id: String(a.id),
			buildingId: vibelabId,
			name: String(a.name ?? ''),
			roleShort: String(a.roleShort ?? ''),
			roleFull: String(a.roleFull ?? ''),
			workspacePath: String(a.workspacePath ?? ''),
			teamId: a.teamId as string | undefined ?? null,
			reportsToId: a.reportsToId as string | undefined ?? null,
			palette: a.palette as number | undefined ?? null,
			hueShift: a.hueShift as number | undefined ?? null,
			seatId: a.seatId as string | undefined ?? null,
			currentSessionId: a.currentSessionId as string | undefined ?? null,
			lastSessionEnd: a.lastSessionEnd as string | undefined ?? null,
			sessionCount: a.sessionCount as number | undefined ?? null,
			currentTicketId: a.currentTicketId as string | undefined ?? null,
			currentTicketName: a.currentTicketName as string | undefined ?? null,
			currentTicketUrl: a.currentTicketUrl as string | undefined ?? null,
			lastTicketId: a.lastTicketId as string | undefined ?? null,
			retired: a.retired as boolean | undefined ?? null,
		}));
		await db.insert(persistentAgents).values(values);
		console.log(`[DB Migration] Imported ${values.length} persistent agents → vibelab`);
	}

	// ── Seats → vibelab ──────────────────────────────────────
	const seatsObj = readJsonOrNull<Record<string, Record<string, unknown>>>(paths.seats) ?? {};
	const seatEntries = Object.entries(seatsObj);
	if (seatEntries.length > 0) {
		const seatValues = seatEntries.map(([sessionId, data]) => ({
			buildingId: vibelabId,
			sessionId,
			data,
		}));
		// chunk to keep parameter count sane
		for (let i = 0; i < seatValues.length; i += 200) {
			await db.insert(seats).values(seatValues.slice(i, i + 200));
		}
		console.log(`[DB Migration] Imported ${seatValues.length} seats → vibelab`);
	}

	// ── Known projects → global pool + linked to vibelab ─────
	const knownArr = readJsonOrNull<Array<Record<string, unknown>>>(paths.knownProjects) ?? [];
	if (knownArr.length > 0) {
		const seen = new Set<string>();
		const projectValues: Array<{ name: string; workspacePath: string; description: string | null }> = [];
		for (const kp of knownArr) {
			const workspacePath = String(kp.workspacePath ?? '');
			if (!workspacePath || seen.has(workspacePath)) continue;
			seen.add(workspacePath);
			projectValues.push({
				name: String(kp.name ?? path.basename(workspacePath)),
				workspacePath,
				description: (kp.description as string | undefined) ?? null,
			});
		}
		if (projectValues.length > 0) {
			const inserted = await db.insert(projects).values(projectValues).returning({ id: projects.id });
			const links = inserted.map(row => ({ buildingId: vibelabId, projectId: row.id }));
			await db.insert(buildingProjects).values(links);
			console.log(`[DB Migration] Imported ${projectValues.length} projects → vibelab membership`);
		}
	}

	// ── Worker assignments → vibelab ────────────────────────
	const waArr = readJsonOrNull<Array<Record<string, unknown>>>(paths.workerAssignments) ?? [];
	if (waArr.length > 0) {
		const waValues = waArr.map(w => ({
			buildingId: vibelabId,
			ticketId: String(w.ticketId ?? ''),
			ticketName: String(w.ticketName ?? ''),
			worker: String(w.worker ?? ''),
			workerHost: String(w.workerHost ?? ''),
			startedAt: String(w.startedAt ?? new Date().toISOString()),
			status: String(w.status ?? 'completed'),
		}));
		for (let i = 0; i < waValues.length; i += 200) {
			await db.insert(workerAssignments).values(waValues.slice(i, i + 200));
		}
		console.log(`[DB Migration] Imported ${waValues.length} worker assignments → vibelab`);
	}

	// ── App settings (sound enabled, jan design config) ─────
	const globalSettingEntries: Array<{ key: string; value: unknown }> = [];
	if (settings.soundEnabled !== undefined) {
		globalSettingEntries.push({ key: 'soundEnabled', value: settings.soundEnabled });
	}
	if (settings.janDesignConfig !== undefined) {
		globalSettingEntries.push({ key: 'janDesignConfig', value: settings.janDesignConfig });
	}
	if (globalSettingEntries.length > 0) {
		await db.insert(appSettings).values(globalSettingEntries);
		console.log(`[DB Migration] Imported ${globalSettingEntries.length} app settings`);
	}

	console.log('[DB Migration] Complete. Legacy JSON files left in place; delete manually once verified.');
	return { imported: true };
}

function readJsonOrNull<T>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
	} catch (err) {
		console.warn(`[DB Migration] Failed to read ${filePath}:`, err);
		return null;
	}
}

// Helper to suppress sql import being unused if Drizzle inlines it
void sql;
