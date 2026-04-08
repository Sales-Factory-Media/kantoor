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

A **Node.js MCP server** (`memory-server`) that runs on the hub and exposes shared team memory via MCP tools. Workers connect to it over HTTP (not stdin/stdout like typical MCP servers). Every agent launched by the hub or any worker gets this MCP server in their config.

### Why not fork MemPalace

MemPalace is designed as a per-session MCP server (one `python -m mempalace.mcp_server` per Claude process, communicating over stdin/stdout). Our use case is fundamentally different:

- Multiple concurrent agents across multiple machines need the same memory store
- We need a centralized service, not per-session processes
- ChromaDB's embedded mode doesn't support concurrent writers
- The wing/room/hall taxonomy adds metaphor overhead we don't need
- Python dependency in a Node.js project

We do borrow three good ideas from MemPalace:
- **Semantic vector search** (ChromaDB concept, but we'll use a Node.js-native solution)
- **Temporal knowledge graph** (entity → predicate → entity, with valid_from/valid_to)
- **Layered recall** (always-loaded identity vs. on-demand deep search)

## Architecture

```
Hub machine                              Worker machine
┌──────────────────────┐                 ┌──────────────────────┐
│ pixel-agents server  │                 │ pixel-agents worker  │
│   :3333              │                 │   :3333              │
│                      │                 │                      │
│ memory-server :3334  │◄────HTTP────────│                      │
│   ├─ vector store    │                 │                      │
│   ├─ knowledge graph │                 │                      │
│   └─ SQLite DB       │                 │                      │
│                      │                 │                      │
│ Agent (claude)───────┼─MCP over HTTP──►│                      │
│                      │                 │ Agent (claude)───────┤
│                      │                 │   └─MCP over HTTP────┼──► Hub :3334
└──────────────────────┘                 └──────────────────────┘
```

### Storage

All state lives on the hub in `~/.pixel-agents/memory/`:

| File | Purpose |
|------|---------|
| `vectors.db` | SQLite with `sqlite-vss` extension for vector search |
| `knowledge.db` | SQLite for temporal knowledge graph (entities, triples) |

Using SQLite for both stores (instead of ChromaDB) because:
- Node.js native via `better-sqlite3` — no separate process
- `sqlite-vss` provides vector similarity search (cosine/L2)
- Single file, concurrent reads, WAL mode for concurrent writes
- Already battle-tested in the Node.js ecosystem
- No new runtime dependencies (no Python, no Java)

### Embeddings

For vector search to work without API calls, we need local embeddings. Options:

| Option | Size | Speed | Quality | Dependency |
|--------|------|-------|---------|------------|
| `@xenova/transformers` (ONNX) | ~100MB model | ~50ms/embed | Good (MiniLM-L6) | npm package |
| `fastembed` | ~100MB model | ~30ms/embed | Good | npm + ONNX runtime |
| TF-IDF (no model) | 0 | <1ms | Decent for keywords | None |

**Recommendation: `@xenova/transformers`** with `all-MiniLM-L6-v2`. It's a single npm install, runs on CPU, downloads the model once (~23MB quantized), and produces 384-dim embeddings good enough for our use case. Falls back to TF-IDF keyword matching if the model fails to load.

## MCP Server Design

### Transport: SSE (Server-Sent Events)

Standard MCP supports two transports: stdio and SSE. Since our memory server is a shared HTTP service (not a per-session process), we use SSE transport. This is already supported by Claude Code's `--mcp-config`:

```json
{
  "mcpServers": {
    "memory": {
      "type": "sse",
      "url": "http://<hub-ip>:3334/mcp"
    }
  }
}
```

Workers use the hub's IP. Hub agents use `localhost`. The `ensureMemoryMcpConfig()` function generates this config file, similar to how `ensureMcpConfig()` works for peers.

### MCP Tools

**10 tools total** — intentionally limited to keep agent prompts lean.

#### Search & Recall

| Tool | Parameters | Returns |
|------|-----------|---------|
| `memory_search` | `query: string`, `project?: string`, `limit?: number` | Top-N semantically similar memories with metadata |
| `memory_recall` | `topic: string` | Structured summary: related facts, decisions, and history for a topic |

#### Write

| Tool | Parameters | Returns |
|------|-----------|---------|
| `memory_save` | `content: string`, `type: 'decision' \| 'discovery' \| 'preference' \| 'context'`, `project?: string`, `tags?: string[]` | Saved memory ID |
| `memory_update` | `id: string`, `content: string` | Updated memory |
| `memory_forget` | `id: string` | Confirmation |

#### Knowledge Graph

| Tool | Parameters | Returns |
|------|-----------|---------|
| `memory_fact_add` | `subject: string`, `predicate: string`, `object: string`, `project?: string` | Fact ID |
| `memory_fact_query` | `entity: string`, `as_of?: string` | All current facts about an entity |
| `memory_fact_invalidate` | `id: string`, `reason?: string` | Confirmation |

#### Status

| Tool | Parameters | Returns |
|------|-----------|---------|
| `memory_status` | — | Stats: total memories, facts, projects, last updated |
| `memory_project_summary` | `project: string` | Key decisions, active facts, recent memories for a project |

### What the tools do NOT include

- No wings/rooms/halls taxonomy — memories are flat with `type` and `project` tags
- No compression/AAAK — adds complexity, and our memories are already concise
- No diary system — agents have MEMORY.md for personal notes, shared memory is for team knowledge
- No save hooks — agents are instructed to save explicitly, not auto-captured

## Data Model

### Memories Table (vector store)

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'decision', 'discovery', 'preference', 'context'
  project TEXT,                -- project name or null for global
  tags TEXT,                   -- JSON array of tags
  agent_name TEXT,             -- who saved this
  agent_id TEXT,               -- persistent agent UUID
  created_at TEXT NOT NULL,    -- ISO 8601
  updated_at TEXT,
  embedding BLOB               -- 384-dim float32 vector
);
```

### Entities Table (knowledge graph)

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT,                   -- 'project', 'service', 'person', 'tool', 'concept'
  properties TEXT              -- JSON object
);
```

