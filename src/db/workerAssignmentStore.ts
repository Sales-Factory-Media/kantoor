import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { workerAssignments } from './schema.js';
import { getActiveBuildingId, tryGetActiveBuildingId } from './activeBuilding.js';

export interface WorkerAssignment {
	ticketId: string;
	ticketName: string;
	worker: string;
	workerHost: string;
	startedAt: string;
	status: 'in_progress' | 'completed' | 'failed';
}

let cache: WorkerAssignment[] = [];

export async function initWorkerAssignmentStore(): Promise<void> {
	const db = getDb();
	const buildingId = getActiveBuildingId();
	const rows = await db.select().from(workerAssignments).where(eq(workerAssignments.buildingId, buildingId));
	cache = rows.map(r => ({
		ticketId: r.ticketId,
		ticketName: r.ticketName,
		worker: r.worker,
		workerHost: r.workerHost,
		startedAt: r.startedAt,
		status: r.status as WorkerAssignment['status'],
	}));
}

export function loadWorkerAssignments(): WorkerAssignment[] {
	return cache;
}

export function saveWorkerAssignments(next: WorkerAssignment[]): void {
	cache = next;
	const buildingId = tryGetActiveBuildingId();
	if (!buildingId) return;
	const db = getDb();
	const rows = next.map(w => ({
		buildingId,
		ticketId: w.ticketId,
		ticketName: w.ticketName,
		worker: w.worker,
		workerHost: w.workerHost,
		startedAt: w.startedAt,
		status: w.status,
	}));
	(async () => {
		try {
			await db.transaction(async (tx) => {
				await tx.delete(workerAssignments).where(eq(workerAssignments.buildingId, buildingId));
				if (rows.length > 0) {
					for (let i = 0; i < rows.length; i += 200) {
						await tx.insert(workerAssignments).values(rows.slice(i, i + 200));
					}
				}
			});
		} catch (err) {
			console.error('[workerAssignmentStore] Failed to persist worker assignments:', err);
		}
	})();
}
