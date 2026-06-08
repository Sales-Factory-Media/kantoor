# Pixel Agents — Compressed Reference

Pixel art office where AI agents (Claude Code sessions) are animated characters. Runs as a **standalone Node.js server** (primary) or a VS Code extension with embedded React webview.

**Development focus**: New features should target the standalone version unless explicitly stated otherwise. The standalone server (`standalone/`) and shared modules (`src/types.ts`, `src/fileWatcher.ts`, `src/transcriptParser.ts`, `src/timerManager.ts`, `src/assetLoader.ts`, `src/layoutPersistence.ts`, `src/constants.ts`) are the primary codebase. The VS Code extension (`src/PixelAgentsViewProvider.ts`, `src/agentManager.ts`, `src/extension.ts`) is maintained but not the focus.

## Architecture

```
standalone/                   — Standalone Node.js server (primary dev target)
  server.ts                  — HTTP + WebSocket server, asset preloading, message dispatch
  standaloneAgentManager.ts  — Agent lifecycle: add/remove sessions, status sync
  projectScanner.ts          — Scans ~/.claude/projects/ for JSONL files, ps aux for live sessions
  itermFocus.ts              — macOS: focus iTerm2 tab by session ID (osascript)
  agentStore.ts              — PersistentAgent CRUD, Drizzle-backed; dedup + cross-building collision defenses
  buildingHandlers.ts        — Building list/switch/create, project membership toggling
  launchHelpers.ts           — Shared launch boilerplate (delegates to itermFocus.launchAgentSession)
  workerDispatch.ts          — Unified dispatcher: local-first, cascade to remote workers via fleet RPC
  orchestratorDispatch.ts    — Shared batch-dispatch helper used by Jan/Darryl autopickup paths
  dispatchRegistry.ts        — In-flight ticket claims (atomic claim/release, prevents races)
  workerRegistry.ts          — Remote-worker connection tracking + per-machine state
  conferenceHandlers.ts      — Two-agent peer conferences via claude-peers MCP
  constants.ts               — Server port, scan intervals, role constants, JAN_WORKSPACE
  types.ts                   — StandaloneAgentState (extends BaseAgentState)

src/                          — Extension backend (Node.js, VS Code API) + shared modules
  db/                         — Drizzle ORM + Postgres (replaces ~/.pixel-agents/*.json state)
    client.ts                 — Pool + drizzle() factory; DATABASE_URL env or localhost:5438 default
    schema.ts                 — buildings, persistent_agents, seats, projects, building_projects, worker_assignments, app_settings
    migrate.ts                — Runs SQL migrations on boot
    migrateFromJson.ts        — One-shot legacy ~/.pixel-agents/*.json → DB import (idempotent, only fires when buildings table empty)
    activeBuilding.ts         — In-memory "active building" cell; switchActiveBuilding() flips it
    seatStore.ts              — Seat metadata per (buildingId, sessionId)
    settingsStore.ts          — Global app_settings key/value (soundEnabled, janDesignConfig)
    workerAssignmentStore.ts  — Worker assignment audit trail per building
  connectors/                 — Ticket-source abstraction (per-building)
    types.ts                  — ProjectConnector interface (fetchTickets, getTicket, addComment, moveStatus)
    clickup.ts                — ClickUp connector (wraps clickupClient)
    github.ts                 — GitHub Issues connector
    registry.ts               — connectorForBuilding(building) — picks implementation by connectorType
    clickupClient.ts          — Low-level ClickUp HTTP client
  projectStore.ts             — Active-building project pool cache (M2M via building_projects)
  constants.ts                — All backend magic numbers/strings (timing, truncation, asset parsing, VS Code IDs)
  extension.ts                — Entry: activate(), deactivate()
  PixelAgentsViewProvider.ts   — WebviewViewProvider, message dispatch, asset loading
  assetLoader.ts              — PNG parsing, sprite conversion, catalog building, default layout loading
  agentManager.ts             — Terminal lifecycle: launch, remove, restore, persist
  layoutPersistence.ts        — User-level layout file I/O (~/.pixel-agents/layout.json), migration, cross-window watching
  fileWatcher.ts              — fs.watch + polling, readNewLines, /clear detection, terminal adoption
  transcriptParser.ts         — JSONL parsing: tool_use/tool_result → webview messages
  timerManager.ts             — Waiting/permission timer logic
  types.ts                    — Shared interfaces (AgentState, PersistedAgent)

webview-ui/src/               — React + TypeScript (Vite)
  constants.ts                — All webview magic numbers/strings (grid, animation, rendering, camera, zoom, editor, game logic, notification sound)
  notificationSound.ts        — Web Audio API chime on agent turn completion, with enable/disable
  App.tsx                     — Composition root, hooks + components + EditActionBar
  hooks/
    useExtensionMessages.ts   — Message handler + agent/tool state
    useEditorActions.ts       — Editor state + callbacks
    useEditorKeyboard.ts      — Keyboard shortcut effect
  components/
    BottomToolbar.tsx          — + Agent, Layout toggle, Settings button
    ZoomControls.tsx           — +/- zoom (top-right)
    SettingsModal.tsx          — Centered modal: settings, export/import layout, sound toggle, debug toggle
    DebugView.tsx              — Debug overlay
  office/
    types.ts                  — Interfaces (OfficeLayout, FloorColor, Character, etc.) + re-exports constants from constants.ts
    toolUtils.ts              — STATUS_TO_TOOL mapping, extractToolName(), defaultZoom()
    colorize.ts               — Dual-mode color module: Colorize (grayscale→HSL) + Adjust (HSL shift)
    floorTiles.ts             — Floor sprite storage + colorized cache
    wallTiles.ts              — Wall auto-tile: 16 bitmask sprites from walls.png
    sprites/
      spriteData.ts           — Pixel data: characters (6 pre-colored from PNGs, fallback templates), furniture, tiles, bubbles
      spriteCache.ts          — SpriteData → offscreen canvas, per-zoom WeakMap cache, outline sprites
    editor/
      editorActions.ts        — Pure layout ops: paint, place, remove, move, rotate, toggleState, canPlace, expandLayout
      editorState.ts          — Imperative state: tools, ghost, selection, undo/redo, dirty, drag
      EditorToolbar.tsx       — React toolbar/palette for edit mode
    layout/
      furnitureCatalog.ts     — Dynamic catalog from loaded assets + getCatalogEntry()
      layoutSerializer.ts     — OfficeLayout ↔ runtime (tileMap, furniture, seats, blocked)
      tileMap.ts              — Walkability, BFS pathfinding
    engine/
      characters.ts           — Character FSM: idle/walk/type + wander AI
      officeState.ts          — Game world: layout, characters, seats, selection, subagents
      gameLoop.ts             — rAF loop with delta time (capped 0.1s)
      renderer.ts             — Canvas: tiles, z-sorted entities, overlays, edit UI
      matrixEffect.ts         — Matrix-style spawn/despawn digital rain effect
    components/
      OfficeCanvas.tsx        — Canvas, resize, DPR, mouse hit-testing, edit interactions, drag-to-move
      ToolOverlay.tsx          — Activity status label above hovered/selected character + close button

scripts/                      — 7-stage asset extraction pipeline
  0-import-tileset.ts         — Interactive CLI wrapper
  1-detect-assets.ts          — Flood-fill asset detection
  2-asset-editor.html         — Browser UI for position/bounds editing
  3-vision-inspect.ts         — Claude vision auto-metadata
  4-review-metadata.html      — Browser UI for metadata review
  5-export-assets.ts          — Export PNGs + furniture-catalog.json
  asset-manager.html          — Unified editor (Stage 2+4 combined), Save/Save As via File System Access API
  generate-walls.js           — Generate walls.png (4×4 grid of 16×32 auto-tile pieces)
  wall-tile-editor.html       — Browser UI for editing wall tile appearance
```