### Facts Table (knowledge graph)

```sql
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES entities(id),
  predicate TEXT NOT NULL,     -- 'uses', 'depends_on', 'decided', 'prefers', 'avoids'
  object_id TEXT NOT NULL REFERENCES entities(id),
  project TEXT,
  agent_name TEXT,             -- who recorded this
  valid_from TEXT NOT NULL,    -- ISO 8601
  valid_to TEXT,               -- null = still valid
  invalidation_reason TEXT
);
```

## Integration with Hub/Worker

### Phase 1: Memory Server Module

**New files:**

| File | Purpose |
|------|---------|
| `standalone/memory/memoryServer.ts` | HTTP + SSE MCP server, starts on `:3334` |
| `standalone/memory/vectorStore.ts` | SQLite + sqlite-vss wrapper, embedding + search |
| `standalone/memory/knowledgeGraph.ts` | Entity/fact CRUD, temporal queries |
| `standalone/memory/embeddings.ts` | `@xenova/transformers` wrapper, model loading |
| `standalone/memory/tools.ts` | MCP tool definitions and handlers |

**Modified files:**

| File | Change |
|------|--------|
| `standalone/server.ts` | Start memory server alongside main server (hub mode only) |
| `standalone/constants.ts` | `MEMORY_SERVER_PORT = 3334` |

The memory server starts automatically when the hub starts. Workers don't run their own memory server — they connect to the hub's.

### Phase 2: MCP Config Generation

**Modified files:**

| File | Change |
|------|--------|
| `standalone/agentStore.ts` | New `ensureMemoryMcpConfig(hubHost: string)` function |
| `standalone/itermFocus.ts` | Pass memory MCP config alongside peers MCP config |

MCP config merging: if an agent also needs peers MCP (conference mode), both configs are merged into a single JSON file. The `--mcp-config` flag only accepts one file.

```typescript
// agentStore.ts
export function ensureMemoryMcpConfig(hubHost: string = 'localhost'): string {
  const configPath = path.join(SETTINGS_DIR, 'memory-mcp-config.json');
  const config = {
    mcpServers: {
      memory: {
        type: 'sse',
        url: `http://${hubHost}:${MEMORY_SERVER_PORT}/mcp`,
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
## Shared Team Memory

You have access to a shared memory service via MCP tools (prefixed `mcp__memory__`).

**When starting work:**
- Call `mcp__memory__memory_search` with your task description to find relevant past decisions and context
- Call `mcp__memory__memory_fact_query` for entities related to your task

**When you learn something important:**
- Save decisions with `mcp__memory__memory_save` (type: 'decision')
- Save discoveries with `mcp__memory__memory_save` (type: 'discovery')
- Record facts with `mcp__memory__memory_fact_add` (e.g., "payment-service uses Stripe API")

