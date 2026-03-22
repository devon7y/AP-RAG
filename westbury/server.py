"""
server.py — OpenAI-compatible embedding server for Octen-Embedding-8B-INT8

Place at C:\\rag_server\\server.py

Install dependencies (once, after torch is already installed with CUDA):
    C:\\rag_server\\venv\\Scripts\\pip install fastapi uvicorn[standard]

Run:
    C:\\rag_server\\venv\\Scripts\\python -m uvicorn server:app --host 0.0.0.0 --port 8000

Endpoints:
    GET  /health          — liveness check, returns VRAM usage
    POST /v1/embeddings   — OpenAI-compatible embeddings

Compatible with any OpenAI client:
    from openai import OpenAI
    client = OpenAI(base_url="http://<tailscale-ip>:8000/v1", api_key="ignored")
    resp = client.embeddings.create(model="Octen", input=["- my text"])
"""

import asyncio
import os
from contextlib import asynccontextmanager

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

os.environ["SAFETENSORS_FAST_GPU"] = "1"

# ── Config ────────────────────────────────────────────────────────────────────

MODEL_ID   = "Octen/Octen-Embedding-8B-INT8"
BATCH_SIZE = 16
HOST       = os.environ.get("HOST", "0.0.0.0")
PORT       = int(os.environ.get("PORT", 8000))

# ── Global model handle ───────────────────────────────────────────────────────

_model: SentenceTransformer | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model
    print(f"Loading {MODEL_ID} on cuda…", flush=True)
    _model = SentenceTransformer(MODEL_ID, device="cuda")
    vram_gb = round(torch.cuda.memory_allocated() / 1e9, 2)
    print(f"Model ready. VRAM: {vram_gb} GB", flush=True)
    yield
    print("Shutting down.", flush=True)


app = FastAPI(title="Octen Embedding Server", lifespan=lifespan)

# ── Schemas ───────────────────────────────────────────────────────────────────


class EmbedRequest(BaseModel):
    input: str | list[str]
    model: str = MODEL_ID
    encoding_format: str = "float"


# ── Routes ────────────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    vram_gb = round(torch.cuda.memory_allocated() / 1e9, 2) if torch.cuda.is_available() else 0.0
    return {"status": "ok", "model": MODEL_ID, "vram_gb": vram_gb}


@app.post("/v1/embeddings")
async def embed(req: EmbedRequest):
    texts = [req.input] if isinstance(req.input, str) else req.input
    if not texts:
        raise HTTPException(status_code=400, detail="input must be non-empty")

    prefixed = ["- " + t for t in texts]

    loop = asyncio.get_event_loop()
    vectors = await loop.run_in_executor(
        None,
        lambda: _model.encode(
            prefixed,
            normalize_embeddings=True,
            batch_size=BATCH_SIZE,
            show_progress_bar=False,
        ),
    )

    data = [
        {"object": "embedding", "embedding": vec.tolist(), "index": i}
        for i, vec in enumerate(vectors)
    ]

    total_tokens = sum(len(t) // 4 for t in texts)

    return {
        "object": "list",
        "data": data,
        "model": MODEL_ID,
        "usage": {"prompt_tokens": total_tokens, "total_tokens": total_tokens},
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("server:app", host=HOST, port=PORT, log_level="info")