## Buildings

A **building** represents one company / workspace context with its own ticket connector (ClickUp or GitHub Issues), org chart, agents, seats, and project membership. Seeded by `migrateLegacyJsonIntoDb` with `vibelab` (ClickUp) + `pc` (GitHub). Webview top-left dropdown switches the active building (`handleSwitchBuilding` stops connector polling, re-inits every store cache from DB, rebuilds connector, broadcasts fresh state).

**Storage**: `src/db/schema.ts` is the source of truth. Postgres 16 in docker-compose. Drizzle ORM. Migrations in `src/db/migrations/`. The legacy JSON files in `~/.pixel-agents/` are NOT read at runtime anymore — `migrateLegacyJsonIntoDb` is the one-shot importer and only runs when the `buildings` table is empty.

**M2M projects**: `projects` is a global pool keyed by `workspace_path`. `building_projects` joins them. The same project can belong to N buildings, or none. `projectStore.ts` caches the active building's project list and exposes `addKnownProject`, `setProjectMembership`, `listAllProjectsWithMembership`.

**Identity rule**: `PersistentAgent.id` is the only unique key — globally, across buildings. `name` is NOT unique (multiple projects can each have a "Pam"). Uniqueness for "same conceptual worker" is the tuple `(building_id, name, workspace_path)`. Any dedup/cleanup logic MUST key on `workspace_path` too.

