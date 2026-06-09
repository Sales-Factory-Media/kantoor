import * as fs from 'fs';
import * as path from 'path';
import type { MessageSink, ConversationEntry } from '../src/types.js';
import type { StandaloneAgentState } from './types.js';
import { startFileWatching } from '../src/fileWatcher.js';
import { cancelWaitingTimer, cancelPermissionTimer } from '../src/timerManager.js';
import { CONVERSATION_BUFFER_SIZE, SESSION_TASK_TITLE_MAX_LENGTH, SESSION_TASK_TITLE_SCAN_BYTES } from '../src/constants.js';

/**
 * Best-effort read of what a session is working on: its opening user prompt,
 * pulled from the head of the JSONL. Skips slash-command wrappers and local-
 * command caveats so the title reads like the actual task. Returns undefined
 * when nothing suitable is found (e.g. the file has no user text yet).
 */
export function extractSessionTaskTitle(jsonlFile: string): string | undefined {
	let head: string;
	try {
		if (!fs.existsSync(jsonlFile)) return undefined;
		const stat = fs.statSync(jsonlFile);
		const len = Math.min(SESSION_TASK_TITLE_SCAN_BYTES, stat.size);
		if (len <= 0) return undefined;
		const buf = Buffer.alloc(len);
		const fd = fs.openSync(jsonlFile, 'r');
		fs.readSync(fd, buf, 0, len, 0);
		fs.closeSync(fd);
		head = buf.toString('utf-8');
	} catch {
		return undefined;
	}

	for (const line of head.split('\n')) {
		if (!line.trim().startsWith('{')) continue;
		let rec: { type?: string; message?: { content?: unknown } };
		try { rec = JSON.parse(line); } catch { continue; }
		if (rec.type !== 'user') continue;
		const content = rec.message?.content;
		let text: string | undefined;
		if (typeof content === 'string') {
			text = content;
		} else if (Array.isArray(content)) {
			// First text block; tool_result-only turns have no text.
			for (const block of content as Array<{ type?: string; text?: string }>) {
				if (block?.type === 'text' && typeof block.text === 'string') { text = block.text; break; }
			}
		}
		if (!text) continue;
		const cleaned = text.replace(/\s+/g, ' ').trim();
		// Skip slash-command/system wrappers and local-command caveats — keep
		// scanning for the first genuine task prompt.
		if (!cleaned || cleaned.startsWith('<') || cleaned.startsWith('Caveat:')) continue;
		return cleaned.length > SESSION_TASK_TITLE_MAX_LENGTH
			? cleaned.slice(0, SESSION_TASK_TITLE_MAX_LENGTH - 1).trimEnd() + '…'
			: cleaned;
	}
	return undefined;
}

/**
 * A MessageSink that delegates to the current broadcast sink.
 * Intercepts agentConversation messages to buffer entries per agent.
 */
class DelegatingSink implements MessageSink {
	current: MessageSink | undefined;
	private agentManager: StandaloneAgentManager | undefined;

	setAgentManager(mgr: StandaloneAgentManager): void {
		this.agentManager = mgr;
	}

	postMessage(msg: unknown): void {
		// Intercept conversation messages to buffer them
		const m = msg as Record<string, unknown>;
		if (m.type === 'agentConversation' && this.agentManager) {
			const agentId = m.id as number;
			const entries = m.entries as ConversationEntry[];
			const agent = this.agentManager.agents.get(agentId);
			if (agent && entries) {
				agent.conversationBuffer.push(...entries);
				// Cap buffer size
				if (agent.conversationBuffer.length > CONVERSATION_BUFFER_SIZE) {
					agent.conversationBuffer.splice(0, agent.conversationBuffer.length - CONVERSATION_BUFFER_SIZE);
				}
			}
		}
		this.current?.postMessage(msg);
	}
}

export class StandaloneAgentManager {
	agents = new Map<number, StandaloneAgentState>();
	private nextAgentId = 1;

