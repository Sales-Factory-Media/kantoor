import * as https from 'https';
import type { ProjectConnector, ConnectorFactory, ConnectorConfig, StatusGroup, Ticket } from './types.js';

interface GitHubConfig {
	token: string;
	owner: string;
	repo: string;
}

interface GitHubIssue {
	number: number;
	title: string;
	state: 'open' | 'closed';
	html_url: string;
	assignees: Array<{ login: string }>;
	labels: Array<{ name: string; color: string }>;
	user: { login: string };
	pull_request?: unknown; // present on PRs — we filter them out
}

const FETCH_TIMEOUT_MS = 15000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Maps a GitHub issue's status. We treat labels with the prefix `status:` as the
 * authoritative status (matches ClickUp's status concept) — e.g. `status:to-do`,
 * `status:ai-review`. Issues without a status label default to `to do` so they
 * still surface in the kantoor.
 */
function statusOfIssue(issue: GitHubIssue): { status: string; color: string } {
	const label = issue.labels.find(l => l.name.toLowerCase().startsWith('status:'));
	if (label) {
		return { status: label.name.slice('status:'.length).trim().toLowerCase(), color: `#${label.color}` };
	}
	return { status: 'to do', color: '#6b7280' };
}

function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, { headers }, (res) => {
			let data = '';
			res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
			res.on('error', err => reject(new Error(`GitHub response error: ${err.message}`)));
			res.on('end', () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					try { resolve(JSON.parse(data)); }
					catch (e) { reject(new Error(`Invalid JSON from GitHub: ${(e as Error).message}`)); }
				} else {
					reject(new Error(`GitHub API ${res.statusCode}: ${data.slice(0, 200)}`));
				}
			});
		});
		req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`GitHub request timed out after ${FETCH_TIMEOUT_MS}ms`)));
		req.on('error', reject);
	});
}

function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
	const payload = JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const req = https.request({
			hostname: u.hostname,
			path: u.pathname + u.search,
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
		}, (res) => {
			let data = '';
			res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
			res.on('end', () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
				else reject(new Error(`GitHub POST ${res.statusCode}: ${data.slice(0, 200)}`));
			});
		});
		req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`GitHub POST timed out`)));
		req.on('error', reject);
		req.write(payload);
		req.end();
	});
}

class GitHubConnector implements ProjectConnector {
	readonly type = 'github';
	private config: GitHubConfig | null;

	constructor(rawConfig: ConnectorConfig) {
		const token = rawConfig.token as string | undefined;
		const owner = rawConfig.owner as string | undefined;
		const repo = rawConfig.repo as string | undefined;
		this.config = (token && owner && repo) ? { token, owner, repo } : null;
	}

	isConfigured(): boolean {
		return this.config !== null;
	}

	async fetchTickets(): Promise<StatusGroup[]> {
		if (!this.config) return [];
		const { token, owner, repo } = this.config;
		const headers = {
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'pixel-agents',
			'X-GitHub-Api-Version': '2022-11-28',
		};

		const all: GitHubIssue[] = [];
		for (let page = 1; page <= MAX_PAGES; page++) {
			const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${PAGE_SIZE}&page=${page}`;
			const batch = await fetchJson(url, headers) as GitHubIssue[];
			if (!Array.isArray(batch) || batch.length === 0) break;
			all.push(...batch);
			if (batch.length < PAGE_SIZE) break;
		}

		// Filter out PRs (GitHub's /issues endpoint includes them) and group by status.
		const issues = all.filter(i => !i.pull_request);
		const groups = new Map<string, StatusGroup>();
		for (const issue of issues) {
			const status = statusOfIssue(issue);
			const ticket: Ticket = {
				id: String(issue.number),
				name: issue.title,
				status,
				url: issue.html_url,
				assignees: issue.assignees.map(a => ({ username: a.login })),
				priority: null,
				parent: null,
			};
			let group = groups.get(status.status);
			if (!group) {
				group = { name: status.status, color: status.color, tasks: [] };
				groups.set(status.status, group);
			}
			group.tasks.push(ticket);
		}
		return [...groups.values()];
	}

	async addComment(ticketId: string, body: string): Promise<void> {
		if (!this.config) throw new Error('GitHub connector is not configured');
		const { token, owner, repo } = this.config;
		const url = `https://api.github.com/repos/${owner}/${repo}/issues/${ticketId}/comments`;
		await postJson(url, {
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'pixel-agents',
			'X-GitHub-Api-Version': '2022-11-28',
		}, { body });
	}
}

export const githubConnectorFactory: ConnectorFactory = {
	type: 'github',
	create(config) {
		return new GitHubConnector(config);
	},
};