**Org-wide staff workspace**: `JAN_WORKSPACE = ~/Projects/kantoor-workspace` is the shared workspace for Jan + design-team agents — they exist per-building but are never tied to a specific project. The sidebar filter (`agentSidebarUtils.groupByRoom`) treats `kantoor-workspace` paths as "always-visible" to keep org-wide staff from disappearing into the per-building filter.

**Defense layer in `agentStore.ts`**: legacy data + race-prone fire-and-forget saves used to leave duplicate-id rows in the DB. Three defenses now stack: within-batch dedup by id, cross-building id collision detection (skip + warn — non-destructive), per-building Promise-chain save serializer. Diagnostic SQL at the bottom of the file. One-time cleanup script: `scripts/cleanup-duplicate-agents.ts` (dry-run by default, `--apply` to delete; groups by `(building_id, name, workspace_path)`).

## Dev Work AI Review (Darryl's flow)

All dev work dispatched by Darryl goes through GitHub Copilot review before reaching humans. Worker finishes → moves ticket to `ai review` (NOT `qa test`) → Copilot reviews the PR. On the next polling cycle, `autoDarrylPickup` picks up `ai review` tickets assigned to Darryl (prioritized over `to do`) and dispatches Darryl with `ticketStatus = 'ai review'`. `handleDarrylHandleTicket` branches on this and gives Darryl an "AI Review dispatch" initial task: find the original implementer in the ticket comments (look for `Assigned to worker: ...`), reassign them via `POST /api/launch-agent` with `aiReviewMode: true`. The reassigned agent receives a feedback-processing initial task: move to `in progress`, read Copilot's PR comments, decide if anything actionable remains, then either fix-and-push-and-back-to-`ai review` or forward to `qa test`. Three-round soft cap: if a ticket has cycled through ai review 3+ times, Darryl tells the agent to be conservative and forward to qa test unless there's a real bug. Reviewer's character matches Visual QA: nitpicky but not hostage-taking.

The `aiReviewMode` flag flows through `launchAgentOnTicket(ctx, options.aiReviewMode)` and the `/api/launch-agent` HTTP endpoint. The default dev system prompt (`buildSystemPrompt` in `agentStore.ts`) tells every worker to move finished work to `ai review` instead of `qa test` and explains the Copilot loop.

## Design Teams (Jan's Office)

Two teams under Jan (Art Director), each with 1 PM, 1 QA reviewer, and 5 worker designers. Defined statically in `TEAMS` (`standalone/agentStore.ts`); seeded on server startup via `seedDesignTeams()` (idempotent). Each `PersistentAgent` carries `teamId` and `reportsToId` for explicit hierarchy.

- **UX Design Team** (`ux-design`): 5 UX Designers + 1 UX Quality Reviewer. Workflow: Jan (`to refine` ticket) → Jan creates 5 briefings → UX Designers work in parallel from a free worker pool → designer moves ticket to `qa test` (human review). Jan does NOT review UX output herself (she never opens Figma — see "Jan's role").
- **Visual Design Team** (`visual-design`): 5 Visual Designers + 1 Visual Quality Reviewer. Workflow: Jan (`to do` ticket) → free Visual Designer picks up → moves ticket to `ai review` → Jan's next batch sees `ai review` → dispatches Visual QA via `/api/launch-visual-qa`. Pass: ticket → `qa test` (human); Fail: ticket → `revision needed` → Jan's next batch dispatches the revision.

**Jan's role** (pure orchestrator): Jan NEVER opens Figma or reads designer output. Her inputs are ClickUp (`clickup_get_task*`) and fleet state (`GET /api/roster`). She handles four ClickUp statuses — `to refine` → 5 UX briefings, `to do` → Visual Designer dispatch, `ai review` → Visual QA dispatch, `revision needed` → designer re-dispatch with `revisionMode:true`. Every design decision routes through her — there is no direct revision-pickup or QA-safety-net shortcut.

**Visual-slot lock** (`findBusyVisualSlot` in `capacity.ts`): Each machine has one visual task slot — UX Designer, Visual Designer, and Visual QA all share it because they compete for the local Figma instance. Per-device (not global), so hub + N remote workers = N+1 parallel visual tasks. Launch endpoints return `visualSlotBusy:true` when the local slot is taken; the caller cascades to idle remote workers via `dispatchToFleet`.