	// Per-agent timers (shared with fileWatcher)
	fileWatchers = new Map<number, fs.FSWatcher>();
	pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
	waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
	permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

	// File path → agent ID mapping
	private fileToAgent = new Map<string, number>();

	// Delegating sink — always points to the latest broadcast target
	private delegatingSink = new DelegatingSink();

	constructor() {
		this.delegatingSink.setAgentManager(this);
	}

	setSink(sink: MessageSink | undefined): void {
		this.delegatingSink.current = sink;
	}

	hasSession(jsonlFile: string): boolean {
		return this.fileToAgent.has(jsonlFile);
	}

	addSession(projectDir: string, jsonlFile: string, projectName: string, workspacePath?: string, persistentAgentId?: string, agentMeta?: Record<string, unknown>): void {
		if (this.fileToAgent.has(jsonlFile)) return;

		const sessionId = path.basename(jsonlFile, '.jsonl');
		const id = this.nextAgentId++;
		const taskTitle = extractSessionTaskTitle(jsonlFile);

		const agent: StandaloneAgentState = {
			id,
			projectDir,
			jsonlFile,
			folderName: projectName,
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			sessionId,
			projectName,
			conversationBuffer: [],
			workspacePath,
			persistentAgentId,
			taskTitle,
		};

		this.agents.set(id, agent);
		this.fileToAgent.set(jsonlFile, id);

		console.log(`[Standalone] Agent ${id}: tracking ${projectName}/${sessionId}`);
		this.delegatingSink.postMessage({ type: 'agentCreated', id, sessionId, folderName: projectName, taskTitle, ...(agentMeta ?? {}) });

		// Start watching from end of file (don't replay history)
		// but peek at the tail to determine if the agent is currently active
		try {
			if (fs.existsSync(jsonlFile)) {
				const stat = fs.statSync(jsonlFile);
				agent.fileOffset = stat.size;

				// Read last ~4KB to find the most recent record type
				const peekSize = Math.min(4096, stat.size);
				if (peekSize > 0) {
					const buf = Buffer.alloc(peekSize);
					const fd = fs.openSync(jsonlFile, 'r');
					fs.readSync(fd, buf, 0, peekSize, stat.size - peekSize);
					fs.closeSync(fd);
					const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
					// Walk backwards to find the last meaningful record
					for (let i = lines.length - 1; i >= 0; i--) {
						try {
							const rec = JSON.parse(lines[i]);
							if (rec.type === 'system' && rec.subtype === 'turn_duration') {
								// Turn completed — agent is waiting for input
								agent.isWaiting = true;
								break;
							} else if (rec.type === 'assistant') {
								// Assistant was responding — agent is active
								agent.hadToolsInTurn = true;
								break;
							} else if (rec.type === 'user') {
								const content = rec.message?.content;
								if (Array.isArray(content) && content.some((b: { type: string }) => b.type === 'tool_result')) {
									// Tool result — agent is mid-loop, active
									agent.hadToolsInTurn = true;
								}
								// User text prompt — could be start of new turn
								break;
							}
						} catch { /* skip malformed */ }
					}
				}
			}
		} catch {
			// File may not exist yet
		}

		startFileWatching(
			id, jsonlFile,
			this.agents, this.fileWatchers, this.pollingTimers,
			this.waitingTimers, this.permissionTimers,
			this.delegatingSink,
		);
	}

	removeSession(jsonlFile: string): void {
		const id = this.fileToAgent.get(jsonlFile);
		if (id === undefined) return;

		this.fileToAgent.delete(jsonlFile);
		const agent = this.agents.get(id);
		if (!agent) return;

		// Stop file watching
		this.fileWatchers.get(id)?.close();
		this.fileWatchers.delete(id);
		const pt = this.pollingTimers.get(id);
		if (pt) clearInterval(pt);
		this.pollingTimers.delete(id);
		try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

		// Cancel timers
		cancelWaitingTimer(id, this.waitingTimers);
		cancelPermissionTimer(id, this.permissionTimers);

		this.agents.delete(id);
		console.log(`[Standalone] Agent ${id}: removed (stale)`);
		this.delegatingSink.postMessage({ type: 'agentClosed', id });
	}

