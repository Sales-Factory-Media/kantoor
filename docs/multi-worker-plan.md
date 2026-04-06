# Multi-Worker Ticket Processing

## Problem

Darryl currently processes one ticket at a time. This is because the Claude agents run against the local codebase on a single machine. With multiple laptops on the same network, each running this codebase, Darryl should be able to distribute tickets across all available machines — processing as many tickets in parallel as there are connected laptops.

## Architecture

### Roles

**Hub** — one machine acts as the hub. It:
- Polls ClickUp for TODO tickets assigned to Darryl
- Programmatically distributes tickets across available machines (itself + workers)
- Tracks assignments in `~/.pixel-agents/worker-assignments.json`
- Comments on tickets via ClickUp API stating which worker was assigned
- Sends `agents.json` + agent memory files to workers
- Receives completion/failure reports from workers
- Is also worker #1 — works on tickets itself alongside remote workers

**Worker** — additional laptops that connect to the hub. Each worker:
- Connects to the hub's WebSocket on startup (`--hub=<ip:port>`)
- Receives `agents.json` from hub, merges onto local copy (hub wins on conflicts, local-only agents kept)
- Receives `handleTicket` messages and runs its own Darryl session locally (same assessment + agent launch flow as the hub)
- Does NOT poll ClickUp
- Reports ticket completion/failure back to hub
- Sends updated agent memory back to hub on completion

### Why WebSocket (not MQTT, Redis, or a database)

The codebase already has a WebSocket server (`ws://localhost:3333/ws`) with broadcast infrastructure and type-based message dispatch. Workers connect to the hub as a new type of WebSocket client alongside the existing webview clients. No new dependencies, no external services to run.

State remains file-based on the hub (`~/.pixel-agents/`). Workers receive what they need over WebSocket and report back results. No shared database needed.

## Starting Hub and Workers

### Hub (default mode, no change from today)

```sh
npm run build:standalone && npm run standalone
```

Optionally with a name and color for identification:

```sh
npm run standalone -- --name="Red" --color="#F44336"
```

### Worker

```sh
npm run build:standalone && npm run standalone -- --hub=192.168.1.10:3333 --name="Blue" --color="#2196F3"
```

The worker starts the same HTTP + WebSocket server on :3333 (so its local Darryl sessions can use `/api/launch-agent`), but additionally connects to the hub's WebSocket as a client. It skips ClickUp polling.

### Worker Identity Persistence

On first run with `--name` and `--color`, the identity is saved to `~/.pixel-agents/worker-identity.json`:

```json
{ "name": "Blue", "color": "#2196F3" }
```

Subsequent starts read from this file. CLI flags override the file if provided.

Environment variable alternative: `HUB=192.168.1.10:3333 npm run standalone`.

## WebSocket Protocol (Worker <-> Hub)

### Registration

```
Worker connects to ws://hub:3333/ws

-> { type: "workerRegister", hostname, name, color }
<- { type: "workerRegistered", agents: [...], clickupConfig: {...} }
```

### Ticket Assignment

```
<- { type: "handleTicket", ticketId, ticketName, ticketUrl, agentMemories: { [agentId]: "memory content..." } }
-> { type: "ticketStarted", ticketId }
-> { type: "ticketComplete", ticketId, updatedMemories: { [agentId]: "updated content..." } }
-> { type: "ticketFailed", ticketId, error }
```

### Heartbeat

```
-> { type: "workerHeartbeat" }    (every 30s)
    (hub drops worker if no heartbeat for 90s)
```

### Status Updates (Hub -> Webview)

```
<- { type: "workerStatus", workers: [{ name, color, hostname, status, ticketId? }] }
```

## Ticket Distribution Flow

1. Hub polls ClickUp, finds N TODO tickets assigned to Darryl
2. Hub counts available capacity: itself (if idle) + connected workers (if idle)
3. Hub assigns tickets programmatically (round-robin, up to available capacity)
4. For each assignment:
   - **Local ticket**: calls `handleDarrylHandleTicket()` as today
   - **Remote ticket**: sends `handleTicket` WebSocket message to that worker
