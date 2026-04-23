import * as https from 'https';

export interface ClickUpTask {
	id: string;
	name: string;
	status: { status: string; color: string };
	assignees: Array<{ username: string }>;
	url: string;
	priority: { id: string } | null;
	parent: string | null;
}

export interface ClickUpStatusGroup {
	name: string;
	color: string;
	tasks: ClickUpTask[];
}

export interface ClickUpConfig {
	apiToken: string;
	listId: string;
}

const FETCH_TIMEOUT_MS = 15000;

function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers }, (res) => {
			let data = '';
			res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
			res.on('error', (err) => reject(new Error(`ClickUp response error: ${err.message}`)));
			res.on('end', () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try { resolve(JSON.parse(data)); }
					catch (e) { reject(new Error(`Invalid JSON from ClickUp: ${(e as Error).message}`)); }
				} else {
					reject(new Error(`ClickUp API ${res.statusCode}: ${data.slice(0, 200)}`));
				}
			});
		});
		req.setTimeout(FETCH_TIMEOUT_MS, () => {
			req.destroy(new Error(`ClickUp request timed out after ${FETCH_TIMEOUT_MS}ms`));
		});
		req.on('error', reject);
	});
}

// ClickUp's v2 /list/{id}/task endpoint paginates at 100 tasks/page.
// `last_page` on the response tells us when to stop.
const CLICKUP_PAGE_SIZE = 100;
const CLICKUP_MAX_PAGES = 50; // hard safety cap = 5000 tasks

type ClickUpTaskApi = {
	id: string;
	name: string;
	status: { status: string; color: string };
	assignees: Array<{ username: string }>;
	url: string;
	priority: { id: string } | null;
	parent: string | null;
};

export async function fetchListTasks(config: ClickUpConfig): Promise<ClickUpStatusGroup[]> {
	const allTasks: ClickUpTaskApi[] = [];
	for (let page = 0; page < CLICKUP_MAX_PAGES; page++) {
		const url = `https://api.clickup.com/api/v2/list/${config.listId}/task?include_closed=false&subtasks=true&page=${page}`;
		const data = await fetchJson(url, { Authorization: config.apiToken }) as {
			tasks: ClickUpTaskApi[];
			last_page?: boolean;
		};
		const tasks = data.tasks ?? [];
		allTasks.push(...tasks);
		if (data.last_page === true) break;
		if (tasks.length < CLICKUP_PAGE_SIZE) break;
	}

	// Group tasks by status
	const statusMap = new Map<string, ClickUpStatusGroup>();
	for (const task of allTasks) {
		const key = task.status.status;
		if (!statusMap.has(key)) {
			statusMap.set(key, { name: key, color: task.status.color, tasks: [] });
		}
		statusMap.get(key)!.tasks.push({
			id: task.id,
			name: task.name,
			status: task.status,
			assignees: task.assignees || [],
			url: task.url,
			priority: task.priority,
			parent: task.parent || null,
		});
	}

	return [...statusMap.values()];
}

export async function addTaskComment(config: ClickUpConfig, taskId: string, commentText: string): Promise<void> {
	const url = `https://api.clickup.com/api/v2/task/${taskId}/comment`;
	const body = JSON.stringify({ comment_text: commentText });

	return new Promise((resolve, reject) => {
		const urlObj = new URL(url);
		const req = https.request({
			hostname: urlObj.hostname,
			path: urlObj.pathname,
			method: 'POST',
			headers: {
				'Authorization': config.apiToken,
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body),
			},
		}, (res) => {
			let data = '';
			res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
			res.on('end', () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					resolve();
				} else {
					reject(new Error(`ClickUp comment API ${res.statusCode}: ${data.slice(0, 200)}`));
				}
			});
		});
		req.setTimeout(FETCH_TIMEOUT_MS, () => {
			req.destroy(new Error(`ClickUp comment request timed out`));
		});
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}
