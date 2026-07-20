// ── Standalone Server ────────────────────────────────────────
export const SERVER_PORT = 3333;
export const PROJECT_DIR_SCAN_INTERVAL_MS = 2000;
export const JSONL_SCAN_INTERVAL_MS = 1000;
export const STALE_CHECK_INTERVAL_MS = 2000; // check for dead sessions every 2s
export const CLICKUP_POLL_INTERVAL_MS = 300000; // poll ClickUp every 5 minutes

// ── Peers / Conference ──────────────────────────────────────
export const PEERS_BROKER_PORT = 7899;
export const PEERS_BROKER_URL = 'http://localhost:7899';
export const CONFERENCE_AGENT_DELAY_MS = 3000;
export const DARRYL_ROLE_SHORT = 'Foreman';
export const DARRYL_CLICKUP_USERNAME = 'Darryl Philbin';
export const DARRYL_ESCALATION_USERNAME = 'Anne De Jong';
export const DARRYL_WORKSPACE = '~/Projects/kantoor-workspace';

// ── Auto Mode (human-gated Darryl delegation) ─────────────
// When Auto Mode is ON, tickets in "to do" assigned to this ClickUp user are
// handed to Darryl one at a time to classify (pick the best worker). His
// recommendation surfaces as a confirmation popup in the kantoor; the human
// clicks Start to actually dispatch. See standalone/delegationStore.ts.
export const AUTO_MODE_ASSIGNEE_USERNAME = 'Jasper Kennis';

// ── Jan (Art Director) ────────────────────────────────────
export const JAN_ROLE_SHORT = 'Art Director';
export const JAN_CLICKUP_USERNAME = 'Jan Levinson';
export const JAN_WORKSPACE = '~/Projects/kantoor-workspace';

// ── Project Manager (RETIRED 2026-04-22) ─────────────────
// PM agents are no longer launched. Jan does the PM work herself.
// These constants are kept only so loadPersistentAgents() can tag
// legacy PM agents as `retired: true` during migration.
export const PM_ROLE_SHORT = 'Project Manager';

// ── Design Teams ──────────────────────────────────────────
// NOTE: DESIGNER_ROLE_SHORT renamed from 'Designer' to 'UX Designer'.
// Existing persisted agents are migrated on load (see agentStore.ts).
export const DESIGNER_ROLE_SHORT = 'UX Designer';
export const VISUAL_DESIGNER_ROLE_SHORT = 'Visual Designer';
// UX_PM_ROLE_SHORT / VISUAL_PM_ROLE_SHORT are retired (2026-04-22).
// Kept for the loadPersistentAgents() retirement migration.
export const UX_PM_ROLE_SHORT = 'UX Project Manager';
export const UX_QA_ROLE_SHORT = 'UX Quality Reviewer';
export const VISUAL_PM_ROLE_SHORT = 'Visual Project Manager';
export const VISUAL_QA_ROLE_SHORT = 'Visual Quality Reviewer';
export const TEAM_UX_ID = 'ux-design';
export const TEAM_VISUAL_ID = 'visual-design';
export const TEAM_WORKER_COUNT = 5;

// ── Jan Design Config Defaults ────────────────────────────
export const DEFAULT_DESIGN_FIGMA_URL = 'https://www.figma.com/design/aFC3igAq9P5iHtm2Gie8ta/Agent-workspace---Isolated-App-2.0?node-id=174-12168&p=f&t=u5tEjuD66B5WPC1Z-0';
export const DEFAULT_DESIGN_CLICKUP_DOC_URL = 'https://app.clickup.com/90152414906/v/dc/2kyr1bnu-2595/2kyr1bnu-2795';
// Reference page with example screens that designers/QA should consult when
// unsure about visual direction, layout, or component usage.
export const DEFAULT_DESIGN_EXAMPLES_URL = 'https://www.figma.com/design/aFC3igAq9P5iHtm2Gie8ta/Agent-workspace---Isolated-App-2.0?node-id=2121-3569';

// ── Review / Feedback Loop ────────────────────────────────
export const REVIEW_TRIGGER_DELAY_MS = 5000;
export const MAX_REVISION_COUNT = 3;

// ── AI Review pipeline ────────────────────────────────────
// Two flags split from the old single AI_REVIEW_ENABLED:
//
// - AI_REVIEW_AUTO_ESCALATE: do agents automatically move finished work to
//   "ai review"? When false, workers/designers always move to "qa test" and
//   session-end does NOT auto-trigger Visual QA or revision pickup. This was
//   paused 2026-04-22 because auto-escalation + Copilot feedback was creating
//   messy cycles.
//
// - AI_REVIEW_PICKUP_ENABLED: if a ticket ends up in "ai review" (e.g. a
//   human placed it there manually), should the system auto-pick-it-up and
//   dispatch a QA / AI-review agent? Disabled 2026-04-29 — we don't want
//   automatic AI review running at all right now. Tickets sitting in
//   "ai review" are left alone; a human must move them out manually.
export const AI_REVIEW_AUTO_ESCALATE = false;
export const AI_REVIEW_PICKUP_ENABLED = false;

// ── Visual Design: Dark Mode ───────────────────────────────
// When false (default 2026-04-22), Visual Designers are explicitly told NOT to
// produce a dark-mode variant. When true, dark mode becomes a required deliverable
// and the Visual QA checks for parity. Flip this when the design system is ready
// for dark mode across the product.
export const VISUAL_DESIGN_DARK_MODE_REQUIRED = false;

// ── Multi-Worker ───────────────────────────────────────────
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
export const WORKER_HEARTBEAT_TIMEOUT_MS = 90_000;
export const WORKER_RECONNECT_INTERVAL_MS = 5_000;
export const WORKER_DISPATCH_TIMEOUT_MS = 20_000;

// Worker role tags. Workers default to both (back-compat for single-machine hubs).
export const WORKER_ROLE_DEV = 'dev';
export const WORKER_ROLE_DESIGNER = 'designer';
export const DEFAULT_WORKER_ROLES: readonly string[] = [WORKER_ROLE_DEV, WORKER_ROLE_DESIGNER];

// ── MemPalace ─────────────────────────────────────────────
export const MEMPALACE_SERVER_PORT = 3334;
export const MEMPALACE_SERVER_URL = `http://localhost:${MEMPALACE_SERVER_PORT}`;