**Dispatch registry** (`dispatchRegistry.ts`): The single source of truth for "is this ticket currently in flight". Every dispatch entry point atomically claims the ticket (`claimTicket`) before launch; every completion path releases (`releaseTicket` — idempotent). Auto-pickup cycles filter claimed ticket IDs via `claimedTicketIds()` before considering dispatch. Replaces the scattered composition of stale ClickUp cache + `worker.currentTicketId` + `pa.currentSessionId` that used to race.

**Auto-pickup** (`clickupHandlers.ts`): Two public entry points only. `autoDarrylPickup` handles all dev tickets; `autoJanPickup` handles all design tickets across the four statuses above. `autoPickupAfterWorkerFree` is a debounced (250ms) wrapper that fires both after worker-free events. The planning logic lives in pure helpers (`selectDarrylPickups`, `selectJanPickups` in `pickupPlanner.ts`) — covered by unit tests.

**Launch handlers**: `handleLaunchDesigner` / `handleLaunchVisualDesigner` / `handleVisualQaReview` claim the ticket at entry, try local machine first (`findBusyVisualSlot` check), cascade to fleet on `visualSlotBusy`, release the claim if every path fails.

**Organogram view**: Webview button under "Conference" in `AgentSidebar`. Renders a tree (Jan → PMs → workers + QA) from `organogramSnapshot` WS payload built by `buildOrganogram()`. Click a node to focus the character.

**QA checklists**: Visual QA uses a placeholder rubric pending the formal checklist (ClickUp 86c99ab8f). UX QA exists in the org but has no automated workflow yet.

## Standalone Mode

**Entry point**: `standalone/server.ts` → bundled as `dist/standalone.js` via `node esbuild-standalone.js`.

**Communication**: WebSocket at `ws://localhost:3333/ws` (not VS Code postMessage). `webview-ui/src/vscodeApi.ts` detects standalone mode (`acquireVsCodeApi` absent) and creates a WebSocket wrapper that dispatches incoming messages as `window.MessageEvent` — the existing `useExtensionMessages` hook works unchanged.

**Agent discovery**: `ProjectScanner` scans `~/.claude/projects/` for JSONL files, checks `ps aux` for live `claude --session-id` processes. New JSONL files appearing during a live session are auto-adopted. No "+ Agent" button needed.

**Agent lifecycle**: Auto-discovered from live processes. Removed when process dies (`STALE_CHECK_INTERVAL_MS = 5s` poll via `ps aux`). `StandaloneAgentManager` handles add/remove/status sync; delegates file watching to shared `startFileWatching()`.

**Terminal focus**: `focusItermSession()` finds the TTY for a `claude --session-id <id>` process, then uses osascript to locate and select the matching iTerm2 tab.

**Persistence**: Postgres-backed via Drizzle ORM (`src/db/`). PersistentAgents, seats, projects, building_projects, worker_assignments, and app_settings all live in DB. Layout still uses the shared `~/.pixel-agents/layout.json` via `layoutPersistence.ts` — that's intentional (layout is per-machine workspace state, not building-scoped). Legacy `~/.pixel-agents/*.json` files are read once by `migrateLegacyJsonIntoDb` on first boot and then ignored — safe to delete manually after verification.

**Multi-client**: Broadcast WebSocket — `broadcastSink` sends to all connected `clients` Set. New clients receive full asset + agent state on `webviewReady`.

**Shared code**: Reuses `src/fileWatcher.ts`, `src/transcriptParser.ts`, `src/timerManager.ts`, `src/assetLoader.ts`, `src/layoutPersistence.ts`, `src/types.ts`, `src/constants.ts`.

**Not supported in standalone**: `openClaude`, `closeAgent`, `exportLayout`, `importLayout`, `openSessionsFolder` (no native dialogs).

## Core Concepts

**Vocabulary**: Terminal = VS Code terminal (or iTerm2 session in standalone) running Claude. Session = JSONL conversation file. Agent = webview character bound 1:1 to a terminal/session.

**Extension ↔ Webview**: `postMessage` protocol (VS Code) or WebSocket (standalone). Key messages: `openClaude`, `agentCreated/Closed`, `focusAgent`, `agentToolStart/Done/Clear`, `agentStatus`, `existingAgents`, `layoutLoaded`, `furnitureAssetsLoaded`, `floorTilesLoaded`, `wallTilesLoaded`, `saveLayout`, `saveAgentSeats`, `exportLayout`, `importLayout`, `settingsLoaded`, `setSoundEnabled`.

