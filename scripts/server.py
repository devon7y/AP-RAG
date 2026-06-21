"""
server.py — OpenAI-compatible embedding server for Qwen3-Embedding-8B

This server embeds QUERIES only (the corpus is embedded once at ingest). Qwen3-
Embedding is instruction-aware, so every query is wrapped in an "Instruct: …\nQuery:"
prompt while documents get none — that asymmetry is how the model was trained.

The SAME model + EMBED_QUERY_INSTRUCTION must be used on every machine that serves
the same Qdrant corpus. Precision may differ (the Mac runs full bf16/fp16, the PC
runs a 4/8-bit quant to fit 12 GB) — nearest-neighbor retrieval absorbs that drift.

Run (PC / 4070 Ti, 12 GB — 8-bit ≈ 8 GB):
    set EMBED_LOAD_IN_8BIT=1
    python -m uvicorn server:app --host 0.0.0.0 --port 8000
Run (Mac, 128 GB — full precision on Apple GPU):
    EMBED_DEVICE=mps python -m uvicorn server:app --host 0.0.0.0 --port 8000

Endpoints:
    GET  /health          — liveness check, returns VRAM usage
    POST /v1/embeddings   — OpenAI-compatible embeddings

Compatible with any OpenAI client (the `model` field is ignored):
    from openai import OpenAI
    client = OpenAI(base_url="http://<tailscale-ip>:8000/v1", api_key="ignored")
    resp = client.embeddings.create(model="qwen3-embedding-8b", input=["my query"])
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

MODEL_ID    = os.environ.get("EMBED_MODEL_ID", "Qwen/Qwen3-Embedding-8B")
DEVICE      = os.environ.get("EMBED_DEVICE", "cuda")          # "cuda" (PC) | "mps"/"cpu" (Mac)
TORCH_DTYPE = os.environ.get("EMBED_TORCH_DTYPE", "float16")  # base dtype when not 4/8-bit
# Fit the 8B model on a 12 GB GPU (e.g. 4070 Ti) via bitsandbytes; leave both unset
# on the 128 GB Mac to run full precision. 8-bit ≈ 8 GB, 4-bit ≈ 5 GB.
LOAD_IN_8BIT = os.environ.get("EMBED_LOAD_IN_8BIT", "0") == "1"
LOAD_IN_4BIT = os.environ.get("EMBED_LOAD_IN_4BIT", "0") == "1"
# Academic-paper retrieval instruction (task-aware embedding). Documents are NEVER
# given an instruction; this prompt is applied to queries only. Keep this identical
# on every serving machine for the same corpus.
QUERY_INSTRUCTION = os.environ.get(
    "EMBED_QUERY_INSTRUCTION",
    "Given a question about scientific literature, retrieve relevant passages "
    "from academic papers that answer the question",
)
QUERY_PROMPT = f"Instruct: {QUERY_INSTRUCTION}\nQuery:"
BATCH_SIZE   = int(os.environ.get("EMBED_BATCH", 16))
HOST         = os.environ.get("HOST", "0.0.0.0")
PORT         = int(os.environ.get("PORT", 8000))

# ── Global model handle ───────────────────────────────────────────────────────

_model: SentenceTransformer | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model
    model_kwargs = {"torch_dtype": getattr(torch, TORCH_DTYPE)}
    st_device = DEVICE
    if LOAD_IN_4BIT or LOAD_IN_8BIT:
        # bitsandbytes models are placed by accelerate and cannot be moved with
        # .to() afterward — which is what passing device= to SentenceTransformer
        # does. So load via device_map and leave ST's device unset.
        from transformers import BitsAndBytesConfig
        if LOAD_IN_4BIT:
            model_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=getattr(torch, TORCH_DTYPE),
            )
        else:
            model_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_8bit=True)
        model_kwargs["device_map"] = "auto"
        st_device = None
    quant = "4bit" if LOAD_IN_4BIT else "8bit" if LOAD_IN_8BIT else TORCH_DTYPE
    print(f"Loading {MODEL_ID} on {DEVICE} ({quant})…", flush=True)
    _model = SentenceTransformer(MODEL_ID, device=st_device, model_kwargs=model_kwargs)
    if DEVICE == "cuda" and torch.cuda.is_available():
        vram_gb = round(torch.cuda.memory_allocated() / 1e9, 2)
        print(f"Model ready. VRAM: {vram_gb} GB", flush=True)
    else:
        print(f"Model ready on {DEVICE}.", flush=True)
    yield
    print("Shutting down.", flush=True)


app = FastAPI(title="Qwen3 Embedding Server", lifespan=lifespan)

# ── Schemas ───────────────────────────────────────────────────────────────────


class EmbedRequest(BaseModel):
    input: str | list[str]
    model: str = MODEL_ID
    encoding_format: str = "float"
    # LightRAG task-aware hook: "query" applies the instruction, "document" doesn't.
    # Defaults to "query" so a plain OpenAI client (which won't send this) keeps the
    # query-side behavior this server is normally used for.
    context: str = "query"


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

    # Task-aware: instruction for queries, none for documents.
    prompt = QUERY_PROMPT if req.context == "query" else None

    loop = asyncio.get_event_loop()
    vectors = await loop.run_in_executor(
        None,
        lambda: _model.encode(
            texts,
            prompt=prompt,
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
