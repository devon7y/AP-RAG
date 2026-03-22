"""
query_westbury.py — Interactive QA over Westbury papers using Claude.

Uses the knowledge graph built by ingest_westbury.py.
Requires ANTHROPIC_API_KEY in environment and EMBEDDING_BINDING_API_KEY in westbury/.env.

Usage:
    cd /Users/devon7y/VS_Code/rag_testing/LightRAG
    source .venv/bin/activate
    python ../query_westbury.py
    python ../query_westbury.py --mode global
    python ../query_westbury.py --mode local

Query modes:
    hybrid  — combines local + global  (default)
    local   — entity-focused, good for "what did paper X say about Y"
    global  — theme-focused, good for "what are the trends across papers"
    mix     — KG + vector search combined
    naive   — plain vector search, no graph (fastest)
"""

import argparse
import asyncio
import inspect
import os
import sys
from functools import partial
from pathlib import Path

from dotenv import load_dotenv

_env_path = Path(__file__).parent / "westbury" / ".env"
load_dotenv(dotenv_path=_env_path, override=False)

from anthropic import AsyncAnthropic  # noqa: E402
from lightrag import LightRAG, QueryParam  # noqa: E402
from lightrag.llm.openai import openai_embed  # noqa: E402
from lightrag.utils import EmbeddingFunc  # noqa: E402

# ── Configuration ─────────────────────────────────────────────────────────────

STORAGE_DIR = Path(__file__).parent / "LightRAG" / "rag_storage_westbury"
CLAUDE_MODEL = "claude-sonnet-4-5-20250929"

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.getenv("EMBEDDING_BINDING_API_KEY") or os.getenv("OPENAI_API_KEY", "")

# ──────────────────────────────────────────────────────────────────────────────

_anthropic_client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


async def claude_llm(prompt, system_prompt=None, history_messages=None, **kwargs):
    if history_messages is None:
        history_messages = []
    kwargs.pop("hashing_kv", None)
    kwargs.pop("keyword_extraction", None)
    kwargs.pop("stream", None)
    messages = list(history_messages) + [{"role": "user", "content": prompt}]
    params = {"model": CLAUDE_MODEL, "max_tokens": 8000, "messages": messages}
    if system_prompt:
        params["system"] = system_prompt
    response = await _anthropic_client.messages.create(**params)
    return response.content[0].text


async def build_rag() -> LightRAG:
    rag = LightRAG(
        working_dir=str(STORAGE_DIR),
        llm_model_func=claude_llm,
        embedding_func=EmbeddingFunc(
            embedding_dim=3072,
            max_token_size=8192,
            func=partial(
                openai_embed.func,
                model="text-embedding-3-large",
                api_key=OPENAI_API_KEY,
                base_url="https://api.openai.com/v1",
            ),
        ),
    )
    await rag.initialize_storages()
    return rag


async def print_stream(stream):
    async for chunk in stream:
        if chunk:
            print(chunk, end="", flush=True)
    print()


async def main(mode: str):
    if not ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY is not set.")
        sys.exit(1)
    if not OPENAI_API_KEY or OPENAI_API_KEY == "YOUR_OPENAI_API_KEY_HERE":
        print("ERROR: Set EMBEDDING_BINDING_API_KEY in westbury/.env")
        sys.exit(1)
    if not STORAGE_DIR.exists():
        print(f"ERROR: No knowledge graph found at {STORAGE_DIR}")
        print("Run ingest_westbury.py first to build the index.")
        sys.exit(1)

    print(f"Westbury Papers RAG  |  model: {CLAUDE_MODEL}  |  mode: {mode}")
    print("Type 'quit' to exit, 'mode <name>' to switch modes.\n")

    rag = await build_rag()

    try:
        while True:
            try:
                question = input("Question: ").strip()
            except (EOFError, KeyboardInterrupt):
                break

            if not question:
                continue
            if question.lower() in ("quit", "exit", "q"):
                break
            if question.lower().startswith("mode "):
                mode = question.split()[1]
                print(f"Switched to mode: {mode}\n")
                continue

            print()
            try:
                response = await rag.aquery(
                    question,
                    param=QueryParam(
                        mode=mode,
                        top_k=60,
                        chunk_top_k=20,
                        stream=True,
                    ),
                )
                if inspect.isasyncgen(response):
                    await print_stream(response)
                else:
                    print(response)
            except Exception as e:
                print(f"Error: {e}")
            print(f"\n{'─' * 60}\n")
    finally:
        await rag.finalize_storages()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Query Westbury papers RAG with Claude")
    parser.add_argument(
        "--mode",
        default="hybrid",
        choices=["local", "global", "hybrid", "mix", "naive"],
        help="Retrieval mode (default: hybrid)",
    )
    args = parser.parse_args()
    asyncio.run(main(args.mode))
