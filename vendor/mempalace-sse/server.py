"""
MemPalace SSE Server

Wraps the mempalace package's tool functions as an MCP server over SSE transport.
Uses the official MCP Python SDK with Starlette + uvicorn for HTTP.
"""

import json
import logging
import os
import sys

import uvicorn
from mcp import types
from mcp.server import Server
from mcp.server.sse import SseServerTransport
from starlette.applications import Starlette
from starlette.responses import Response
from starlette.routing import Mount, Route

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("mempalace-sse")

# ---------------------------------------------------------------------------
# Palace path — set via env var, default /data/palace (Docker volume mount)
# ---------------------------------------------------------------------------
PALACE_PATH = os.environ.get("MEMPALACE_PATH", "/data/palace")
PORT = int(os.environ.get("MEMPALACE_PORT", "3334"))

# ---------------------------------------------------------------------------
# Set the env var that mempalace's config module reads for palace path
# ---------------------------------------------------------------------------
os.environ["MEMPALACE_PALACE_PATH"] = PALACE_PATH

# ---------------------------------------------------------------------------
# Import mempalace internals — these are the tool functions from mcp_server.py
# ---------------------------------------------------------------------------
from mempalace.mcp_server import (  # noqa: E402
    tool_add_drawer,
    tool_check_duplicate,
    tool_delete_drawer,
    tool_diary_read,
    tool_diary_write,
    tool_find_tunnels,
    tool_graph_stats,
    tool_kg_add,
    tool_kg_invalidate,
    tool_kg_query,
    tool_kg_stats,
    tool_kg_timeline,
    tool_list_rooms,
    tool_list_wings,
    tool_get_aaak_spec,
    tool_get_taxonomy,
    tool_search,
    tool_status,
    tool_traverse_graph,
)