**One-agent-per-terminal** (extension): Each "+ Agent" click → new terminal (`claude --session-id <uuid>`) → immediate agent creation → 1s poll for `<uuid>.jsonl` → file watching starts.

**Auto-discovery** (standalone): `ProjectScanner` polls for new JSONL files (1s) and checks live processes (5s). Sessions appear/disappear automatically.

**Terminal adoption** (extension): Project-level 1s scan detects unknown JSONL files. If active terminal has no agent → adopt. If focused agent exists → reassign (`/clear` handling).

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use blocks or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result forwarded to webview, non-exempt tools trigger permission timers), `bash_progress` (long-running Bash output — restarts permission timer to confirm tool is executing), `mcp_progress` (MCP tool status — same timer restart logic). Also observed but not tracked: `file-history-snapshot`, `queue-operation`.

**File watching**: Hybrid `fs.watch` + 2s polling backup. Partial line buffering for mid-write reads. Tool done messages delayed 300ms to prevent flicker.

**Extension state per agent**: `id, terminalRef, projectDir, jsonlFile, fileOffset, lineBuffer, activeToolIds, activeToolStatuses, activeSubagentToolNames, isWaiting`.

**Persistence**: VS Code extension path persists agents to `workspaceState` key `'pixel-agents.agents'` (includes palette/hueShift/seatId). Standalone path persists to Postgres via Drizzle (`src/db/`) — see **Buildings** section. **Layout persisted to `~/.pixel-agents/layout.json`** in both paths (user-level, shared across all VS Code windows/workspaces). `layoutPersistence.ts` handles all file I/O: `readLayoutFromFile()`, `writeLayoutToFile()` (atomic via `.tmp` + rename), `migrateAndLoadLayout()` (checks file → migrates old workspace state → falls back to bundled default), `watchLayoutFile()` (hybrid `fs.watch` + 2s polling for cross-window sync). On save, `markOwnWrite()` prevents the watcher from re-reading our own write. External changes push `layoutLoaded` to the webview; skipped if the editor has unsaved changes (last-save-wins). On webview ready: `restoreAgents()` matches persisted entries to live terminals. `nextAgentId`/`nextTerminalIndex` advanced past restored values. **Default layout**: When no saved layout file exists and no workspace state to migrate, a bundled `default-layout.json` is loaded from `assets/` and written to the file. If that also doesn't exist, `createDefaultLayout()` generates a basic office. To update the default: run "Pixel Agents: Export Layout as Default" from the command palette (writes current layout to `webview-ui/public/assets/default-layout.json`), then rebuild. **Export/Import**: Settings modal offers Export Layout (save dialog → JSON file) and Import Layout (open dialog → validates `version: 1` + `tiles` array → writes to layout file + pushes `layoutLoaded` to webview).

## Office UI

**Rendering**: Game state in imperative `OfficeState` class (not React state). Pixel-perfect: zoom = integer device-pixels-per-sprite-pixel (1x–10x). No `ctx.scale(dpr)`. Default zoom = `Math.round(2 * devicePixelRatio)`. Z-sort all entities by Y. Pan via middle-mouse drag (`panRef`). **Camera follow**: `cameraFollowId` (separate from `selectedAgentId`) smoothly centers camera on the followed agent; set on agent click, cleared on deselection or manual pan.

**UI styling**: Pixel art aesthetic — all overlays use sharp corners (`borderRadius: 0`), solid backgrounds (`#1e1e2e`), `2px solid` borders, hard offset shadows (`2px 2px 0px #0a0a14`, no blur). CSS variables defined in `index.css` `:root` (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, etc.). Pixel font: FS Pixel Sans (`webview-ui/src/fonts/`), loaded via `@font-face` in `index.css`, applied globally.

