/**
 * One-time cleanup script for duplicate persistent agents.
 *
 * Background: `scanner.onNewSession` in standalone/server.ts creates a fresh
 * PersistentAgent on every new JSONL file when no agent has that session as
 * its `currentSessionId`. Over time this produces many rows that are
 * conceptually the same worker (same building, same display name, same
 * workspace) but each with their own id + seat. This script collapses each
 * such group to the most-recent row (by `last_session_end`, NULLs last),
 * deleting the rest.
 *
 * Important rule the user called out: agents with the same display NAME but
 * different workspace paths are DIFFERENT agents (multiple projects each have
 * a "Pam"). Grouping is therefore scoped to (building_id, name, workspace_path).
 *
 * Run with `--dry-run` (default) to preview; pass `--apply` to actually delete.
 *
 *   tsx scripts/cleanup-duplicate-agents.ts             # dry-run
 *   tsx scripts/cleanup-duplicate-agents.ts --apply     # actually delete
 */

import { sql, inArray } from 'drizzle-orm';
import { getDb, closeDb } from '../src/db/client.js';
import { persistentAgents } from '../src/db/schema.js';

interface DuplicateGroup {
	building_id: string;
	name: string;
	workspace_path: string;
	total: number;
	keep_id: string;
	delete_ids: string[];
}

async function findGroups(): Promise<DuplicateGroup[]> {
	const db = getDb();
	const result = await db.execute(sql`
		SELECT building_id::text                                              AS building_id,
		       name,
		       workspace_path,
		       COUNT(*)::int                                                  AS total,
		       (array_agg(id ORDER BY last_session_end DESC NULLS LAST))[1]  AS keep_id,
		       array_agg(id ORDER BY last_session_end DESC NULLS LAST)       AS all_ids
		FROM persistent_agents
		WHERE workspace_path <> ''
		GROUP BY building_id, name, workspace_path
		HAVING COUNT(*) > 1
		ORDER BY total DESC, name ASC
	`);
	const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows
		?? (result as unknown as Array<Record<string, unknown>>);
	return rows.map(r => {
		const allIds = r.all_ids as string[];
		const keepId = r.keep_id as string;
		return {
			building_id: r.building_id as string,
			name: r.name as string,
			workspace_path: r.workspace_path as string,
			total: Number(r.total),
			keep_id: keepId,
			delete_ids: allIds.filter(id => id !== keepId),
		};
	});
}

async function findCrossBuildingIdCollisions(): Promise<Array<{ id: string; buildings: number; names: string[] }>> {
	const db = getDb();
	const result = await db.execute(sql`
		SELECT id,
		       COUNT(DISTINCT building_id)::int AS buildings,
		       array_agg(DISTINCT name)         AS names
		FROM persistent_agents
		GROUP BY id
		HAVING COUNT(DISTINCT building_id) > 1
	`);
	const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows
		?? (result as unknown as Array<Record<string, unknown>>);
	return rows.map(r => ({
		id: r.id as string,
		buildings: Number(r.buildings),
		names: r.names as string[],
	}));
}

async function main(): Promise<void> {
	const apply = process.argv.includes('--apply');

	console.log(`\n[cleanup] Mode: ${apply ? 'APPLY (rows will be deleted)' : 'DRY-RUN (no changes)'}\n`);

	// 1. Find same-(building,name,workspace) duplicates.
	const groups = await findGroups();
	if (groups.length === 0) {
		console.log('[cleanup] No (building, name, workspace) duplicate groups found.');
	} else {
		console.log(`[cleanup] ${groups.length} duplicate group(s) found:\n`);
		let totalToDelete = 0;
		for (const g of groups) {
			console.log(`  ${g.name.padEnd(20)} @ ${g.workspace_path}`);
			console.log(`    building=${g.building_id}  total=${g.total}  keep=${g.keep_id}  delete=${g.delete_ids.length}`);
			totalToDelete += g.delete_ids.length;
		}
		console.log(`\n[cleanup] Total rows to delete: ${totalToDelete}\n`);
	}

	// 2. Surface cross-building id collisions for visibility (these aren't
	//    collapsed by this script — they're real data corruption needing manual
	//    judgement on which building should keep the id).
	const collisions = await findCrossBuildingIdCollisions();
	if (collisions.length > 0) {
		console.log(`[cleanup] ⚠ ${collisions.length} cross-building id collision(s) (NOT touched by this script):`);
		for (const c of collisions) {
			console.log(`  id=${c.id}  buildings=${c.buildings}  names=${c.names.join(', ')}`);
		}
		console.log('  Resolve manually with `DELETE FROM persistent_agents WHERE id = ... AND building_id = ...`\n');
	}

	// 3. Apply if asked.
	if (apply && groups.length > 0) {
		const db = getDb();
		const allDeleteIds = groups.flatMap(g => g.delete_ids);
		// Chunk to stay below Postgres' parameter limit.
		let deleted = 0;
		for (let i = 0; i < allDeleteIds.length; i += 500) {
			const slice = allDeleteIds.slice(i, i + 500);
			const result = await db.delete(persistentAgents).where(inArray(persistentAgents.id, slice));
			const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? slice.length;
			deleted += rowCount;
		}
		console.log(`[cleanup] ✅ Deleted ${deleted} duplicate row(s).`);
	} else if (!apply) {
		console.log('[cleanup] Re-run with `--apply` to actually delete.');
	}

	await closeDb();
}

main().catch(err => {
	console.error('[cleanup] Fatal:', err);
	process.exit(1);
});