# ---------------------------------------------------------------------------
# Tool definitions — 19 tools matching mempalace's TOOLS registry
# ---------------------------------------------------------------------------
TOOL_DEFINITIONS: list[types.Tool] = [
    types.Tool(
        name="mempalace_status",
        description="Palace overview — total drawers, wing and room counts",
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    types.Tool(
        name="mempalace_list_wings",
        description="List all wings with drawer counts",
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    types.Tool(
        name="mempalace_list_rooms",
        description="List rooms within a wing (or all rooms if no wing given)",
        inputSchema={
            "type": "object",
            "properties": {
                "wing": {
                    "type": "string",
                    "description": "Wing to list rooms for (optional)",
                },
            },
        },
    ),
    types.Tool(
        name="mempalace_get_taxonomy",
        description="Full taxonomy: wing -> room -> drawer count",
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    types.Tool(
        name="mempalace_get_aaak_spec",
        description=(
            "Get the AAAK dialect specification — the compressed memory format"
            " MemPalace uses"
        ),
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    types.Tool(
        name="mempalace_search",
        description="Semantic search. Returns verbatim drawer content with similarity scores.",
        inputSchema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to search for",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (default 5)",
                },
                "wing": {
                    "type": "string",
                    "description": "Filter by wing (optional)",
                },
                "room": {
                    "type": "string",
                    "description": "Filter by room (optional)",
                },
            },
            "required": ["query"],
        },
    ),
    types.Tool(
        name="mempalace_check_duplicate",
        description="Check if content already exists in the palace before filing",
        inputSchema={
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "Content to check",
                },
                "threshold": {
                    "type": "number",
                    "description": "Similarity threshold 0-1 (default 0.9)",
                },
            },
            "required": ["content"],
        },
    ),
    types.Tool(
        name="mempalace_add_drawer",
        description="File verbatim content into the palace. Checks for duplicates first.",
        inputSchema={
            "type": "object",
            "properties": {
                "wing": {
                    "type": "string",
                    "description": "Wing (project name)",
                },
                "room": {
                    "type": "string",
                    "description": "Room (aspect: backend, decisions, meetings...)",
                },
                "content": {
                    "type": "string",
                    "description": (
                        "Verbatim content to store — exact words, never summarized"
                    ),
                },
                "source_file": {
                    "type": "string",
                    "description": "Where this came from (optional)",
                },
                "added_by": {
                    "type": "string",
                    "description": "Who is filing this (default: mcp)",
                },
            },
            "required": ["wing", "room", "content"],
        },
    ),
    types.Tool(
        name="mempalace_delete_drawer",
        description="Delete a drawer by ID",
        inputSchema={
            "type": "object",
            "properties": {
                "drawer_id": {
                    "type": "string",
                    "description": "ID of the drawer to delete",
                },
            },
            "required": ["drawer_id"],
        },
    ),
    types.Tool(
        name="mempalace_kg_query",
        description=(
            "Query the knowledge graph for an entity's relationships."
            " Returns typed facts."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "entity": {
                    "type": "string",
                    "description": (
                        "Entity to query (e.g. 'Max', 'MyProject', 'Alice')"
                    ),
                },
                "as_of": {
                    "type": "string",
                    "description": (
                        "Date filter — only facts valid at this date"
                        " (YYYY-MM-DD, optional)"
                    ),
                },
                "direction": {
                    "type": "string",
                    "description": (
                        "outgoing (entity->?), incoming (?->entity),"
                        " or both (default: both)"
                    ),
                },
            },
            "required": ["entity"],
        },
    ),
    types.Tool(
        name="mempalace_kg_add",
        description=(
            "Add a fact to the knowledge graph."
            " Subject -> predicate -> object with optional time window."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "subject": {
                    "type": "string",
                    "description": "The entity doing/being something",
                },
                "predicate": {
                    "type": "string",
                    "description": (
                        "The relationship type"
                        " (e.g. 'loves', 'works_on', 'daughter_of')"
                    ),
                },
                "object": {
                    "type": "string",
                    "description": "The entity being connected to",
                },
                "valid_from": {
                    "type": "string",
                    "description": (
                        "When this became true (YYYY-MM-DD, optional)"
                    ),
                },
                "source_closet": {
                    "type": "string",
                    "description": (
                        "Closet ID where this fact appears (optional)"
                    ),
                },
            },
            "required": ["subject", "predicate", "object"],
        },
    ),
    types.Tool(
        name="mempalace_kg_invalidate",
        description="Mark a fact as no longer true",
        inputSchema={
            "type": "object",
            "properties": {
                "subject": {
                    "type": "string",
                    "description": "Entity",
                },
                "predicate": {
                    "type": "string",
                    "description": "Relationship",
                },
                "object": {
                    "type": "string",
                    "description": "Connected entity",
                },
                "ended": {
                    "type": "string",
                    "description": (
                        "When it stopped being true (YYYY-MM-DD, default: today)"
                    ),
                },
            },
            "required": ["subject", "predicate", "object"],
        },
    ),
    types.Tool(
        name="mempalace_kg_timeline",
        description=(
            "Chronological timeline of facts."
            " Shows the story of an entity."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "entity": {
                    "type": "string",
                    "description": (
                        "Entity to get timeline for"
                        " (optional — omit for full timeline)"
                    ),
                },
            },
        },
    ),
    types.Tool(
        name="mempalace_kg_stats",
        description=(
            "Knowledge graph overview: entities, triples,"
            " current vs expired facts"
        ),
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    types.Tool(
        name="mempalace_traverse",
        description=(
            "Walk the palace graph from a room."
            " Shows connected ideas across wings."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "start_room": {
                    "type": "string",
                    "description": (
                        "Room to start from"
                        " (e.g. 'chromadb-setup', 'riley-school')"
                    ),
                },
                "max_hops": {
                    "type": "integer",
                    "description": (
                        "How many connections to follow (default: 2)"
                    ),
                },
            },
            "required": ["start_room"],
        },
    ),
    types.Tool(
        name="mempalace_find_tunnels",
        description=(
            "Find rooms that bridge two wings —"
            " the hallways connecting different domains"
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "wing_a": {
                    "type": "string",
                    "description": "First wing (optional)",
                },
                "wing_b": {
                    "type": "string",
                    "description": "Second wing (optional)",
                },
            },
        },
    ),
    types.Tool(
        name="mempalace_graph_stats",
        description=(
            "Palace graph overview: total rooms, tunnel connections,"
            " edges between wings."
        ),
        inputSchema={
            "type": "object",
            "properties": {},
        },
    ),
    types.Tool(
        name="mempalace_diary_write",
        description="Write to your personal agent diary in AAAK format",
        inputSchema={
            "type": "object",
            "properties": {
                "agent_name": {
                    "type": "string",
                    "description": (
                        "Your name — each agent gets their own diary wing"
                    ),
                },
                "entry": {
                    "type": "string",
                    "description": (
                        "Your diary entry in AAAK format —"
                        " compressed, entity-coded, emotion-marked"
                    ),
                },
                "topic": {
                    "type": "string",
                    "description": "Topic tag (optional, default: general)",
                },
            },
            "required": ["agent_name", "entry"],
        },
    ),
    types.Tool(
        name="mempalace_diary_read",
        description="Read your recent diary entries (in AAAK)",
        inputSchema={
            "type": "object",
            "properties": {
                "agent_name": {
                    "type": "string",
                    "description": (
                        "Your name — each agent gets their own diary wing"
                    ),
                },
                "last_n": {
                    "type": "integer",
                    "description": (
                        "Number of recent entries to read (default: 10)"
                    ),
                },
            },
            "required": ["agent_name"],
        },
    ),
]

