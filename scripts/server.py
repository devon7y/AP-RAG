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
import threading
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
# Qwen3-Embedding-8B loads with max_seq_length=40960 here. Merged entity/relation
# descriptions are long, and 32768-token sequences at batch 64 blow ~64GB of
# attention memory on an 80GB card (observed: CUDA OOM during the reembed flush,
# 2026-07-27). pipeline/ingest.py has capped this since the 07-03 OOM-cascade
# fix; the server needs the SAME cap or the remote-embedding path silently
# reintroduces the bug that fix removed.
EMBED_MAX_SEQ = int(os.environ.get("EMBED_MAX_SEQ", 4096))

# ── Global model handle ───────────────────────────────────────────────────────

_model: SentenceTransformer | None = None

# Serializes model.encode() across FastAPI's default thread pool. Two reasons,
# both observed in this project:
#   1. VRAM — concurrent encodes multiply activation memory on ONE card. With
#      EMBED_FUNC_MAX_ASYNC=16 fanned over 4 servers, several batch-64 encodes
#      can land on the same GPU at once and OOM even with max_seq_length capped.
#   2. Thread safety — the HF *fast* tokenizer inside this single shared
#      SentenceTransformer is a Rust object with interior mutability, and
#      transformers' set_truncation_and_padding() does an unguarded
#      check-then-act, so parallel encodes raise "RuntimeError: Already
#      borrowed" (this is the same race _ENCODE_LOCK fixes in pipeline/ingest.py).
# Embedding is GPU-bound anyway, so serializing costs throughput nothing.
_ENCODE_LOCK = threading.Lock()


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
    if EMBED_MAX_SEQ > 0:
        try:
            _orig_seq = int(getattr(_model, "max_seq_length", 0) or 0)
            if _orig_seq == 0 or _orig_seq > EMBED_MAX_SEQ:
                _model.max_seq_length = EMBED_MAX_SEQ
                print(f"max_seq_length capped: {_orig_seq or 'unset'} → {EMBED_MAX_SEQ}", flush=True)
        except Exception as _e:
            print(f"could not cap max_seq_length: {_e}", flush=True)
    if DEVICE == "cuda" and torch.cuda.is_available():
        # Same guard as pipeline/ingest.py::get_embed_model. Two failure modes on
        # sm90 without it: torch 2.11's run_cudnn_SDP_fprop NULL-deref (the July
        # poison-doc segfault), and on Trillium "cuDNN Frontend error: No valid
        # execution plans built" — a deterministic exception that 500'd every
        # segment flush on 2026-07-31 (tril 694223, 3h zero commits). Retry
        # cannot help a deterministic failure; disabling the backend can.
        try:
            torch.backends.cuda.enable_cudnn_sdp(False)
            print("cuDNN SDPA backend disabled (sm90 guard)", flush=True)
        except Exception as _e:
            print(f"could not disable cuDNN SDPA: {_e}", flush=True)
        vram_gb = round(torch.cuda.memory_allocated() / 1e9, 2)
        print(f"Model ready. VRAM: {vram_gb} GB", flush=True)
    else:
        print(f"Model ready on {DEVICE}.", flush=True)
    yield
    print("Shutting down.", flush=True)


def _is_alloc_error(e: BaseException) -> bool:
    """True for any CUDA/cuBLAS/cuDNN *allocation* failure, not just OOM.

    torch raises several distinct messages for "out of VRAM", and matching only
    "out of memory" misses them. On 2026-07-28 a 12h / 4-H100 reembed produced
    4,506 HTTP 500s and committed ZERO vectors because the flush hit
    `CUDA error: CUBLAS_STATUS_ALLOC_FAILED when calling cublasCreate(handle)` —
    a workspace allocation failure that never contains "out of memory", so the
    halving retry never fired. OutOfMemoryError count for that run was 0.
    """
    m = str(e).lower()
    return any(k in m for k in (
        "out of memory",
        "cublas_status_alloc_failed",
        "cublascreate",
        "cudnn_status_alloc_failed",
        "cuda error: out of memory",
        "alloc_failed",
    ))


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

    def _encode_oom_safe():
        """Halve the batch on CUDA OOM instead of 500-ing the caller.

        Mirrors pipeline/ingest.py::_encode_oom_safe. Without this, one oversized
        request kills the whole flush: LightRAG surfaces the 500 as an embedding
        failure and aborts the pending batch (observed 2026-07-27, Nibi 18589919,
        upserts=3586043). Catches RuntimeError by message because cuBLAS
        workspace failures surface as plain RuntimeError, not OutOfMemoryError.
        """
        bs = BATCH_SIZE
        while True:
            try:
                with _ENCODE_LOCK:
                    return _model.encode(
                        texts,
                        prompt=prompt,
                        normalize_embeddings=True,
                        batch_size=bs,
                        show_progress_bar=False,
                    )
            except RuntimeError as e:
                if not _is_alloc_error(e):
                    raise
                if DEVICE == "cuda" and torch.cuda.is_available():
                    torch.cuda.empty_cache()
                if bs <= 1:
                    raise
                bs = max(1, bs // 2)
                print(f"CUDA OOM at batch_size={bs * 2} — retrying at {bs} "
                      f"({len(texts)} texts)", flush=True)

    loop = asyncio.get_event_loop()
    vectors = await loop.run_in_executor(None, _encode_oom_safe)

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