**Characters**: FSM states — active (pathfind to seat, typing/reading animation by tool type), idle (wander randomly with BFS, return to seat for rest after `wanderLimit` moves). 4-directional sprites, left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading (Read/Grep/Glob/WebFetch). Sitting offset: characters shift down 6px when in TYPE state so they visually sit in their chair. Z-sort uses `ch.y + TILE_SIZE/2 + 0.5` so characters render in front of same-row furniture (chairs) but behind furniture at lower rows (desks, bookshelves). Chair z-sorting: non-back chairs use `zY = (row+1)*TILE_SIZE` (capped to first row) so characters at any seat tile render in front; back-facing chairs use `zY = (row+1)*TILE_SIZE + 1` so the chair back renders in front of the character. Chair tiles are blocked for all characters except their own assigned seat (per-character pathfinding via `withOwnSeatUnblocked`). **Diverse palette assignment**: `pickDiversePalette()` counts palettes of current non-sub-agent characters; picks randomly from least-used palette(s). First 6 agents each get a unique skin; beyond 6, skins repeat with a random hue shift (45–315°) via `adjustSprite()`. Character stores `palette` (0-5) + `hueShift` (degrees). Sprite cache keyed by `"palette:hueShift"`.

**Spawn/despawn effect**: Matrix-style digital rain animation (0.3s). 16 vertical columns sweep top-to-bottom with staggered timing (per-column random seeds). Spawn: green rain reveals character pixels behind the sweep. Despawn: character pixels consumed by green rain trails. `matrixEffect` field on Character (`'spawn'`/`'despawn'`/`null`). Normal FSM is paused during effect. Despawning characters skip hit-testing. Restored agents (`existingAgents`) use `skipSpawnEffect: true` to appear instantly. `matrixEffect.ts` contains `renderMatrixEffect()` (per-pixel rendering) called from renderer instead of cached sprite draw.

**Sub-agents**: Negative IDs (from -1 down). Created on `agentToolStart` with "Subtask:" prefix. Same palette + hueShift as parent. Click focuses parent terminal. Not persisted. Spawn at closest free seat to parent (Manhattan distance); fallback: closest walkable tile. **Sub-agent permission detection**: when a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent; if 5s elapse with no data, permission bubbles appear on both parent and sub-agent characters. `activeSubagentToolNames` (parentToolId → subToolId → toolName) tracks which sub-tools are active for the exempt check. Cleared when data resumes or Task completes.

**Speech bubbles**: Permission ("..." amber dots) stays until clicked/cleared. Waiting (green checkmark) auto-fades 2s. Sprites in `spriteData.ts`.

**Sound notifications**: Ascending two-note chime (E5 → E6) via Web Audio API plays when waiting bubble appears (`agentStatus: 'waiting'`). `notificationSound.ts` manages AudioContext lifecycle; `unlockAudio()` called on canvas mousedown to ensure context is resumed (webviews start suspended). Toggled via "Sound Notifications" checkbox in Settings modal. Enabled by default; persisted in extension `globalState` key `pixel-agents.soundEnabled`, sent to webview as `settingsLoaded` on init.

**Seats**: Derived from chair furniture. `layoutToSeats()` creates a seat at every footprint tile of every chair. Multi-tile chairs (e.g. 2-tile couches) produce multiple seats keyed `uid` / `uid:1` / `uid:2`. Facing direction priority: 1) chair `orientation` from catalog (front→DOWN, back→UP, left→LEFT, right→RIGHT), 2) adjacent desk direction, 3) forward (DOWN). Click character → select (white outline) → click available seat → reassign.

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture pick (eyedropper for furniture type), Eyedropper (floor).

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows (top N `backgroundTiles` rows) may overlap walls.

**Furniture**: Ghost preview (green/red validity). R key rotates, T key toggles on/off state. Drag-to-move in SELECT. Delete button (red X) + rotate button (blue arrow) on selected items. Any selected furniture shows HSBC color sliders (Color toggle + Clear button); color stored per-item in `PlacedFurniture.color?`. Single undo entry per color-editing session (tracked by `colorEditUidRef`). Pick tool copies type+color from placed item. Surface items preferred when clicking stacked furniture.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture). Right-click in floor/wall/erase tools also erases to VOID (supports drag-erasing). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction (left/right/up/down). New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max grid size: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize are relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: FloorColor[] }`. Grid dimensions are dynamic (not fixed constants). Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥128 = opaque). `loadDefaultLayout()` reads `assets/default-layout.json` (JSON OfficeLayout) as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?. String-based type system (no enum constraint). Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items (`canPlaceOnWalls: true`) use the `wall` category and appear in a dedicated "Wall" tab in the editor. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`, `CRT_MONITOR_BACK`). `orientation` is stored on `FurnitureCatalogEntry` and used for chair z-sorting and seat facing direction.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Flexible: supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants, showing only the off/default version. State groups are mirrored across orientations (on-state variants get their own rotation groups).