# ---------------------------------------------------------------------------
# Tool dispatch — maps tool name to the mempalace function + arg extraction
# ---------------------------------------------------------------------------
TOOL_HANDLERS = {
    "mempalace_status": lambda args: tool_status(),
    "mempalace_list_wings": lambda args: tool_list_wings(),
    "mempalace_list_rooms": lambda args: tool_list_rooms(
        wing=args.get("wing"),
    ),
    "mempalace_get_taxonomy": lambda args: tool_get_taxonomy(),
    "mempalace_get_aaak_spec": lambda args: tool_get_aaak_spec(),
    "mempalace_search": lambda args: tool_search(
        query=args["query"],
        limit=args.get("limit", 5),
        wing=args.get("wing"),
        room=args.get("room"),
    ),
    "mempalace_check_duplicate": lambda args: tool_check_duplicate(
        content=args["content"],
        threshold=args.get("threshold", 0.9),
    ),
    "mempalace_add_drawer": lambda args: tool_add_drawer(
        wing=args["wing"],
        room=args["room"],
        content=args["content"],
        source_file=args.get("source_file"),
        added_by=args.get("added_by", "mcp"),
    ),
    "mempalace_delete_drawer": lambda args: tool_delete_drawer(
        drawer_id=args["drawer_id"],
    ),
    "mempalace_kg_query": lambda args: tool_kg_query(
        entity=args["entity"],
        as_of=args.get("as_of"),
        direction=args.get("direction", "both"),
    ),
    "mempalace_kg_add": lambda args: tool_kg_add(
        subject=args["subject"],
        predicate=args["predicate"],
        object=args["object"],
        valid_from=args.get("valid_from"),
        source_closet=args.get("source_closet"),
    ),
    "mempalace_kg_invalidate": lambda args: tool_kg_invalidate(
        subject=args["subject"],
        predicate=args["predicate"],
        object=args["object"],
        ended=args.get("ended"),
    ),
    "mempalace_kg_timeline": lambda args: tool_kg_timeline(
        entity=args.get("entity"),
    ),
    "mempalace_kg_stats": lambda args: tool_kg_stats(),
    "mempalace_traverse": lambda args: tool_traverse_graph(
        start_room=args["start_room"],
        max_hops=args.get("max_hops", 2),
    ),
    "mempalace_find_tunnels": lambda args: tool_find_tunnels(
        wing_a=args.get("wing_a"),
        wing_b=args.get("wing_b"),
    ),
    "mempalace_graph_stats": lambda args: tool_graph_stats(),
    "mempalace_diary_write": lambda args: tool_diary_write(
        agent_name=args["agent_name"],
        entry=args["entry"],
        topic=args.get("topic", "general"),
    ),
    "mempalace_diary_read": lambda args: tool_diary_read(
        agent_name=args["agent_name"],
        last_n=args.get("last_n", 10),
    ),
}

# ---------------------------------------------------------------------------
# MCP Server with decorator-based handlers
# ---------------------------------------------------------------------------
mcp_server = Server("mempalace")


@mcp_server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    """Return all 19 mempalace tools."""
    return TOOL_DEFINITIONS


@mcp_server.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
    """Dispatch a tool call to the corresponding mempalace function."""
    arguments = arguments or {}

    handler = TOOL_HANDLERS.get(name)
    if handler is None:
        raise ValueError(f"Unknown tool: {name}")

    try:
        result = handler(arguments)
        # mempalace tool functions return dicts
        text = json.dumps(result, default=str, ensure_ascii=False)
        return [types.TextContent(type="text", text=text)]
    except Exception as e:
        logger.exception("Tool %s failed", name)
        raise


# ---------------------------------------------------------------------------
# SSE transport via Starlette
# ---------------------------------------------------------------------------
sse_transport = SseServerTransport("/messages/")


async def handle_sse(request):
    """SSE endpoint — one long-lived connection per MCP client."""
    async with sse_transport.connect_sse(
        request.scope, request.receive, request._send
    ) as streams:
        await mcp_server.run(
            streams[0],
            streams[1],
            mcp_server.create_initialization_options(),
        )
    return Response()


starlette_app = Starlette(
    routes=[
        Route("/sse", endpoint=handle_sse, methods=["GET"]),
        Mount("/messages/", app=sse_transport.handle_post_message),
    ],
)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    logger.info("Starting MemPalace SSE server on port %d", PORT)
    logger.info("Palace path: %s", PALACE_PATH)
    uvicorn.run(
        starlette_app,
        host="0.0.0.0",
        port=PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
