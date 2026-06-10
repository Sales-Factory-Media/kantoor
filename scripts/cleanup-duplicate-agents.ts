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

import { sql, inArray, eq } from 'drizzle-orm';
import { createServer } from 'net';
import { getDb, closeDb } from '../src/db/client.js';
import { persistentAgents, sessionHistory } from '../src/db/schema.js';
import { SERVER_PORT } from '../standalone/constants.js';

/**
 * Hard-stop the cleanup if the standalone server is still listening on its
 * port. Otherwise the server's in-memory agentCache would re-flush the deleted
 * rows back to the DB on the next `savePersistentAgents` call (which fires on
 * almost any agent state change), silently undoing the cleanup.
 */
async function assertServerNotRunning(): Promise<void> {
	const inUse = await new Promise<boolean>((resolve) => {
		const probe = createServer();
		probe.once('error', (err: NodeJS.ErrnoException) => {
			resolve(err.code === 'EADDRINUSE');
		});
		probe.once('listening', () => {
			probe.close(() => resolve(false));
		});
		probe.listen(SERVER_PORT, '127.0.0.1');
	});
	if (inUse) {
		console.error(`[cleanup] Standalone server appears to be running (port ${SERVER_PORT} is in use).`);
		console.error('[cleanup] Stop the server first (the in-memory agent cache would re-flush the deleted rows back to DB otherwise).');
		await closeDb();
		process.exit(2);
	}
}

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
	// Keep-priority within each duplicate group, in order:
	//   1. avatar_config IS NOT NULL — the row the user actually personalised
	//      (picked a DiceBear face for) is the "real" identity; duplicates
	//      minted by the buggy onNewSession path never get an avatar set.
	//   2. role_short non-empty — identified employee beats throwaway provisional.
	//   3. Most recent last_session_end — recently-active row beats ancient ghost.
	//   4. NULL last_session_end last — a row currently mid-session sorts after a
	//      recently-ended one because the live session can be migrated to the
	//      kept row (we copy `current_sessions` over before deletion).
	const result = await db.execute(sql`
		SELECT building_id::text                                                                                AS building_id,
		       name,
		       workspace_path,
		       COUNT(*)::int                                                                                    AS total,
		       (array_agg(id ORDER BY (avatar_config IS NOT NULL) DESC, (role_short <> '') DESC, last_session_end DESC NULLS LAST))[1] AS keep_id,
		       array_agg(id ORDER BY (avatar_config IS NOT NULL) DESC, (role_short <> '') DESC, last_session_end DESC NULLS LAST)       AS all_ids
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
		await assertServerNotRunning();
		const db = getDb();

		// 3a. Migrate `current_sessions` from each delete-row onto its keep-row
		// FIRST, so a live iTerm process whose session lived on a duplicate
		// stays attributed to the surviving employee. Without this, the kept
		// row sees no live session and onNewSession would re-discover the
		// session next boot, which (with session_history remap below) would
		// re-attach correctly anyway — but the in-DB scalar/array state would
		// briefly be inconsistent, which other readers don't expect.
		let migratedSessions = 0;
		for (const g of groups) {
			// Sum of current_sessions[] across all rows in the group (keep + deletes).
			const rows = await db.execute(sql`
				SELECT id, current_sessions
				FROM persistent_agents
				WHERE id = ANY(${[g.keep_id, ...g.delete_ids]}::text[])
			`);
			const all = ((rows as unknown as { rows: Array<{ id: string; current_sessions: unknown }> }).rows
				?? (rows as unknown as Array<{ id: string; current_sessions: unknown }>));
			// `WHERE id = ANY(...)` has no guaranteed order. Put the keep-row
			// first so its first session stays primary in the merged list (and
			// therefore in `current_session_id`, documented as a mirror of
			// `currentSessions[0]`).
			all.sort((a, b) => (a.id === g.keep_id ? -1 : b.id === g.keep_id ? 1 : 0));
			const merged: Array<Record<string, unknown>> = [];
			const seen = new Set<string>();
			for (const r of all) {
				const sessions = (r.current_sessions as Array<Record<string, unknown>> | null) ?? [];
				for (const s of sessions) {
					const sid = s.sessionId as string | undefined;
					if (!sid || seen.has(sid)) continue;
					seen.add(sid);
					merged.push(s);
				}
			}
			if (merged.length > 0) {
				await db.execute(sql`
					UPDATE persistent_agents
					SET current_sessions = ${JSON.stringify(merged)}::jsonb,
					    current_session_id = ${merged[0].sessionId as string}
					WHERE id = ${g.keep_id}
				`);
				migratedSessions += merged.length - ((all.find(r => r.id === g.keep_id)
					?.current_sessions as Array<unknown> | null)?.length ?? 0);
			}
		}
		if (migratedSessions > 0) console.log(`[cleanup] Migrated ${migratedSessions} live session(s) onto the kept agents.`);

		// 3b. Remap session_history so historical session attributions point at
		// the survivor. The FK is ON DELETE CASCADE, so skipping this step
		// would silently drop those rows and any future onNewSession for the
		// same sessionId would fall through to a fresh provisional — defeating
		// the whole point of session_history.
		let remapped = 0;
		for (const g of groups) {
			for (const deleteId of g.delete_ids) {
				const result = await db
					.update(sessionHistory)
					.set({ agentId: g.keep_id })
					.where(eq(sessionHistory.agentId, deleteId));
				remapped += (result as unknown as { rowCount?: number }).rowCount ?? 0;
			}
		}
		if (remapped > 0) console.log(`[cleanup] Remapped ${remapped} session_history row(s) onto the kept agents.`);

		// 3c. Delete the duplicates.
		const allDeleteIds = groups.flatMap(g => g.delete_ids);
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
