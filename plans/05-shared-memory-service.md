# Plan: Shared Memory Service for Hub/Worker Agents

## Problem

Every agent session starts nearly from scratch. Agents have per-agent `MEMORY.md` files, but these are flat markdown with no search capability. When a worker on machine B picks up a ticket, it receives a copy of the agent's `MEMORY.md` from the hub — but that file only contains whatever the agent manually chose to write down. There's no way to ask "what did we decide about the payment API?" or "has anyone tried upgrading this dependency before?" across the team's collective history.

The hub/worker architecture makes this worse: memories are synced as snapshots over WebSocket (`handleTicket` sends `agentMemories`, `ticketComplete` sends `updatedMemories`). If two workers finish at the same time, the last write wins. And because MEMORY.md is unstructured, agents can't query each other's knowledge — they'd have to read every agent's entire memory file.

## Goals

1. **Shared knowledge base** — all agents (hub and worker) read from and write to the same memory store
2. **Semantic search** — agents can query by meaning, not just keywords
3. **Concurrent-safe** — multiple agents on multiple machines can read/write simultaneously
4. **Structured facts** — track decisions, preferences, and project knowledge with temporal validity
5. **Zero API keys** — everything runs locally, no external services
6. **Works with existing launch flow** — agents get the memory service via MCP config, same as peers

## What We're Building

A **MemPalace instance** running in Docker Compose, exposed as an SSE MCP server so all agents (hub and worker) connect to a single shared memory store over HTTP. MemPalace provides semantic vector search (ChromaDB), a temporal knowledge graph (SQLite), deduplication, and AAAK compression out of the box — no need to reimplement these.

### Why MemPalace in Docker (not a custom Node.js server)

The original plan proposed building a custom Node.js MCP server with `better-sqlite3` and `@xenova/transformers`. MemPalace already solves the same problem with a mature implementation:

- **Semantic vector search** via ChromaDB — embeddings, similarity search, dedup checking built in
- **Temporal knowledge graph** — entity/predicate/entity triples with `valid_from`/`valid_to`
- **19 MCP tools** — search, add, delete, knowledge graph CRUD, navigation, diary, status
- **AAAK compression** — automatic memory consolidation we'd otherwise have to build
- **No Node.js dependencies** — no `better-sqlite3`, no `@xenova/transformers`, no custom code to maintain

MemPalace is designed as a per-session stdio MCP server, but we solve this by wrapping it with an SSE transport layer using the official Python `mcp` SDK. The wrapper imports MemPalace's tool handlers as a library and exposes them via HTTP/SSE — one Python process serving all agents concurrently.

Running it in Docker (alongside the existing `peers-broker`) keeps the Python dependency isolated from the Node.js project. The container handles ChromaDB model downloads, storage persistence, and process lifecycle.

## Architecture

```
Hub machine                              Worker machine
┌──────────────────────┐                 ┌──────────────────────┐
│ pixel-agents server  │                 │ pixel-agents worker  │
│   :3333              │                 │   :3333              │
│                      │                 │                      │
│ Docker Compose       │                 │                      │
│  ├─ peers-broker     │                 │                      │
│  │    :7899          │                 │                      │
│  └─ mempalace        │◄────HTTP/SSE───│                      │
│       :3334          │                 │                      │
│     ├─ ChromaDB      │                 │                      │
│     ├─ knowledge.db  │                 │                      │
│     └─ SSE wrapper   │                 │                      │
│                      │                 │                      │
│ Agent (claude)───MCP SSE──►:3334       │                      │
│                      │                 │ Agent (claude)───────┤
│                      │                 │   └─MCP SSE──────────┼──► Hub :3334
└──────────────────────┘                 └──────────────────────┘
```

### Storage

All state lives inside the Docker container's persistent volume, mapped to `~/.pixel-agents/mempalace/`:

| Directory | Purpose |
|-----------|---------|
| `palace/` | ChromaDB vector store (embeddings + metadata) |
| `palace/knowledge.db` | SQLite temporal knowledge graph (entities, triples) |

ChromaDB uses SQLite internally for metadata and a local vector index. WAL mode enables concurrent reads. The SSE wrapper serializes writes through a single process, avoiding ChromaDB's concurrent-writer limitation.

### Embeddings

Handled entirely by MemPalace/ChromaDB. ChromaDB uses `all-MiniLM-L6-v2` by default (384-dim embeddings, downloaded once into the container volume). No configuration needed — it just works.