**Auto-state**: `officeState.rebuildFurnitureInstances()` swaps electronics to ON sprites when an active agent faces a desk with that item nearby (3 tiles deep in facing direction, 1 tile to each side). Operates at render time without modifying the saved layout.

**Background tiles**: `backgroundTiles?: number` on `FurnitureCatalogEntry` — top N footprint rows allow other furniture to be placed on them AND characters to walk through them. Items on background rows render behind the host furniture via z-sort (lower zY). Both `getBlockedTiles()` and `getPlacementBlockedTiles()` skip bg rows; `canPlaceFurniture()` also skips the new item's own bg rows (symmetric placement). Set via asset-manager.html "Background Tiles" field.

**Surface placement**: `canPlaceOnSurfaces?: boolean` on `FurnitureCatalogEntry` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks for surface items. Z-sort fix: `layoutToFurnitureInstances()` pre-computes desk zY per tile; surface items get `zY = max(spriteBottom, deskZY + 0.5)` so they render in front of the desk. Set via asset-manager.html "Can Place On Surfaces" checkbox. Exported through `5-export-assets.ts` → `furniture-catalog.json`.

**Wall placement**: `canPlaceOnWalls?: boolean` on `FurnitureCatalogEntry` — items like paintings, windows, clocks can only be placed on wall tiles (and cannot be placed on floor). `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map (negative row) or into VOID tiles. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile. Items can have negative `row` values in `PlacedFurniture`. Set via asset-manager.html "Can Place On Walls" checkbox.

**Colorize module**: Shared `colorize.ts` with two modes selected by `FloorColor.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture and character hue shifts): shifts original pixel HSL — H rotates hue (±180), S shifts saturation (±100), B/C shift lightness/contrast. `adjustSprite()` exported for reuse (character hue shifts). Toolbar shows a "Colorize" checkbox to toggle modes. Generic `Map<string, SpriteData>` cache keyed by arbitrary string (includes colorize flag). `layoutToFurnitureInstances()` colorizes sprites when `PlacedFurniture.color` is set.

**Floor tiles**: `floors.png` (112×16, 7 patterns). Cached by (pattern, h, s, b, c). Migration: old layouts auto-mapped to new patterns.

