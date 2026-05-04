import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { PROJECT_DIR_SCAN_INTERVAL_MS, JSONL_SCAN_INTERVAL_MS, STALE_CHECK_INTERVAL_MS } from './constants.js';

export interface ScannerCallbacks {
	onNewSession(projectDir: string, jsonlFile: string, projectName: string): void;
	onSessionStale(jsonlFile: string): void;
}

interface WatchedProject {
	dir: string;
	name: string;
	/** Every JSONL file we've ever seen in this project dir. Used to detect
	 *  newly-appearing files (which we treat as just-started sessions). */
	knownFiles: Set<string>;
	/** Files we've reported as live via `onNewSession` and have NOT yet
	 *  reported as stale. Without this, `checkStale` fired `onSessionStale`
	 *  every 2s for every historical JSONL in the directory — broadcasting
	 *  `offlineAgents` ~125×/s on a fleet with hundreds of past sessions. */
	liveFiles: Set<string>;
	timer: ReturnType<typeof setInterval>;
}

/** Get the set of session IDs that have a live claude process */
export function getLiveSessionIds(): Set<string> {
	const ids = new Set<string>();
	try {
		const output = execSync(
			'ps aux | grep "claude" | grep "session-id" | grep -v grep',
			{ encoding: 'utf-8', timeout: 3000 },
		).trim();
		if (!output) return ids;
		for (const line of output.split('\n')) {
			const match = line.match(/--session-id\s+([0-9a-f-]{36})/);
			if (match) {
				ids.add(match[1]);
			}
		}
	} catch {
		// No claude processes running
	}
	return ids;
}

/**
 * Try to reconstruct the actual workspace path from a project hash directory name.
 * Hash format: workspace path with `/`, `\`, `:` replaced by `-`.
 * Uses filesystem probing to resolve ambiguous hyphens.
 */
export function decodeProjectHash(hash: string): string | null {
	// On macOS/Linux, paths start with '/', encoded as leading '-'
	if (!hash.startsWith('-')) return null;

	const segments = hash.slice(1).split('-');

	function resolve(idx: number, current: string): string | null {
		if (idx >= segments.length) {
			try {
				if (fs.statSync(current).isDirectory()) return current;
			} catch { /* ignore */ }
			return null;
		}
		// Empty segment from '--': component starts with '.' or '-' (both encode as '-')
		// e.g. '/.claude' → '--claude', '/-Users-...' → '--Users-...'
		const prefixes = segments[idx] === '' ? ['.', '-'] : [''];
		for (const prefix of prefixes) {
			const startIdx = prefix ? idx + 1 : idx;
			if (startIdx >= segments.length) continue;
			// Try consuming 1 to remaining segments (shortest first — most common case)
			for (let len = 1; len <= segments.length - startIdx; len++) {
				const part = prefix + segments.slice(startIdx, startIdx + len).join('-');
				const next = current + '/' + part;
				try {
					if (fs.statSync(next).isDirectory()) {
						if (startIdx + len === segments.length) return next;
						const result = resolve(startIdx + len, next);
						if (result) return result;
					}
				} catch { /* path doesn't exist */ }
			}
		}
		return null;
	}

	const decoded = resolve(0, '');
	if (!decoded) return null;

	// If decoded path is inside ~/.claude/projects/, it's a meta-project —
	// recursively decode the inner hash to find the real workspace
	const projectsPrefix = path.join(os.homedir(), '.claude', 'projects') + '/';
	if (decoded.startsWith(projectsPrefix)) {
		const innerHash = path.basename(decoded);
		const inner = decodeProjectHash(innerHash);
		if (inner) return inner;
	}

	return decoded;
}

export class ProjectScanner {
	private projectsRoot: string;
	private projects = new Map<string, WatchedProject>();
	private dirScanTimer: ReturnType<typeof setInterval> | null = null;
	private staleTimer: ReturnType<typeof setInterval> | null = null;
	private callbacks: ScannerCallbacks;
	/** Set of session IDs with live claude processes — refreshed periodically */
	private liveSessionIds = new Set<string>();

	constructor(callbacks: ScannerCallbacks) {
		this.projectsRoot = path.join(os.homedir(), '.claude', 'projects');
		this.callbacks = callbacks;
	}

	start(): void {
		// Get live sessions before initial scan
		this.liveSessionIds = getLiveSessionIds();
		console.log(`[Scanner] Found ${this.liveSessionIds.size} live Claude session(s)`);

		// Initial scan
		this.scanProjectDirs();

		// Poll for new project directories
		this.dirScanTimer = setInterval(() => this.scanProjectDirs(), PROJECT_DIR_SCAN_INTERVAL_MS);

		// Periodically refresh live sessions and check for stale agents
		this.staleTimer = setInterval(() => {
			this.liveSessionIds = getLiveSessionIds();
			this.checkStale();
		}, STALE_CHECK_INTERVAL_MS);
	}