**What NOT to save:**
- Routine code changes (that's what git is for)
- Temporary debugging notes
- Anything specific to this session only

Your personal MEMORY.md is still for your own working notes. The shared memory is for knowledge the whole team benefits from.
```

Added to Darryl's system prompt:

```
## Shared Team Memory

Before assigning a ticket, search the shared memory to inform your decision:
- `mcp__memory__memory_search` — find past work related to the ticket
- `mcp__memory__memory_fact_query` — check what's known about involved services/components
- `mcp__memory__memory_project_summary` — get an overview of a project's current state

After making an assignment decision, save it:
- `mcp__memory__memory_save` with type 'decision' — record why you chose this agent
- `mcp__memory__memory_fact_add` — record any new facts learned from the ticket
```

### Phase 4: Worker-Side Config

**Modified files:**

| File | Change |
|------|--------|
| `standalone/workerMode.ts` | On registration, receive hub's memory server URL. Use it when generating MCP configs for local agent launches |
| `standalone/workerRegistry.ts` | Include `memoryServerUrl` in `workerRegistered` response |

The hub already sends config data on worker registration. We add the memory server URL:

```
<- { type: "workerRegistered", agents: [...], clickupConfig: {...}, memoryServerUrl: "http://192.168.1.10:3334/mcp" }
```

Workers pass this URL when building MCP configs for their local Darryl sessions.

### Phase 5: Memory Migration

**What happens to existing MEMORY.md files:**

Nothing. They stay as-is. Agents continue to have personal MEMORY.md files for session-to-session notes. The shared memory service is additive — it handles the cross-agent, cross-session, cross-machine knowledge that MEMORY.md was never designed for.

Over time, agents will naturally put team-relevant knowledge in shared memory and keep personal working notes in MEMORY.md. No migration needed.

**What happens to the existing memory sync in `workerRegistry.ts`:**

The `collectAgentMemories()` / `saveUpdatedMemories()` flow stays for now. It syncs MEMORY.md files between hub and workers. Shared memory doesn't replace this because MEMORY.md serves a different purpose (personal agent state vs. team knowledge).

Long-term, as agents rely more on shared memory, the MEMORY.md files will shrink and the sync overhead decreases naturally.

## Implementation Order

| Step | What | Effort | Dependencies |
|------|------|--------|-------------|
| 1 | `embeddings.ts` — model loading, embed function, fallback | Small | npm: `@xenova/transformers` |
| 2 | `vectorStore.ts` — SQLite + vector search, CRUD | Medium | npm: `better-sqlite3`, `sqlite-vss` |
| 3 | `knowledgeGraph.ts` — entities, facts, temporal queries | Medium | npm: `better-sqlite3` (shared) |
| 4 | `tools.ts` — MCP tool definitions, parameter validation | Medium | Steps 2-3 |
| 5 | `memoryServer.ts` — HTTP/SSE server, MCP protocol | Medium | Step 4 |
| 6 | Start memory server from `server.ts` (hub only) | Small | Step 5 |
| 7 | `ensureMemoryMcpConfig()` + inject in `launchAgentSession()` | Small | Step 6 |
| 8 | System prompt updates for all agents + Darryl | Small | Step 7 |
| 9 | Worker registration: send memory server URL | Small | Step 7 |
| 10 | Worker mode: use hub memory URL in local MCP configs | Small | Step 9 |
| 11 | Add `mcp__memory__*` to `PERMISSION_EXEMPT_TOOLS` | Small | Step 7 |
| 12 | Add `'memory'` category to `TOOL_ACTIVITY_CATEGORY` | Small | Step 7 |

Steps 1-3 can be done in parallel. Steps 7-12 can be done in parallel.

## New Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `better-sqlite3` | SQLite driver (WAL mode, concurrent reads) | ~2MB |
| `@xenova/transformers` | Local embeddings (ONNX runtime) | ~8MB + ~23MB model (downloaded once) |

`sqlite-vss` is complex to install cross-platform. **Alternative**: skip the C extension and do vector search in JS — load all vectors into memory, compute cosine similarity in a loop. With <100k memories this is plenty fast (<10ms). This keeps dependencies to just `better-sqlite3` and `@xenova/transformers`.

## What This Enables

**Before:** Agent starts work. Reads its own MEMORY.md. Has no idea what other agents have done, decided, or discovered. Repeats past mistakes. Makes conflicting decisions.

**After:** Agent starts work. Searches shared memory: "What do we know about the payment service?" Gets back: 3 past decisions, 2 known issues, the fact that the Stripe API key is in a specific env var, and that Jim tried upgrading the SDK last week but hit a rate limit bug. Agent proceeds with full team context.

**Before (Darryl):** Darryl sees a ticket about the auth service. Matches agent by role text. Doesn't know that Pam already fixed a similar auth bug last week and documented the root cause.

**After (Darryl):** Darryl searches shared memory for "auth service." Finds Pam's discovery about the root cause. Assigns the ticket to Pam with context: "You handled a related auth issue on CU-xyz — this may be connected."

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agents spam shared memory with noise | Search quality degrades | Strict system prompt guidance on what to save. Type field forces categorization. Can add dedup check later. |
| sqlite-vss install fails on some machines | No vector search | Skip sqlite-vss entirely — do cosine similarity in JS. Simpler, works everywhere. |
| Model download fails (no internet) | No embeddings | Fall back to TF-IDF keyword matching. Degrade gracefully. |
| Memory server is single point of failure | All agents lose shared memory | Agents still have personal MEMORY.md. Memory server failure = degraded, not broken. |
| Network latency to hub | Slow MCP tool calls for workers | SSE is persistent connection. Searches should be <100ms even over LAN. |
| Memory grows unbounded | Disk usage, search slows | Add `memory_status` reporting. Future: auto-archival of old memories with low access count. |

## Not In Scope

- **Auto-ingestion of JSONL transcripts** — too noisy, agents should explicitly save what matters
- **Memory UI in the webview** — useful but separate feature, can be added later
- **Memory permissions** — all agents can read/write everything, no access control
- **Replication** — single hub is the source of truth, no multi-hub sync
- **AAAK compression** — premature optimization, memories are already short
- **Import from MemPalace** — if someone has an existing palace, migration could be added later but isn't a launch requirement