**Wall tiles**: `walls.png` (64×128, 4×4 grid of 16×32 pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16px above tile (3D face). Loaded by extension → `wallTilesLoaded` message. `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders (Colorize mode, stored per-tile in `tileColors`). Wall sprites are z-sorted with furniture and characters (`getWallInstances()` builds `FurnitureInstance[]` with `zY = (row+1)*TILE_SIZE`); only the flat base color is rendered in the tile pass. `generate-walls.js` creates the PNG; `wall-tile-editor.html` for visual editing.

**Character sprites**: 6 pre-colored PNGs (`assets/characters/char_0.png`–`char_5.png`), one per palette. Each 112×96: 7 frames × 16px wide, 3 direction rows × 32px tall (24px sprite bottom-aligned with 8px top padding). Row 0 = down, Row 1 = up, Row 2 = right. Frame order: walk1, walk2, walk3, type1, type2, read1, read2. No dedicated idle frames — idle uses walk2 (standing pose). Left = flipped right at runtime. Generated by `scripts/export-characters.ts` which bakes `CHARACTER_PALETTES` colors into templates. Loaded by extension → `characterSpritesLoaded` message (array of 6 character sprite sets). `spriteData.ts` uses pre-colored data directly (no palette swapping); hardcoded template fallback when PNGs not loaded. When `hueShift !== 0`, `hueShiftSprites()` applies `adjustSprite()` (HSL hue rotation) to all frames before caching.

**Load order**: `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` (catalog built synchronously) → `layoutLoaded`.

## Condensed Lessons

- `fs.watch` unreliable on Windows — always pair with polling backup
- Partial line buffering essential for append-only file reads (carry unterminated lines)
- Delay `agentToolDone` 300ms to prevent React batching from hiding brief active states
- **Idle detection** has two signals: (1) `system` + `subtype: "turn_duration"` — reliable for tool-using turns (~98%), emitted once per completed turn, handler clears all tool state as safety measure. (2) Text-idle timer (`TEXT_IDLE_DELAY_MS = 5s`) — for text-only turns where `turn_duration` is never emitted. Only starts when `hadToolsInTurn` is false (no tools used yet in this turn); if any tool_use arrives, `hadToolsInTurn` becomes true and the timer is suppressed for the rest of the turn. Reset on new user prompt or `turn_duration`. Cancelled by ANY new JSONL data arriving in `readNewLines`. Only fires after 5s of complete file silence
- User prompt `content` can be string (text) or array (tool_results) — handle both
- `/clear` creates NEW JSONL file (old file just stops)
- `--output-format stream-json` needs non-TTY stdin — can't use with VS Code terminals
- Hook-based IPC failed (hooks captured at startup, env vars don't propagate). JSONL watching works
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 128
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must call `onEditorSelectionChange()` to trigger React re-render for toolbar

## Build & Dev

```sh
# VS Code extension
npm install && cd webview-ui && npm install && cd .. && npm run build
# Standalone
node esbuild-standalone.js && cd webview-ui && npm run build && cd ..
node dist/standalone.js
```
Extension build: type-check → lint → esbuild (extension) → vite (webview). F5 for Extension Dev Host.
Standalone build: esbuild (server) + assets copy → `dist/standalone.js`; Vite (webview) → `dist/webview/`.

## TypeScript Constraints

- No `enum` (`erasableSyntaxOnly`) — use `as const` objects
- `import type` required for type-only imports (`verbatimModuleSyntax`)
- `noUnusedLocals` / `noUnusedParameters`

## Constants

All magic numbers and strings are centralized — never add inline constants to source files:

- **Extension backend**: `src/constants.ts` — timing intervals, display truncation limits, PNG/asset parsing values, VS Code command/key identifiers
- **Webview**: `webview-ui/src/constants.ts` — grid/layout sizes, character animation speeds, matrix effect params, rendering offsets/colors, camera, zoom, editor defaults, game logic thresholds
- **CSS styling**: `webview-ui/src/index.css` `:root` block — `--pixel-*` custom properties for UI colors, backgrounds, borders, z-indices used in React inline styles
- **Canvas overlay colors** (rgba strings for seats, grids, ghosts, buttons) live in the webview constants file since they're used in canvas 2D context, not CSS
- `webview-ui/src/office/types.ts` re-exports grid/layout constants (`TILE_SIZE`, `DEFAULT_COLS`, etc.) from `constants.ts` for backward compatibility — import from either location

## Key Patterns

- `crypto.randomUUID()` works in VS Code extension host
- Terminal `cwd` option sets working directory at creation
- `/add-dir <path>` grants session access to additional directory

## Windows-MCP (Desktop Automation)

- `uvx --python 3.13 windows-mcp` — Tools: Snapshot, Click, Type, Scroll, Move, Shortcut, App, Shell, Wait, Scrape
- Webview buttons show `(0,0)` in a11y tree — must use `Snapshot(use_vision=true)` for coordinates
- Snap both VS Code windows side-by-side on SAME screen before clicking in Extension Dev Host
- Reload extension via button on main VS Code window after building

## Memory Architecture

Every agent's system prompt (built by `buildSystemPrompt` and friends in `standalone/systemPrompts.ts`, all going through `buildMemoryBlock(agentId, roleShort, sessionCount, lastSessionEnd)`) directs them to **three** MemPalace memory classes:

- **`decisions` wing** — team-wide history; default `mempalace_add_drawer` destination, written sparingly.
- **`skills` wing, room = `<role-slug>`** — procedural recipes shared by every agent in a role (e.g. `skills/visual-designer`, `skills/foreman`).
- **`agents` wing, room = `<agent.id>`** — personal memory scoped to one PersistentAgent. Key is the immutable `persistent_agents.id` UUID so name changes don't orphan memories. Read at session start, write at session end / on workspace-specific learnings.

Hard rule: NO local markdown memory files, NO `/tmp` scratchpad. MemPalace is it.

## Key Decisions

- `WebviewViewProvider` (not `WebviewPanel`) — lives in panel area alongside terminal
- Inline esbuild problem matcher (no extra extension needed)
- Webview is separate Vite project with own `node_modules`/`tsconfig`
- **Agent runtime stays on iTerm spawning** — `claude --session-id <uuid>` in iTerm2 tabs via AppleScript (`itermFocus.launchAgentSession`). A 2026-05-11 experiment with `@anthropic-ai/claude-agent-sdk` (Phase 1 shipped, then ripped out same day) confirmed: per-agent iTerm tabs are load-bearing UX, not infrastructure. Users need to click into a tab, see live output, type follow-up prompts, and use slash commands. Any future "modernize the runtime" proposal must surface the loss of interactive in-tab input in the FIRST phase, not as a Phase-4 afterthought.