## Docker Compose Service

Added alongside the existing `peers-broker`:

```yaml
services:
  peers-broker:
    # ... existing config unchanged ...

  mempalace:
    build:
      context: ./vendor/mempalace-sse
      dockerfile: Dockerfile
    volumes:
      - mempalace-data:/data
    ports:
      - "3334:3334"
    environment:
      - MEMPALACE_PATH=/data/palace
      - MEMPALACE_PORT=3334
    restart: unless-stopped

volumes:
  peers-data:
  mempalace-data:
```

### SSE Wrapper (`vendor/mempalace-sse/`)

A thin Python service that wraps MemPalace's tool handlers with SSE transport:

```
vendor/mempalace-sse/
  Dockerfile          — Python 3.12, pip install mempalace + mcp[server]
  server.py           — SSE MCP server importing MemPalace internals
  requirements.txt    — mempalace, mcp[server]
```

**`Dockerfile`:**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
EXPOSE 3334
CMD ["python", "server.py"]
```

**`server.py`** (conceptual — imports MemPalace's Palace class and registers its tools as MCP handlers over SSE):

```python
from mcp.server import Server
from mcp.server.sse import SseServerTransport
from starlette.applications import Starlette
from starlette.routing import Route
from mempalace.palace import Palace

palace = Palace(path=os.environ.get("MEMPALACE_PATH", "/data/palace"))
app = Server("mempalace")

# Register each MemPalace tool as an MCP tool handler
# e.g., @app.tool() for search, add_drawer, kg_query, etc.
# Each handler delegates to palace.search(), palace.add(), etc.