	stop(): void {
		if (this.dirScanTimer) {
			clearInterval(this.dirScanTimer);
			this.dirScanTimer = null;
		}
		if (this.staleTimer) {
			clearInterval(this.staleTimer);
			this.staleTimer = null;
		}
		for (const proj of this.projects.values()) {
			clearInterval(proj.timer);
		}
		this.projects.clear();
	}

	private scanProjectDirs(): void {
		try {
			if (!fs.existsSync(this.projectsRoot)) return;
			const entries = fs.readdirSync(this.projectsRoot, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const dirPath = path.join(this.projectsRoot, entry.name);
				if (!this.projects.has(dirPath)) {
					this.watchProject(dirPath, entry.name);
				}
			}
		} catch {
			// ~/.claude/projects may not exist yet
		}
	}

	private watchProject(dirPath: string, dirName: string): void {
		const projectName = this.deriveProjectName(dirName);
		const knownFiles = new Set<string>();
		const liveFiles = new Set<string>();

		// Seed with existing files — only report ones with a live claude process
		try {
			const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
			for (const f of files) {
				const fullPath = path.join(dirPath, f);
				knownFiles.add(fullPath);
				const sessionId = path.basename(f, '.jsonl');
				if (this.liveSessionIds.has(sessionId)) {
					liveFiles.add(fullPath);
					this.callbacks.onNewSession(dirPath, fullPath, projectName);
				}
			}
		} catch {
			// Dir may have been removed
		}

		// Poll for new JSONL files
		const timer = setInterval(() => {
			this.scanJsonlFiles(dirPath);
		}, JSONL_SCAN_INTERVAL_MS);

		this.projects.set(dirPath, { dir: dirPath, name: projectName, knownFiles, liveFiles, timer });
	}

	private scanJsonlFiles(dirPath: string): void {
		const proj = this.projects.get(dirPath);
		if (!proj) return;
		try {
			const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
			for (const f of files) {
				const fullPath = path.join(dirPath, f);
				if (proj.knownFiles.has(fullPath)) continue;
				proj.knownFiles.add(fullPath);
				const sessionId = path.basename(f, '.jsonl');
				// Only promote to `liveFiles` (and fire `onNewSession`) when ps aux
				// has already seen the process. If Claude is still starting up, we
				// defer to `checkStale` which will promote on the next tick once
				// `ps aux` catches up. Otherwise the next stale-check would mistake
				// the still-starting session for a dead one and clear the persistent
				// agent's `currentSessionId` — which is exactly what made Darryl
				// dispatch every subsequent ticket back to the same worker.
				if (this.liveSessionIds.has(sessionId)) {
					proj.liveFiles.add(fullPath);
					this.callbacks.onNewSession(dirPath, fullPath, proj.name);
				}
			}
		} catch {
			// Ignore read errors
		}
	}

	private checkStale(): void {
		for (const proj of this.projects.values()) {
			// Promote: any known file whose process is now visible in ps aux but
			// hasn't been reported live yet (e.g. Claude finished starting between
			// the file appearing on disk and the next ps-aux refresh).
			for (const filePath of proj.knownFiles) {
				if (proj.liveFiles.has(filePath)) continue;
				const sessionId = path.basename(filePath, '.jsonl');
				if (this.liveSessionIds.has(sessionId)) {
					proj.liveFiles.add(filePath);
					this.callbacks.onNewSession(proj.dir, filePath, proj.name);
				}
			}
			// Demote: files we've previously reported live whose process has
			// since disappeared. Fire `onSessionStale` exactly once per file.
			for (const filePath of [...proj.liveFiles]) {
				const sessionId = path.basename(filePath, '.jsonl');
				if (!this.liveSessionIds.has(sessionId)) {
					proj.liveFiles.delete(filePath);
					this.callbacks.onSessionStale(filePath);
				}
			}
		}
	}

	/** Convert sanitized dir name back to a readable project name */
	private deriveProjectName(dirName: string): string {
		// Try to decode the full workspace path and use the last component
		const decoded = decodeProjectHash(dirName);
		if (decoded) return path.basename(decoded);
		// Fallback: last non-empty segment
		const parts = dirName.split('-').filter(p => p.length > 0);
		if (parts.length === 0) return dirName;
		return parts[parts.length - 1];
	}
}
