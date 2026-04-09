"""
MemPalace MCP Server

Wraps the mempalace package's tool functions as an MCP server.
Uses FastMCP for transport handling (SSE + streamable HTTP).
"""

import json
import logging
import os
import sys

from mcp.server.fastmcp import FastMCP

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
# FastMCP server
# ---------------------------------------------------------------------------
mcp = FastMCP("mempalace", host="0.0.0.0", port=PORT)


@mcp.tool()
def mempalace_status() -> str:
    """Palace overview — total drawers, wing and room counts"""
    return json.dumps(tool_status(), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_list_wings() -> str:
    """List all wings with drawer counts"""
    return json.dumps(tool_list_wings(), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_list_rooms(wing: str | None = None) -> str:
    """List rooms within a wing (or all rooms if no wing given)"""
    return json.dumps(tool_list_rooms(wing=wing), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_get_taxonomy() -> str:
    """Full taxonomy: wing -> room -> drawer count"""
    return json.dumps(tool_get_taxonomy(), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_get_aaak_spec() -> str:
    """Get the AAAK dialect specification — the compressed memory format MemPalace uses"""
    return json.dumps(tool_get_aaak_spec(), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_search(query: str, limit: int = 5, wing: str | None = None, room: str | None = None) -> str:
    """Semantic search. Returns verbatim drawer content with similarity scores."""
    return json.dumps(tool_search(query=query, limit=limit, wing=wing, room=room), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_check_duplicate(content: str, threshold: float = 0.9) -> str:
    """Check if content already exists in the palace before filing"""
    return json.dumps(tool_check_duplicate(content=content, threshold=threshold), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_add_drawer(wing: str, room: str, content: str, source_file: str | None = None, added_by: str = "mcp") -> str:
    """File verbatim content into the palace. Checks for duplicates first."""
    return json.dumps(tool_add_drawer(wing=wing, room=room, content=content, source_file=source_file, added_by=added_by), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_delete_drawer(drawer_id: str) -> str:
    """Delete a drawer by ID"""
    return json.dumps(tool_delete_drawer(drawer_id=drawer_id), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_kg_query(entity: str, as_of: str | None = None, direction: str = "both") -> str:
    """Query the knowledge graph for an entity's relationships. Returns typed facts."""
    return json.dumps(tool_kg_query(entity=entity, as_of=as_of, direction=direction), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_kg_add(subject: str, predicate: str, object: str, valid_from: str | None = None, source_closet: str | None = None) -> str:
    """Add a fact to the knowledge graph. Subject -> predicate -> object with optional time window."""
    return json.dumps(tool_kg_add(subject=subject, predicate=predicate, object=object, valid_from=valid_from, source_closet=source_closet), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_kg_invalidate(subject: str, predicate: str, object: str, ended: str | None = None) -> str:
    """Mark a fact as no longer true"""
    return json.dumps(tool_kg_invalidate(subject=subject, predicate=predicate, object=object, ended=ended), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_kg_timeline(entity: str | None = None) -> str:
    """Chronological timeline of facts. Shows the story of an entity."""
    return json.dumps(tool_kg_timeline(entity=entity), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_kg_stats() -> str:
    """Knowledge graph overview: entities, triples, current vs expired facts"""
    return json.dumps(tool_kg_stats(), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_traverse(start_room: str, max_hops: int = 2) -> str:
    """Walk the palace graph from a room. Shows connected ideas across wings."""
    return json.dumps(tool_traverse_graph(start_room=start_room, max_hops=max_hops), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_find_tunnels(wing_a: str | None = None, wing_b: str | None = None) -> str:
    """Find rooms that bridge two wings — the hallways connecting different domains"""
    return json.dumps(tool_find_tunnels(wing_a=wing_a, wing_b=wing_b), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_graph_stats() -> str:
    """Palace graph overview: total rooms, tunnel connections, edges between wings."""
    return json.dumps(tool_graph_stats(), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_diary_write(agent_name: str, entry: str, topic: str = "general") -> str:
    """Write to your personal agent diary in AAAK format"""
    return json.dumps(tool_diary_write(agent_name=agent_name, entry=entry, topic=topic), default=str, ensure_ascii=False)


@mcp.tool()
def mempalace_diary_read(agent_name: str, last_n: int = 10) -> str:
    """Read your recent diary entries (in AAAK)"""
    return json.dumps(tool_diary_read(agent_name=agent_name, last_n=last_n), default=str, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logger.info("Starting MemPalace MCP server on port %d", PORT)
    logger.info("Palace path: %s", PALACE_PATH)
    mcp.run(transport="sse")