	getExistingAgentIds(): number[] {
		return [...this.agents.keys()].sort((a, b) => a - b);
	}

	getSessionIds(): Record<number, string> {
		const result: Record<number, string> = {};
		for (const [id, agent] of this.agents) {
			result[id] = agent.sessionId;
		}
		return result;
	}

	/** Per-live-agent task titles (opening prompt), for the existingAgents payload. */
	getTaskTitles(): Record<number, string> {
		const result: Record<number, string> = {};
		for (const [id, agent] of this.agents) {
			if (agent.taskTitle) result[id] = agent.taskTitle;
		}
		return result;
	}

	getSessionIdForAgent(agentId: number): string | null {
		const agent = this.agents.get(agentId);
		return agent?.sessionId ?? null;
	}

	/** Find the live numeric agent id bound to a sessionId, or null. */
	getAgentIdBySessionId(sessionId: string): number | null {
		for (const [id, agent] of this.agents) {
			if (agent.sessionId === sessionId) return id;
		}
		return null;
	}

	/**
	 * Re-point a live session at a different persistent agent without tearing
	 * down its file watching / numeric id. Used when the user identifies a
	 * freshly-discovered session as an existing employee — we keep the running
	 * character but swap which PersistentAgent it represents.
	 *
	 * Returns the live numeric id, or null if no session matched.
	 */
	rebindSession(sessionId: string, persistentAgentId: string): number | null {
		for (const [id, agent] of this.agents) {
			if (agent.sessionId === sessionId) {
				agent.persistentAgentId = persistentAgentId;
				return id;
			}
		}
		return null;
	}

	/** Get all live session IDs */
	getLiveSessionIds(): Set<string> {
		const ids = new Set<string>();
		for (const agent of this.agents.values()) {
			ids.add(agent.sessionId);
		}
		return ids;
	}

	/**
	 * Remove the live session whose sessionId matches. Used when a user fires
	 * a non-persistent live agent (the session record carries a sessionId but
	 * no persistentAgentId).
	 *
	 * Returns true if a matching session was found and removed.
	 */
	removeSessionBySessionId(sessionId: string): boolean {
		for (const agent of this.agents.values()) {
			if (agent.sessionId === sessionId) {
				this.removeSession(agent.jsonlFile);
				return true;
			}
		}
		return false;
	}

	/**
	 * Remove the live session bound to a given persistent-agent id. Used when
	 * a user fires a persistent agent that's currently running.
	 *
	 * Returns true if a matching session was found and removed.
	 */
	removeSessionByPersistentAgentId(persistentAgentId: string): boolean {
		for (const agent of this.agents.values()) {
			if (agent.persistentAgentId === persistentAgentId) {
				this.removeSession(agent.jsonlFile);
				return true;
			}
		}
		return false;
	}

	/** Send current tool/status state to the sink (for newly connected clients) */
	sendAgentStatuses(ws: MessageSink): void {
		for (const [agentId, agent] of this.agents) {
			for (const [toolId, status] of agent.activeToolStatuses) {
				ws.postMessage({
					type: 'agentToolStart',
					id: agentId,
					toolId,
					status,
				});
			}
			if (agent.isWaiting) {
				ws.postMessage({
					type: 'agentStatus',
					id: agentId,
					status: 'waiting',
				});
			}
			// Send buffered conversation history
			if (agent.conversationBuffer.length > 0) {
				ws.postMessage({
					type: 'agentConversationHistory',
					id: agentId,
					entries: agent.conversationBuffer,
				});
			}
		}
	}

	dispose(): void {
		for (const jsonlFile of [...this.fileToAgent.keys()]) {
			this.removeSession(jsonlFile);
		}
	}
}
