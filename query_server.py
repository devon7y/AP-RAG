"""
query_server.py — AP-RAG query server (LightRAG + Qdrant + embeddings).

Place at C:\\rag_server\\query_server.py

Run:
    C:\\rag_server\\venv\\Scripts\\python -m uvicorn query_server:app --host 0.0.0.0 --port 8001

Endpoints:
    GET  /health          — liveness check + capability flags
    POST /query           — synthesized answer (LLM over retrieved context)
    POST /retrieve        — structured retrieval only (entities/relationships/chunks), no LLM
"""

import os
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from openai import AsyncOpenAI
from pydantic import BaseModel

from lightrag import LightRAG, QueryParam
from lightrag.llm.openai import openai_complete_if_cache
from lightrag.utils import EmbeddingFunc

# ── Config ────────────────────────────────────────────────────────────────────

STORAGE_DIR   = os.environ.get("STORAGE_DIR", r"C:\rag_server\rag_storage_westbury_qwen3_32b")
EMBED_HOST    = os.environ.get("EMBED_HOST", "http://localhost:8000/v1")
QDRANT_URL    = os.environ.get("QDRANT_URL", "http://localhost:6333")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
LLM_MODEL     = os.environ.get("LLM_MODEL", "gpt-5-mini")
EMBEDDING_DIM = 4096
HOST          = os.environ.get("HOST", "0.0.0.0")
PORT          = int(os.environ.get("PORT", 8001))

# Set QDRANT_URL for LightRAG's Qdrant backend
os.environ.setdefault("QDRANT_URL", QDRANT_URL)

# ── Embedding via local Octen server ──────────────────────────────────────────

_embed_client = AsyncOpenAI(base_url=EMBED_HOST, api_key="ignored")


async def pc_embed(texts: list[str]) -> np.ndarray:
    resp = await _embed_client.embeddings.create(model="Octen", input=texts)
    return np.array([d.embedding for d in resp.data])


# ── LLM via OpenAI ────────────────────────────────────────────────────────────

async def openai_llm(prompt, system_prompt=None, history_messages=None, **kwargs):
    return await openai_complete_if_cache(
        LLM_MODEL, prompt,
        system_prompt=system_prompt,
        history_messages=history_messages or [],
        api_key=OPENAI_API_KEY,
        base_url="https://api.openai.com/v1",
        **kwargs,
    )


# ── RAG (loaded once at startup) ──────────────────────────────────────────────

_rag: LightRAG | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _rag
    print("Loading LightRAG knowledge graph...", flush=True)
    _rag = LightRAG(
        working_dir=STORAGE_DIR,
        llm_model_func=openai_llm,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=8192,
            func=pc_embed,
        ),
        vector_storage="QdrantVectorDBStorage",
        vector_db_storage_cls_kwargs={"cosine_better_than_threshold": 0.2},
    )
    await _rag.initialize_storages()
    print("Knowledge graph ready.", flush=True)
    yield
    await _rag.finalize_storages()
    print("Shutting down.", flush=True)


app = FastAPI(title="AP-RAG Query Server", lifespan=lifespan)

# ── Schemas ───────────────────────────────────────────────────────────────────


class QueryRequest(BaseModel):
    question: str
    mode: str = "hybrid"
    top_k: int | None = None
    chunk_top_k: int | None = None
    user_prompt: str | None = None


class RetrieveRequest(BaseModel):
    question: str
    mode: str = "naive"
    top_k: int | None = None
    chunk_top_k: int | None = None


def _build_query_param(req) -> QueryParam:
    """Build a QueryParam, leaving LightRAG defaults intact for unset optionals."""
    kwargs = {"mode": req.mode}
    if req.top_k is not None:
        kwargs["top_k"] = req.top_k
    if req.chunk_top_k is not None:
        kwargs["chunk_top_k"] = req.chunk_top_k
    user_prompt = getattr(req, "user_prompt", None)
    if user_prompt is not None:
        kwargs["user_prompt"] = user_prompt
    return QueryParam(**kwargs)


# ── Routes ────────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {
        "status": "ok",
        "storage": STORAGE_DIR,
        "llm": LLM_MODEL,
        # Lets clients/deploys detect an older LightRAG that lacks structured retrieval.
        "lightrag_has_aquery_data": hasattr(LightRAG, "aquery_data"),
    }


@app.post("/query")
async def query(req: QueryRequest):
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    result = await _rag.aquery(req.question, param=_build_query_param(req))
    return {"answer": result or "No relevant information found.", "mode": req.mode}


@app.post("/retrieve")
async def retrieve(req: RetrieveRequest):
    """Structured retrieval without LLM synthesis — the agentic multi-hop primitive."""
    if _rag is None:
        raise HTTPException(status_code=503, detail="RAG not initialized")
    if not hasattr(_rag, "aquery_data"):
        raise HTTPException(
            status_code=501,
            detail="Installed LightRAG lacks aquery_data; upgrade lightrag_hku for /retrieve.",
        )
    return await _rag.aquery_data(req.question, param=_build_query_param(req))


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("query_server:app", host=HOST, port=PORT, log_level="info")
