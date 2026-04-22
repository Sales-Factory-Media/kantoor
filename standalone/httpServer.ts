import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { loadKnownProjects } from '../src/projectStore.js';
import type { RosterEntry } from './agentStore.js';
import { launchAgentOnTicket, handleLaunchDesigner, handleLaunchVisualDesigner, handleJanReviewDesigner } from './clickupHandlers.js';
import { closeItermSession } from './itermFocus.js';
import { WEBVIEW_DIR } from './serverContext.js';
import type { ServerContext } from './serverContext.js';

// ── MIME types ───────────────────────────────────────────────
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
	'.webp': 'image/webp',
};

// ── API handlers ─────────────────────────────────────────────

function handleApiRoster(res: http.ServerResponse, ctx: ServerContext): void {
	const knownProjects = loadKnownProjects();
	const roster: RosterEntry[] = ctx.persistentAgents.map(p => {
		const projName = path.basename(p.workspacePath);
		const proj = knownProjects.find(k => k.name === projName);
		return {
			id: p.id,
			name: p.name,
			roleShort: p.roleShort,
			roleFull: p.roleFull,
			workspacePath: p.workspacePath,
			projectName: proj?.name ?? projName,
			projectDescription: proj?.description,
			isOnline: !!p.currentSessionId,
		};
	});
	res.writeHead(200);
	res.end(JSON.stringify({ roster }));
}

function handleApiAgentExit(json: Record<string, unknown>, res: http.ServerResponse): void {
	const sessionId = json.sessionId as string | undefined;

	if (!sessionId) {
		res.writeHead(400);
		res.end(JSON.stringify({ error: 'Missing required field: sessionId' }));
		return;
	}

	const closed = closeItermSession(sessionId);
	console.log(`[API] agent-exit sessionId=${sessionId} closed=${closed}`);
	res.writeHead(200);
	res.end(JSON.stringify({
		success: true,
		message: closed ? 'Session closed' : 'Session not found (may have already exited)',
	}));
}

function handleApiLaunchAgent(json: Record<string, unknown>, res: http.ServerResponse, ctx: ServerContext): void {
	const agentId = json.agentId as string | undefined;
	const ticketId = json.ticketId as string | undefined;
	const ticketName = json.ticketName as string | undefined;
	const ticketUrl = json.ticketUrl as string | undefined;

	if (!agentId || !ticketId || !ticketName || !ticketUrl) {
		res.writeHead(400);
		res.end(JSON.stringify({ error: 'Missing required fields: agentId, ticketId, ticketName, ticketUrl' }));
		return;
	}

	const useTeam = json.useTeam as boolean | undefined;
	const additionalPrompt = json.additionalPrompt as string | undefined;
	const aiReviewMode = json.aiReviewMode as boolean | undefined;

	const result = launchAgentOnTicket(agentId, ticketId, ticketName, ticketUrl, ctx, { useTeam, additionalPrompt, aiReviewMode });
	if (result.success) {
		res.writeHead(200);
		res.end(JSON.stringify({ success: true }));
	} else {
		res.writeHead(400);
		res.end(JSON.stringify({ success: false, error: result.error }));
		ctx.broadcastSink.postMessage({ type: 'clickupError', error: result.error || 'Unknown error' });
	}
}

// ── HTTP server factory ──────────────────────────────────────

