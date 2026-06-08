import type { BaseAgentState, ConversationEntry } from '../src/types.js';

export interface StandaloneAgentState extends BaseAgentState {
	sessionId: string;
	projectName: string;
	conversationBuffer: ConversationEntry[];
	/** Decoded actual workspace path (best-effort from project hash) */
	workspacePath?: string;
	/** Linked persistent agent ID, if any */
	persistentAgentId?: string;
}

export interface OfflineAgent {
	sessionId: string;
	name?: string;
	projectName?: string;
	workspacePath?: string;
	palette?: number;
	hueShift?: number;
	/** If this is a persistent agent */
	isPersistent?: boolean;
	roleShort?: string;
	roleFull?: string;
	lastSessionEnd?: string;
	sessionCount?: number;
	avatarConfig?: string;
}