sse = SseServerTransport("/messages/")
starlette_app = Starlette(routes=[
    Route("/sse", endpoint=sse.handle_sse_connection),
    Route("/messages/", endpoint=sse.handle_post_message, methods=["POST"]),
])

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(starlette_app, host="0.0.0.0", port=int(os.environ.get("MEMPALACE_PORT", "3334")))
```

The wrapper creates a single `Palace` instance shared across all SSE connections. Since Python's GIL serializes writes and ChromaDB's `PersistentClient` is thread-safe for reads, this handles concurrent agent access safely.

## MCP Tools (from MemPalace)

MemPalace exposes **19 tools** organized into categories. Agents access them as `mcp__mempalace__<tool_name>`.

### Palace (Read) — 7 tools

| Tool | Purpose |
|------|---------|
| `mempalace_status` | Palace overview: drawer/wing/room counts |
| `mempalace_list_wings` | All wings with counts |
| `mempalace_list_rooms` | Rooms within a wing |
| `mempalace_get_taxonomy` | Full wing/room/count tree |
| `mempalace_search` | Semantic search with wing/room filters |
| `mempalace_check_duplicate` | Similarity check before filing |
| `mempalace_get_aaak_spec` | AAAK dialect reference |

### Palace (Write) — 2 tools

| Tool | Purpose |
|------|---------|
| `mempalace_add_drawer` | Store content (with auto-dedup) |
| `mempalace_delete_drawer` | Remove by ID |

### Knowledge Graph — 5 tools

| Tool | Purpose |
|------|---------|
| `mempalace_kg_query` | Entity relationships with temporal filtering |
| `mempalace_kg_add` | Add facts |
| `mempalace_kg_invalidate` | Mark facts as ended |
| `mempalace_kg_timeline` | Chronological entity story |
| `mempalace_kg_stats` | Graph overview |

### Navigation — 3 tools

| Tool | Purpose |
|------|---------|
| `mempalace_traverse` | Walk the graph from a room across wings |
| `mempalace_find_tunnels` | Find rooms bridging two wings |
| `mempalace_graph_stats` | Connectivity overview |

### Agent Diary — 2 tools

| Tool | Purpose |
|------|---------|
| `mempalace_diary_write` | Write AAAK diary entry |
| `mempalace_diary_read` | Read recent entries |

### What we DON'T use

- The wing/room/hall taxonomy is available but not mandated in agent prompts — agents can use flat storage if they prefer
- Auto-save hooks — agents are instructed to save explicitly, not auto-captured

## Integration with Hub/Worker

### Phase 1: Docker Compose + SSE Wrapper

**New files:**

| File | Purpose |
|------|---------|
| `vendor/mempalace-sse/Dockerfile` | Python container with mempalace + mcp SDK |
| `vendor/mempalace-sse/server.py` | SSE transport wrapper around MemPalace |
| `vendor/mempalace-sse/requirements.txt` | Python dependencies |

**Modified files:**

| File | Change |
|------|--------|
| `docker-compose.yml` | Add `mempalace` service on `:3334` with persistent volume |
| `standalone/constants.ts` | `MEMPALACE_SERVER_PORT = 3334`, `MEMPALACE_SERVER_URL` |

The mempalace container starts alongside `peers-broker` via `docker compose up`. No changes to `server.ts` — the memory service is fully managed by Docker, not by the Node.js server.

### Phase 2: MCP Config Generation

**Modified files:**

| File | Change |
|------|--------|
| `standalone/agentStore.ts` | New `ensureMempalaceMcpConfig(hubHost: string)` function |
| `standalone/itermFocus.ts` | Pass mempalace MCP config alongside peers MCP config |

MCP config merging: if an agent also needs peers MCP (conference mode), both configs are merged into a single JSON file. The `--mcp-config` flag only accepts one file.

```typescript
// agentStore.ts
export function ensureMempalaceMcpConfig(hubHost: string = 'localhost'): string {
  const configPath = path.join(SETTINGS_DIR, 'mempalace-mcp-config.json');
  const config = {
    mcpServers: {
      mempalace: {
        type: 'sse',
        url: `http://${hubHost}:${MEMPALACE_SERVER_PORT}/sse`,
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return configPath;
}
```

For workers, `hubHost` is the hub's IP (already known from `--hub` flag). For hub agents, it's `localhost`.

### Phase 3: System Prompt Updates

**Modified files:**

| File | Change |
|------|--------|
| `standalone/agentStore.ts` | Add memory service instructions to `buildSystemPrompt()` and `buildDarrylSystemPrompt()` |

Added to every agent's system prompt:

```
## Shared Team Memory (MemPalace)

You have access to a shared memory palace via MCP tools (prefixed `mcp__mempalace__`).

**When starting work:**
- Call `mcp__mempalace__mempalace_search` with your task description to find relevant past decisions and context
- Call `mcp__mempalace__mempalace_kg_query` for entities related to your task

**When you learn something important:**
- Save decisions and discoveries with `mcp__mempalace__mempalace_add_drawer`
- Check for duplicates first with `mcp__mempalace__mempalace_check_duplicate`
- Record facts with `mcp__mempalace__mempalace_kg_add` (e.g., "payment-service uses Stripe API")
- Write session summaries with `mcp__mempalace__mempalace_diary_write`

**What NOT to save:**
- Routine code changes (that's what git is for)
- Temporary debugging notes
- Anything specific to this session only

Your personal MEMORY.md is still for your own working notes. The shared memory palace is for knowledge the whole team benefits from.
```

Added to Darryl's system prompt:

```
## Shared Team Memory (MemPalace)

Before assigning a ticket, search the shared memory to inform your decision:
- `mcp__mempalace__mempalace_search` — find past work related to the ticket
- `mcp__mempalace__mempalace_kg_query` — check what's known about involved services/components
- `mcp__mempalace__mempalace_status` — get an overview of the palace

After making an assignment decision, save it:
- `mcp__mempalace__mempalace_add_drawer` — record the decision and reasoning
- `mcp__mempalace__mempalace_kg_add` — record any new facts learned from the ticket
```

### Phase 4: Worker-Side Config

**Modified files:**

| File | Change |
|------|--------|
| `standalone/workerMode.ts` | On registration, receive hub's mempalace server URL. Use it when generating MCP configs for local agent launches |
| `standalone/workerRegistry.ts` | Include `mempalaceServerUrl` in `workerRegistered` response |

The hub already sends config data on worker registration. We add the mempalace server URL:

```
<- { type: "workerRegistered", agents: [...], clickupConfig: {...}, mempalaceServerUrl: "http://192.168.1.10:3334/sse" }
```

Workers pass this URL when building MCP configs for their local Darryl sessions.

### Phase 5: Memory Migration

**What happens to existing MEMORY.md files:**

Nothing. They stay as-is. Agents continue to have personal MEMORY.md files for session-to-session notes. The shared memory palace is additive — it handles the cross-agent, cross-session, cross-machine knowledge that MEMORY.md was never designed for.

Over time, agents will naturally put team-relevant knowledge in shared memory and keep personal working notes in MEMORY.md. No migration needed.

**What happens to the existing memory sync in `workerRegistry.ts`:**

The `collectAgentMemories()` / `saveUpdatedMemories()` flow stays for now. It syncs MEMORY.md files between hub and workers. Shared memory doesn't replace this because MEMORY.md serves a different purpose (personal agent state vs. team knowledge).

Long-term, as agents rely more on shared memory, the MEMORY.md files will shrink and the sync overhead decreases naturally.

## Implementation Order

| Step | What | Effort | Dependencies |
|------|------|--------|-------------|
| 1 | `vendor/mempalace-sse/` — Dockerfile, requirements.txt, server.py | Medium | None |
| 2 | Update `docker-compose.yml` — add mempalace service + volume | Small | Step 1 |
| 3 | Test: `docker compose up`, verify SSE endpoint responds | Small | Step 2 |
| 4 | `ensureMempalaceMcpConfig()` + inject in `launchAgentSession()` | Small | Step 3 |
| 5 | System prompt updates for all agents + Darryl | Small | Step 4 |
| 6 | Worker registration: send mempalace server URL | Small | Step 4 |
| 7 | Worker mode: use hub mempalace URL in local MCP configs | Small | Step 6 |
| 8 | Add `mcp__mempalace__*` to `PERMISSION_EXEMPT_TOOLS` | Small | Step 4 |
| 9 | Add `'memory'` category to `TOOL_ACTIVITY_CATEGORY` | Small | Step 4 |
| 10 | `MEMPALACE_SERVER_PORT` + `MEMPALACE_SERVER_URL` in constants | Small | None |

Steps 1 and 10 can be done in parallel. Steps 4-9 can be done in parallel (after step 3).

## New Dependencies

| Dependency | Where | Purpose |
|------------|-------|---------|
| Docker (already required) | Host | Container runtime for mempalace service |
| `mempalace` (Python, in container) | Docker | Memory palace with vector search + knowledge graph |
| `mcp[server]` (Python, in container) | Docker | SSE transport for MCP protocol |
| `uvicorn` (Python, in container) | Docker | ASGI server for SSE endpoint |
| `starlette` (Python, in container) | Docker | HTTP routing for SSE endpoint |

**No new npm dependencies.** All Python dependencies are isolated in the Docker container. The Node.js project only needs to generate MCP config JSON pointing at the container's URL.

## What This Enables

**Before:** Agent starts work. Reads its own MEMORY.md. Has no idea what other agents have done, decided, or discovered. Repeats past mistakes. Makes conflicting decisions.

**After:** Agent starts work. Searches shared memory: "What do we know about the payment service?" Gets back: 3 past decisions, 2 known issues, the fact that the Stripe API key is in a specific env var, and that Jim tried upgrading the SDK last week but hit a rate limit bug. Agent proceeds with full team context.

**Before (Darryl):** Darryl sees a ticket about the auth service. Matches agent by role text. Doesn't know that Pam already fixed a similar auth bug last week and documented the root cause.

**After (Darryl):** Darryl searches shared memory for "auth service." Finds Pam's discovery about the root cause. Assigns the ticket to Pam with context: "You handled a related auth issue on CU-xyz — this may be connected."

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agents spam shared memory with noise | Search quality degrades | Strict system prompt guidance on what to save. MemPalace's built-in dedup check helps. AAAK compression consolidates over time. |
| Docker not available on a machine | No shared memory | Agents still have personal MEMORY.md. Shared memory is additive, not required. |
| ChromaDB model download fails (no internet on first run) | No embeddings | Pre-bake the model into the Docker image, or download on build. Container always has what it needs. |
| Memory server is single point of failure | All agents lose shared memory | Agents still have personal MEMORY.md. Memory service failure = degraded, not broken. Persistent volume survives container restarts. |
| Network latency to hub | Slow MCP tool calls for workers | SSE is persistent connection. Searches should be <100ms even over LAN. |
| Memory grows unbounded | Disk usage, search slows | `mempalace_status` for monitoring. AAAK compression reduces volume. Future: archival of old memories. |
| Concurrent writes via SSE wrapper | Data corruption | Single Python process with GIL serializes writes. ChromaDB PersistentClient is thread-safe for reads. SSE wrapper handles concurrency correctly. |

## Not In Scope

- **Auto-ingestion of JSONL transcripts** — too noisy, agents should explicitly save what matters
- **Memory UI in the webview** — useful but separate feature, can be added later
- **Memory permissions** — all agents can read/write everything, no access control
- **Replication** — single hub is the source of truth, no multi-hub sync
- **Multiple palace instances** — one shared palace for all agents, not per-project
