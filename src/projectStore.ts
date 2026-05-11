import { eq, and, inArray } from 'drizzle-orm';
import { getDb } from './db/client.js';
import { projects, buildingProjects } from './db/schema.js';
import { getActiveBuildingId, tryGetActiveBuildingId } from './db/activeBuilding.js';

export interface KnownProject {
	name: string;
	workspacePath: string;
	description?: string;
}

export interface ProjectMembership extends KnownProject {
	id: number;
	belongsToActive: boolean;
}

// Cache populated by initProjectStore() at boot — these are the projects that
// belong to the ACTIVE building. Sync reads return from this. Writes update
// cache + flush join changes to DB.
let cache: KnownProject[] = [];

export async function initProjectStore(): Promise<void> {
	const db = getDb();
	const buildingId = getActiveBuildingId();
	const rows = await db
		.select({
			name: projects.name,
			workspacePath: projects.workspacePath,
			description: projects.description,
		})
		.from(buildingProjects)
		.innerJoin(projects, eq(projects.id, buildingProjects.projectId))
		.where(eq(buildingProjects.buildingId, buildingId));
	cache = rows.map(r => ({
		name: r.name,
		workspacePath: r.workspacePath,
		description: r.description ?? undefined,
	}));
}

export function loadKnownProjects(): KnownProject[] {
	return cache;
}

/**
 * Upsert a project into the global pool AND link it to the active building.
 * Idempotent — if the project already exists and is already linked, no-op.
 */
export function addKnownProject(name: string, workspacePath: string): void {
	if (cache.some(p => p.workspacePath === workspacePath)) return;
	cache.push({ name, workspacePath });

	const buildingId = tryGetActiveBuildingId();
	if (!buildingId) return;
	const db = getDb();
	(async () => {
		try {
			await db.transaction(async (tx) => {
				// Upsert into global pool
				const existing = await tx.select({ id: projects.id }).from(projects).where(eq(projects.workspacePath, workspacePath)).limit(1);
				let projectId: number;
				if (existing.length > 0) {
					projectId = existing[0].id;
				} else {
					const inserted = await tx.insert(projects).values({ name, workspacePath }).returning({ id: projects.id });
					projectId = inserted[0].id;
				}
				// Link to active building (no-op if already linked)
				await tx.insert(buildingProjects)
					.values({ buildingId, projectId })
					.onConflictDoNothing();
			});
		} catch (err) {
			console.error('[projectStore] Failed to add known project:', err);
		}
	})();
}

/**
 * Remove a project from the ACTIVE building's set. The project itself stays
 * in the global pool — other buildings keep it.
 */
export function removeKnownProject(workspacePath: string): void {
	const filtered = cache.filter(p => p.workspacePath !== workspacePath);
	if (filtered.length === cache.length) return;
	cache = filtered;

	const buildingId = tryGetActiveBuildingId();
	if (!buildingId) return;
	const db = getDb();
	(async () => {
		try {
			const proj = await db.select({ id: projects.id }).from(projects).where(eq(projects.workspacePath, workspacePath)).limit(1);
			if (proj.length === 0) return;
			await db.delete(buildingProjects).where(and(
				eq(buildingProjects.buildingId, buildingId),
				eq(buildingProjects.projectId, proj[0].id),
			));
		} catch (err) {
			console.error('[projectStore] Failed to unlink known project:', err);
		}
	})();
}

export function removeKnownProjectByName(name: string): void {
	const target = cache.find(p => p.name === name);
	if (!target) return;
	removeKnownProject(target.workspacePath);
}

export function updateKnownProject(workspacePath: string, updates: Partial<Omit<KnownProject, 'workspacePath'>>): void {
	const idx = cache.findIndex(p => p.workspacePath === workspacePath);
	if (idx === -1) return;
	cache[idx] = { ...cache[idx], ...updates };

	const db = getDb();
	(async () => {
		try {
			const set: Record<string, unknown> = {};
			if (updates.name !== undefined) set.name = updates.name;
			if (updates.description !== undefined) set.description = updates.description ?? null;
			if (Object.keys(set).length === 0) return;
			await db.update(projects).set(set).where(eq(projects.workspacePath, workspacePath));
		} catch (err) {
			console.error('[projectStore] Failed to update known project:', err);
		}
	})();
}

/** Get known projects filtered to those whose workspace path is in the current VS Code window */
export function getKnownProjectsForWorkspace(workspaceFolderPaths: string[]): KnownProject[] {
	const pathSet = new Set(workspaceFolderPaths);
	return cache.filter(p => pathSet.has(p.workspacePath));
}

/**
 * Returns the global project pool with a flag per row indicating whether
 * the project belongs to the currently-active building. Used by the
 * settings/membership UI.
 */
export async function listAllProjectsWithMembership(): Promise<ProjectMembership[]> {
	const db = getDb();
	const buildingId = getActiveBuildingId();
	const allProjects = await db.select().from(projects).orderBy(projects.name);
	const memberships = await db.select({ projectId: buildingProjects.projectId })
		.from(buildingProjects)
		.where(eq(buildingProjects.buildingId, buildingId));
	const inActive = new Set(memberships.map(m => m.projectId));
	return allProjects.map(p => ({
		id: p.id,
		name: p.name,
		workspacePath: p.workspacePath,
		description: p.description ?? undefined,
		belongsToActive: inActive.has(p.id),
	}));
}

/**
 * Toggle a project's membership in the active building. Returns the new
 * membership state (true = now linked, false = now unlinked).
 */
export async function setProjectMembership(workspacePath: string, included: boolean): Promise<boolean> {
	const buildingId = getActiveBuildingId();
	const db = getDb();
	const proj = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.workspacePath, workspacePath)).limit(1);
	if (proj.length === 0) return false;

	if (included) {
		await db.insert(buildingProjects)
			.values({ buildingId, projectId: proj[0].id })
			.onConflictDoNothing();
		// Update cache if this project isn't already in it
		if (!cache.some(p => p.workspacePath === workspacePath)) {
			cache.push({ name: proj[0].name, workspacePath });
		}
		return true;
	} else {
		await db.delete(buildingProjects).where(and(
			eq(buildingProjects.buildingId, buildingId),
			eq(buildingProjects.projectId, proj[0].id),
		));
		cache = cache.filter(p => p.workspacePath !== workspacePath);
		return false;
	}
}

void inArray; // re-export safety for downstream code