5. Hub comments on the ticket via ClickUp API: "Assigned to worker **Blue**" (matching physical label)
6. Hub records assignment in `~/.pixel-agents/worker-assignments.json`
7. When worker completes: sends `ticketComplete` + updated agent memories back to hub
8. Hub saves updated memories, updates assignment status, checks for next batch

## Agent Merge Logic (on Worker)

When a worker receives `agents.json` from the hub:

```
for each agent in hubAgents:
  if localAgent exists with same id -> replace with hub version
  else -> add hub version
keep any local agents not in hubAgents
save merged result
```

Hub takes precedence on conflicts. Local-only agents are retained.

## State Tracking

### `~/.pixel-agents/worker-assignments.json` (on hub)

```json
{
  "assignments": [
    {
      "ticketId": "abc123",
      "ticketName": "Fix login bug",
      "worker": "Red",
      "workerHost": "localhost",
      "startedAt": "2026-04-06T10:00:00Z",
      "status": "in_progress"
    },
    {
      "ticketId": "def456",
      "ticketName": "Add dark mode",
      "worker": "Blue",
      "workerHost": "192.168.1.12:3333",
      "startedAt": "2026-04-06T10:00:05Z",
      "status": "in_progress"
    }
  ]
}
```

### `~/.pixel-agents/worker-identity.json` (on each machine)

```json
{
  "name": "Blue",
  "color": "#2196F3"
}
```

## UI Changes (ForemanPanel)

A new **Workers** section in the ForemanPanel showing connected workers:

```
+------------------------------------+
| Workers                            |
| * Red (hub)          idle          |
| * Blue               CU-abc123    |
| o Green              disconnected |
+------------------------------------+
```

- Colored dot (CSS `background-color` circle) matching the worker's color
- Worker name matching the physical label on the laptop
- Status: idle, ticket ID (clickable to jump to ticket), or disconnected (grey)
- Hub broadcasts `workerStatus` messages to webview clients whenever worker state changes

## Files Changed / Added

### Modified

| File | Change |
|------|--------|
| `standalone/server.ts` | Differentiate webview vs worker WebSocket clients. Parse `--hub`, `--name`, `--color` CLI args. Start in hub or worker mode. |
| `standalone/clickupHandlers.ts` | `autoDarrylPickup()` distributes across all available machines instead of picking up 1 ticket. Add ClickUp comment with worker name on assignment. |
| `standalone/constants.ts` | New constants: heartbeat interval, heartbeat timeout, worker assignment file path. |
| `webview-ui/src/components/ForemanPanel.tsx` | Add Workers section showing connected workers with color dots and status. |
| `webview-ui/src/hooks/useExtensionMessages.ts` | Handle new `workerStatus` message type. |

### New

| File | Purpose |
|------|---------|
| `standalone/workerRegistry.ts` | Hub-side: track connected workers, capacity, assignments. Read/write `worker-assignments.json`. Broadcast `workerStatus` to webview. |
| `standalone/workerMode.ts` | Worker-side: connect to hub WebSocket, receive work, merge agents, run local Darryl sessions, report completion/failure, send heartbeats. |

## Prerequisites for Worker Machines

- Node.js installed
- Claude CLI installed
- iTerm2 (for `launchAgentSession`)
- Target repos checked out at the same workspace paths
- Network connectivity to hub on port 3333

## Future Enhancements (not in scope)

- **mDNS/Bonjour auto-discovery**: Workers find the hub automatically via `_pixelagents._tcp` broadcast instead of requiring `--hub=<ip>`. macOS has Bonjour built in; `bonjour-service` npm package for the implementation.
- **Capacity > 1 per machine**: Allow a single machine to work on multiple tickets simultaneously.
- **Worker health dashboard**: Detailed view of worker system resources, session logs, etc.