export function createHttpServer(ctx: ServerContext): http.Server {
	return http.createServer((req, res) => {
		let urlPath = req.url || '/';

		// Strip query strings
		const qIdx = urlPath.indexOf('?');
		if (qIdx >= 0) urlPath = urlPath.slice(0, qIdx);

		// API routes
		if (urlPath.startsWith('/api/')) {
			res.setHeader('Content-Type', 'application/json');

			if (req.method === 'GET' && urlPath === '/api/roster') {
				handleApiRoster(res, ctx);
				return;
			}

			if (req.method === 'POST' && urlPath === '/api/launch-designer') {
				const MAX_BODY_BYTES = 64 * 1024;
				let body = '';
				let exceeded = false;
				req.on('data', (chunk: Buffer) => {
					if (exceeded) return;
					body += chunk.toString();
					if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
						exceeded = true;
						res.writeHead(413);
						res.end(JSON.stringify({ error: 'Request body too large' }));
						req.destroy();
					}
				});
				req.on('end', async () => {
					if (exceeded) return;
					try {
						const json = JSON.parse(body) as Record<string, unknown>;
						const result = await handleLaunchDesigner(json, ctx);
						res.writeHead(result.success ? 200 : 400);
						res.end(JSON.stringify(result));
					} catch {
						res.writeHead(400);
						res.end(JSON.stringify({ error: 'Invalid JSON' }));
					}
				});
				return;
			}

			if (req.method === 'POST' && urlPath === '/api/launch-visual-designer') {
				const MAX_BODY_BYTES = 64 * 1024;
				let body = '';
				let exceeded = false;
				req.on('data', (chunk: Buffer) => {
					if (exceeded) return;
					body += chunk.toString();
					if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
						exceeded = true;
						res.writeHead(413);
						res.end(JSON.stringify({ error: 'Request body too large' }));
						req.destroy();
					}
				});
				req.on('end', async () => {
					if (exceeded) return;
					try {
						const json = JSON.parse(body) as Record<string, unknown>;
						const result = await handleLaunchVisualDesigner(json, ctx);
						res.writeHead(result.success ? 200 : 400);
						res.end(JSON.stringify(result));
					} catch {
						res.writeHead(400);
						res.end(JSON.stringify({ error: 'Invalid JSON' }));
					}
				});
				return;
			}

			if (req.method === 'POST' && urlPath === '/api/review-designer') {
				const MAX_BODY_BYTES = 64 * 1024;
				let body = '';
				let exceeded = false;
				req.on('data', (chunk: Buffer) => {
					if (exceeded) return;
					body += chunk.toString();
					if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
						exceeded = true;
						res.writeHead(413);
						res.end(JSON.stringify({ error: 'Request body too large' }));
						req.destroy();
					}
				});
				req.on('end', () => {
					if (exceeded) return;
					try {
						const json = JSON.parse(body) as Record<string, unknown>;
						handleJanReviewDesigner({
							ticketId: json.ticketId as string,
							ticketName: (json.ticketName as string) || '',
							ticketUrl: (json.ticketUrl as string) || '',
							designerName: (json.designerName as string) || 'unknown',
							workspacePath: (json.workspacePath as string) || '',
						}, ctx);
						res.writeHead(200);
						res.end(JSON.stringify({ success: true }));
					} catch {
						res.writeHead(400);
						res.end(JSON.stringify({ error: 'Invalid JSON' }));
					}
				});
				return;
			}

			if (req.method === 'POST' && urlPath === '/api/agent-exit') {
				const MAX_BODY_BYTES = 64 * 1024; // 64 KB
				let body = '';
				let exceeded = false;
				req.on('data', (chunk: Buffer) => {
					if (exceeded) return;
					body += chunk.toString();
					if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
						exceeded = true;
						res.writeHead(413);
						res.end(JSON.stringify({ error: 'Request body too large' }));
						req.destroy();
					}
				});
				req.on('end', () => {
					if (exceeded) return;
					try {
						const json = JSON.parse(body) as Record<string, unknown>;
						handleApiAgentExit(json, res);
					} catch {
						res.writeHead(400);
						res.end(JSON.stringify({ error: 'Invalid JSON' }));
					}
				});
				return;
			}

			if (req.method === 'POST' && urlPath === '/api/launch-agent') {
				const MAX_BODY_BYTES = 64 * 1024; // 64 KB
				let body = '';
				let exceeded = false;
				req.on('data', (chunk: Buffer) => {
					if (exceeded) return;
					body += chunk.toString();
					if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
						exceeded = true;
						res.writeHead(413);
						res.end(JSON.stringify({ error: 'Request body too large' }));
						req.destroy();
					}
				});
				req.on('end', () => {
					if (exceeded) return;
					try {
						const json = JSON.parse(body) as Record<string, unknown>;
						handleApiLaunchAgent(json, res, ctx);
					} catch {
						res.writeHead(400);
						res.end(JSON.stringify({ error: 'Invalid JSON' }));
					}
				});
				return;
			}

			res.writeHead(404);
			res.end(JSON.stringify({ error: 'Not found' }));
			return;
		}

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
