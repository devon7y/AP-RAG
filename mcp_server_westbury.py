#!/usr/bin/env python3
"""
MCP server for the Westbury Papers LightRAG knowledge graph.

Thin HTTP client that forwards queries to the PC query server
(running LightRAG + Qdrant + Octen embeddings + gpt-5-mini).

Registration:
    claude mcp add --scope user lightrag-westbury -- \
        /Users/devon7y/VS_Code/rag_testing/venv/bin/python \
        /Users/devon7y/VS_Code/rag_testing/mcp_server_westbury.py
"""

import os
import sys

# All stdout must be stderr for stdio MCP servers (stdout is reserved for JSON-RPC)
import logging
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

import httpx
from mcp.server.fastmcp import FastMCP

# ── Configuration ──────────────────────────────────────────────────────────────

QUERY_SERVER_URL = os.environ.get(
    "WESTBURY_QUERY_URL", "http://100.98.84.84:8001"
)

# ── MCP Server ─────────────────────────────────────────────────────────────────

mcp = FastMCP("lightrag-westbury")


@mcp.tool()
async def query_westbury_papers(question: str, mode: str = "hybrid") -> str:
    """
    Search the Westbury papers knowledge graph to answer research questions.

    This database covers papers from the Westbury lab and related researchers,
    spanning topics such as humor, psycholinguistics, word frequency, entropy,
    semantic memory, and cognitive science broadly.

    Use this tool whenever the user asks about:
    - Research findings from Westbury or collaborators
    - Humor, incongruity, or entropy in language
    - Psycholinguistic norms and word properties
    - Semantic foraging and memory search
    - Specific papers, authors, or concepts in this corpus

    Args:
        question: The research question to answer from the papers.
        mode: Retrieval strategy:
              - "hybrid" (default): combines entity-focused + theme-focused retrieval
              - "local": best for specific entity/paper questions
              - "global": best for broad cross-paper themes and trends
              - "naive": simple vector search, fastest but no graph reasoning
    """
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{QUERY_SERVER_URL}/query",
                json={"question": question, "mode": mode},
            )
            resp.raise_for_status()
            return resp.json()["answer"]
    except httpx.HTTPStatusError as exc:
        print(f"ERROR: Query server returned {exc.response.status_code}", file=sys.stderr)
        return f"Query failed: server returned {exc.response.status_code}"
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return f"Query failed: {exc}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
