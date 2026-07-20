// ── Timing (ms) ──────────────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 1000;
export const PROJECT_SCAN_INTERVAL_MS = 1000;
export const TOOL_DONE_DELAY_MS = 300;
export const PERMISSION_TIMER_DELAY_MS = 7000;
export const TEXT_IDLE_DELAY_MS = 5000;

// ── Display Truncation ──────────────────────────────────────
export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;
/** Safety bound on the per-session task title (the agent's opening prompt).
 *  The employee cards wrap and grow to fit the full text, so this is only a
 *  runaway guard against a pathologically long paste — realistic task prompts
 *  are shown in full. */
export const SESSION_TASK_TITLE_MAX_LENGTH = 1200;
/** Bytes read from the head of a JSONL to find the session's opening prompt. */
export const SESSION_TASK_TITLE_SCAN_BYTES = 65536;

// ── PNG / Asset Parsing ─────────────────────────────────────
export const PNG_ALPHA_THRESHOLD = 128;
export const WALL_PIECE_WIDTH = 16;
export const WALL_PIECE_HEIGHT = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;
export const FLOOR_PATTERN_COUNT = 9;
export const FLOOR_TILE_SIZE = 16;
export const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;
export const CHAR_FRAMES_PER_ROW = 7;
export const CHAR_COUNT = 6;

// ── User-Level Persistence ────────────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';

// ── Conversation Panel ──────────────────────────────────────
export const CONVERSATION_BUFFER_SIZE = 200;
export const CONVERSATION_TEXT_MAX_LENGTH = 500;
export const CONVERSATION_TOOL_RESULT_MAX_LENGTH = 300;

// ── Settings Persistence ────────────────────────────────────
export const GLOBAL_KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'pixel-agents.showPanel';
export const WORKSPACE_KEY_AGENTS = 'pixel-agents.agents';
export const WORKSPACE_KEY_AGENT_SEATS = 'pixel-agents.agentSeats';
export const TERMINAL_NAME_PREFIX = 'Claude Code';
