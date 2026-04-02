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
