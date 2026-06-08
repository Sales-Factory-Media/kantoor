/** Generic message target — implemented by the standalone WebSocket wrapper */
export interface MessageSink {
	postMessage(msg: unknown): void;
}

/** Agent state fields shared between extension and standalone modes (everything except terminalRef) */
export interface BaseAgentState {
	id: number;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	/** Workspace folder name */
	folderName: string;
}

export interface ConversationEntry {
	kind: 'assistant_text' | 'user_text' | 'tool_use' | 'tool_result' | 'turn_end';
	content: string;
	toolId?: string;
	toolName?: string;
}
