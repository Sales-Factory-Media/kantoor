// ── Standalone Server ────────────────────────────────────────
export const SERVER_PORT = 3333;
export const PROJECT_DIR_SCAN_INTERVAL_MS = 2000;
export const JSONL_SCAN_INTERVAL_MS = 1000;
export const STALE_CHECK_INTERVAL_MS = 5000; // check for dead sessions every 5s
export const CLICKUP_POLL_INTERVAL_MS = 300000; // poll ClickUp every 5 minutes

// ── Peers / Conference ──────────────────────────────────────
export const PEERS_BROKER_PORT = 7899;
export const PEERS_BROKER_URL = 'http://localhost:7899';
export const CONFERENCE_AGENT_DELAY_MS = 3000;
export const DARRYL_ROLE_SHORT = 'Foreman';
export const DARRYL_CLICKUP_USERNAME = 'Darryl Philbin';
export const DARRYL_ESCALATION_USERNAME = 'Anne De Jong';
export const DARRYL_WORKSPACE = '~/Projects/kantoor-workspace';

// ── Jan (Art Director) ────────────────────────────────────
export const JAN_ROLE_SHORT = 'Art Director';
export const JAN_CLICKUP_USERNAME = 'Jan Levinson';
export const JAN_WORKSPACE = '~/Projects/kantoor-workspace';

// ── Multi-Worker ───────────────────────────────────────────
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const WORKER_HEARTBEAT_TIMEOUT_MS = 90_000;
export const WORKER_RECONNECT_INTERVAL_MS = 5_000;

// ── MemPalace ─────────────────────────────────────────────
export const MEMPALACE_SERVER_PORT = 3334;
export const MEMPALACE_SERVER_URL = `http://localhost:${MEMPALACE_SERVER_PORT}`;
