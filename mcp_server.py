#!/usr/bin/env python3
"""
MCP server for LightRAG academic papers knowledge graph.

Loads the knowledge graph once on startup and keeps it in memory.
Exposes a query_papers tool that Claude can call automatically when
research questions arise about the indexed papers.

Registration (already done):
    claude mcp add --scope user lightrag-papers -- \\
        /Users/devon7y/VS_Code/rag_testing/LightRAG/.venv/bin/python \\
        /Users/devon7y/VS_Code/rag_testing/mcp_server.py
"""

import asyncio
import os
import sys
from functools import partial
from pathlib import Path

from dotenv import load_dotenv

# Load config from LightRAG .env
_env_path = Path(__file__).parent / "LightRAG" / ".env"
load_dotenv(dotenv_path=_env_path, override=False)

# All stdout must be stderr for stdio MCP servers (stdout is reserved for JSON-RPC)
import logging
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

from mcp.server.fastmcp import FastMCP
from lightrag import LightRAG, QueryParam
from lightrag.llm.openai import openai_embed, openai_complete_if_cache
from lightrag.utils import EmbeddingFunc

# ── Configuration ──────────────────────────────────────────────────────────────

STORAGE_DIR = Path(__file__).parent / "LightRAG" / "rag_storage"


def _env_first(*names: str) -> str:
    """Return first non-empty env var value, ignoring placeholder EMPTY."""
    for name in names:
        value = os.getenv(name, "").strip()
        if value and value.upper() != "EMPTY":
            return value
    return ""


# Dedicated MCP settings with explicit OpenAI defaults.
# This avoids inheriting mismatched LLM_BINDING_* values intended for local vLLM.
LLM_MODEL = os.getenv("MCP_LLM_MODEL", "gpt-5-mini").strip()
LLM_BASE_URL = _env_first("MCP_LLM_BASE_URL", "OPENAI_API_BASE") or "https://api.openai.com/v1"
LLM_API_KEY = _env_first(
    "MCP_LLM_API_KEY",
    "OPENAI_API_KEY",
    "EMBEDDING_BINDING_API_KEY",
    "LLM_BINDING_API_KEY",
)

EMBEDDING_MODEL = os.getenv("MCP_EMBEDDING_MODEL", "text-embedding-3-large").strip()
EMBEDDING_BASE_URL = (
    _env_first("MCP_EMBEDDING_BASE_URL", "EMBEDDING_BINDING_HOST", "OPENAI_API_BASE")
    or "https://api.openai.com/v1"
)
EMBEDDING_API_KEY = _env_first(
    "MCP_EMBEDDING_API_KEY",
    "EMBEDDING_BINDING_API_KEY",
    "OPENAI_API_KEY",
    "LLM_BINDING_API_KEY",
)


async def gpt_5_mini_complete(prompt, system_prompt=None, history_messages=None, **kwargs):
    if not LLM_API_KEY:
        raise RuntimeError(
            "No LLM API key configured. Set MCP_LLM_API_KEY or OPENAI_API_KEY."
        )
    return await openai_complete_if_cache(
        LLM_MODEL,
        prompt,
        system_prompt=system_prompt,
        history_messages=history_messages,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        **kwargs,
    )

# ── LLM + RAG setup ────────────────────────────────────────────────────────────

_rag: LightRAG | None = None


async def _get_rag() -> LightRAG:
    """Return the singleton LightRAG instance, initializing if needed."""
    global _rag
    if _rag is None:
        print("Loading knowledge graph...", file=sys.stderr)
        print(
            "MCP LLM config: "
            f"model={LLM_MODEL}, base_url={LLM_BASE_URL}, api_key_set={bool(LLM_API_KEY)}",
            file=sys.stderr,
        )
        if not EMBEDDING_API_KEY:
            raise RuntimeError(
                "No embedding API key configured. Set MCP_EMBEDDING_API_KEY "
                "or EMBEDDING_BINDING_API_KEY."
            )
        _rag = LightRAG(
            working_dir=str(STORAGE_DIR),
            llm_model_func=gpt_5_mini_complete,
            embedding_func=EmbeddingFunc(
                embedding_dim=3072,
                max_token_size=8192,
                func=partial(
                    openai_embed.func,
                    model=EMBEDDING_MODEL,
                    api_key=EMBEDDING_API_KEY,
                    base_url=EMBEDDING_BASE_URL,
                ),
            ),
        )
        await _rag.initialize_storages()
        print("Knowledge graph ready.", file=sys.stderr)
    return _rag


# ── MCP Server ─────────────────────────────────────────────────────────────────

mcp = FastMCP("lightrag-papers")


@mcp.tool()
async def query_papers(question: str, mode: str = "hybrid") -> str:
    """
    Search the academic papers knowledge graph to answer research questions.

    Use this tool whenever the user asks about:
    - Research methods, paradigms, or experimental designs
    - Findings, results, or conclusions from studies
    - Authors, papers, or citations in the corpus
    - Relationships between concepts (e.g. working memory and serial recall)
    - Comparisons or syntheses across multiple papers

    Args:
        question: The research question to answer from the papers.
        mode: Retrieval strategy:
              - "hybrid" (default): combines entity-focused + theme-focused retrieval
              - "local": best for specific entity/paper questions
              - "global": best for broad cross-paper themes and trends
              - "naive": simple vector search, fastest but no graph reasoning
    """
    rag = await _get_rag()
    try:
        result = await rag.aquery(
            question,
            param=QueryParam(mode=mode, top_k=60, chunk_top_k=20, stream=False),
        )
    except Exception as exc:
        print(f"ERROR: Query failed: {exc}", file=sys.stderr)
        return f"Query failed: {exc}"
    return result or "No relevant information found in the knowledge graph."


if __name__ == "__main__":
    mcp.run(transport="stdio")
