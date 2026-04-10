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

// ── Project Manager ──────────────────────────────────────
export const PM_ROLE_SHORT = 'Project Manager';
export const PM_WORKSPACE = '~/Projects/kantoor-workspace';

// ── Design Teams ──────────────────────────────────────────
// NOTE: DESIGNER_ROLE_SHORT renamed from 'Designer' to 'UX Designer'.
// Existing persisted agents are migrated on load (see agentStore.ts).
export const DESIGNER_ROLE_SHORT = 'UX Designer';
export const VISUAL_DESIGNER_ROLE_SHORT = 'Visual Designer';
export const UX_PM_ROLE_SHORT = 'UX Project Manager';
export const UX_QA_ROLE_SHORT = 'UX Quality Reviewer';
export const VISUAL_PM_ROLE_SHORT = 'Visual Project Manager';
export const VISUAL_QA_ROLE_SHORT = 'Visual Quality Reviewer';
export const TEAM_UX_ID = 'ux-design';
export const TEAM_VISUAL_ID = 'visual-design';
export const TEAM_WORKER_COUNT = 5;

// ── Review / Feedback Loop ────────────────────────────────
export const REVIEW_TRIGGER_DELAY_MS = 5000;
export const MAX_REVISION_COUNT = 3;

// ── Multi-Worker ───────────────────────────────────────────
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const WORKER_HEARTBEAT_TIMEOUT_MS = 90_000;
export const WORKER_RECONNECT_INTERVAL_MS = 5_000;

// ── MemPalace ─────────────────────────────────────────────
export const MEMPALACE_SERVER_PORT = 3334;
export const MEMPALACE_SERVER_URL = `http://localhost:${MEMPALACE_SERVER_PORT}`;
