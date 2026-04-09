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
	knownFiles: Set<string>;
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

		// Seed with existing files — only report ones with a live claude process
		try {
			const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
			for (const f of files) {
				const fullPath = path.join(dirPath, f);
				knownFiles.add(fullPath);
				const sessionId = path.basename(f, '.jsonl');
				if (this.liveSessionIds.has(sessionId)) {
					this.callbacks.onNewSession(dirPath, fullPath, projectName);
				}
			}
		} catch {
			// Dir may have been removed
		}

		// Poll for new JSONL files
		const timer = setInterval(() => {
			this.scanJsonlFiles(dirPath, knownFiles, projectName);
		}, JSONL_SCAN_INTERVAL_MS);

		this.projects.set(dirPath, { dir: dirPath, name: projectName, knownFiles, timer });
	}

	private scanJsonlFiles(dirPath: string, knownFiles: Set<string>, projectName: string): void {
		try {
			const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
			for (const f of files) {
				const fullPath = path.join(dirPath, f);
				if (!knownFiles.has(fullPath)) {
					knownFiles.add(fullPath);
					// New file appeared — report it (likely a just-started session)
					this.callbacks.onNewSession(dirPath, fullPath, projectName);
				}
			}
		} catch {
			// Ignore read errors
		}
	}

	private checkStale(): void {
		for (const proj of this.projects.values()) {
			for (const filePath of proj.knownFiles) {
				const sessionId = path.basename(filePath, '.jsonl');
				if (!this.liveSessionIds.has(sessionId)) {
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
