"""
query_westbury_pc.py — Query the Westbury LightRAG storage using:
  - Octen embeddings via PC server (http://100.98.84.84:8000)
  - OpenAI GPT-4o for answer generation
"""

import asyncio
import os
import sys

import numpy as np
from openai import AsyncOpenAI

# ── Config ────────────────────────────────────────────────────────────────────

STORAGE_DIR   = "westbury/rag_storage_westbury_qwen3_32b"
EMBED_HOST    = "http://100.98.84.84:8000/v1"
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
LLM_MODEL     = "gpt-5-mini"
EMBEDDING_DIM = 4096

# ── Embedding via PC server ───────────────────────────────────────────────────

_embed_client = AsyncOpenAI(base_url=EMBED_HOST, api_key="ignored")


async def pc_embed(texts: list[str]) -> np.ndarray:
    resp = await _embed_client.embeddings.create(model="Octen", input=texts)
    return np.array([d.embedding for d in resp.data])


# ── LLM via OpenAI ────────────────────────────────────────────────────────────

_llm_client = AsyncOpenAI(api_key=OPENAI_API_KEY)


async def openai_llm(prompt, system_prompt=None, history_messages=None, **kwargs):
    from lightrag.llm.openai import openai_complete_if_cache
    return await openai_complete_if_cache(
        LLM_MODEL, prompt,
        system_prompt=system_prompt,
        history_messages=history_messages or [],
        api_key=OPENAI_API_KEY,
        base_url="https://api.openai.com/v1",
        **kwargs,
    )


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    from lightrag import LightRAG, QueryParam
    from lightrag.utils import EmbeddingFunc

    rag = LightRAG(
        working_dir=STORAGE_DIR,
        llm_model_func=openai_llm,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=8192,
            func=pc_embed,
        ),
    )
    await rag.initialize_storages()

    query = sys.argv[1] if len(sys.argv) > 1 else "What are the main research themes in the Westbury lab?"
    mode  = sys.argv[2] if len(sys.argv) > 2 else "hybrid"

    print(f"\nQuery : {query}")
    print(f"Mode  : {mode}\n")
    print("─" * 60)

    result = await rag.aquery(query, param=QueryParam(mode=mode))
    print(result)

    await rag.finalize_storages()


if __name__ == "__main__":
    asyncio.run(main())
