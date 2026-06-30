"""
ingest_cml_octen_v2.py — Improved LightRAG ingestion for Westbury/CML papers.

Changes from v1 (ingest_cml_octen.py):
  1A. Endpoint validation: health-check + squeue cross-check on discovery;
      stale endpoint files are deleted automatically.
  1B. Resume support: skip docs with status pending/processing (not just
      processed). LightRAG's pipeline picks them up internally.
  1C. Live status monitor: background task prints real extraction counts
      every 30s from kv_store_doc_status.json.
  2A. Qdrant support: if QDRANT_URL is set, uses QdrantVectorDBStorage
      instead of NanoVectorDB. Eliminates 10+ GB JSON files.
  3A. Batched flush: INSERT_DONE_EVERY_N controls how often _insert_done()
      is called (default: every doc). Higher values reduce GPU idle time.
  3B. LLM retry with failover: 3 retries per call, exponential backoff,
      endpoint removal + re-discovery on persistent failure.
  4.  Rebuild embeddings mode: REBUILD_EMBEDDINGS=1 rebuilds vector DBs
      from cached intermediates (KV stores + graph) without any LLM calls.
      Use when switching embedding models or vector DB backends.
  5.  Structure-aware chunking: replaces LightRAG's fixed-length token chunker
      with a scientific-paper-aware chunker that respects section, paragraph,
      and sentence boundaries. Configurable via CHUNK_* env vars.

Environment variables (set by job_westbury_ingest_v2.slurm):
    WORKDIR          — HPC working directory
    N_VLLM           — number of vLLM nodes to wait for (default 1)
    ENDPOINTS_SUBDIR — subdirectory name for vLLM endpoint files
    PAPERS_SUBDIR    — subdirectory containing PDFs
    STORAGE_SUBDIR   — subdirectory for LightRAG storage
    LLM_MODEL        — model name served by vLLM
    MAX_DOC_TOKENS   — max tokens of full-doc context used during chunk contextualization
                       (default 120000). Does NOT truncate document ingestion/chunking.
    PARALLEL_DOCS    — number of documents to ingest concurrently (default 4)
    LLM_MAX_ASYNC    — max concurrent LLM requests (default 8)
    CONTEXT_MAX_ASYNC — max concurrent contextualization requests (default 8)
    CONTEXTUALIZE_CHUNKS — "1"/"0" to enable/disable contextualization (default "1")
    EMBED_FUNC_MAX_ASYNC — max concurrent embedding calls (default 1)
    MAX_PARALLEL_INSERT  — LightRAG pipeline concurrency (default 2)
    QDRANT_URL           — if set, use QdrantVectorDBStorage instead of NanoVectorDB (2A)
    INSERT_DONE_EVERY_N  — flush storage every N docs instead of every 1 (3A, default 1)
    REBUILD_EMBEDDINGS   — if "1", skip LLM pipeline and rebuild vector DBs from cache (4)
    REBUILD_BATCH_SIZE   — records per upsert batch during rebuild (default 50)
    CHUNK_TARGET_TOKENS  — target chunk size in tokens (5, default 512)
    CHUNK_MAX_TOKENS     — hard max chunk size in tokens (5, default 640)
    CHUNK_MIN_TOKENS     — min chunk size; smaller tails are rebalanced (5, default 192)
    CHUNK_OVERLAP_TOKENS — sentence-aware overlap between chunks (5, default 51)
    CHUNK_EXCLUDE_REFS   — exclude References section from chunks (5, default 1)
    CHUNK_EXCLUDE_ACK    — exclude Acknowledgements section (5, default 1)
    INGEST_VLM           — if "1", ingest via LightRAG's native multimodal pipeline
                           (an external parser service extracts figures/tables/
                           equations; the `vlm` role captions them). Default "0" =
                           the existing text-only ainsert path, unchanged.
    PARSE_ENGINE         — multimodal parser engine: "mineru" (default) or "docling"
    PROCESS_OPTIONS      — per-doc multimodal flags i/t/e (default "ite")
    VLM_MAX_ASYNC        — max concurrent VLM caption calls (default = LLM_MAX_ASYNC).
                           The parser endpoint itself is read by LightRAG from the env
                           (MINERU_API_MODE/MINERU_LOCAL_ENDPOINT, or DOCLING_ENDPOINT),
                           which the ingest SLURM script exports.
"""

import asyncio
import hashlib
import itertools
import json
import os
import re
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path

import numpy as np

# ── Configuration ──────────────────────────────────────────────────────────────

WORKDIR       = Path(os.environ["WORKDIR"])
PAPERS_DIR    = WORKDIR / os.environ.get("PAPERS_SUBDIR", "papers_raw")
STORAGE_DIR   = WORKDIR / os.environ.get("STORAGE_SUBDIR", "rag_storage_octen")
ENDPOINTS_DIR = WORKDIR / os.environ.get("ENDPOINTS_SUBDIR", "vllm_endpoints_cml")
N_VLLM        = int(os.environ.get("N_VLLM", 1))

LLM_MODEL  = os.environ.get("LLM_MODEL", "Qwen/Qwen3.6-35B-A3B")
LLM_API_KEY = "EMPTY"

EMBED_MODEL_ID = os.environ.get("EMBED_MODEL_ID", "Qwen/Qwen3-Embedding-8B")
EMBEDDING_DIM  = int(os.environ.get("EMBEDDING_DIM", 4096))
EMBED_BATCH    = int(os.environ.get("EMBED_BATCH", 64))  # sentences per GPU forward pass (raised from 16: a batch of 16 grossly under-feeds an 8B embedder on a full 80GB H100 — it was the ingest throughput bottleneck)
EMBED_DEVICE   = os.environ.get("EMBED_DEVICE", "cuda")
# Qwen3-Embedding-8B ships in bf16. Load it in bf16 so the 8B model fits the
# 40 GB MIG (~16 GiB); SentenceTransformer's float32 default would be ~32 GiB
# and OOM. Override with EMBED_TORCH_DTYPE if needed.
EMBED_TORCH_DTYPE = os.environ.get("EMBED_TORCH_DTYPE", "bfloat16")

# Task-aware (asymmetric) embedding: queries get a Qwen3 instruction, documents get
# none. This string MUST match scripts/server.py exactly. During ingest local_embed
# is always called with context="document", but it honors context so the same code
# stays correct if this LightRAG instance is ever also used to embed queries.
EMBED_QUERY_INSTRUCTION = os.environ.get(
    "EMBED_QUERY_INSTRUCTION",
    "Given a question about scientific literature, retrieve relevant passages "
    "from academic papers that answer the question",
)
QUERY_PROMPT = f"Instruct: {EMBED_QUERY_INSTRUCTION}\nQuery:"

MAX_DOC_TOKENS    = int(os.environ.get("MAX_DOC_TOKENS", 120_000))
PARALLEL_DOCS     = int(os.environ.get("PARALLEL_DOCS", 4))
LLM_MAX_ASYNC     = int(os.environ.get("LLM_MAX_ASYNC", 8))
CONTEXT_MAX_ASYNC = int(os.environ.get("CONTEXT_MAX_ASYNC", 8))
CONTEXTUALIZE_CHUNKS = os.environ.get("CONTEXTUALIZE_CHUNKS", "1") == "1"
EMBED_FUNC_MAX_ASYNC = int(os.environ.get("EMBED_FUNC_MAX_ASYNC", 4))
MAX_PARALLEL_INSERT  = int(os.environ.get("MAX_PARALLEL_INSERT", 2))

# ── Concurrency-optimization knobs (see docs/INGEST_CONCURRENCY_PLAN.md) ─────────
# All wrapper-side; none patch the nested LightRAG. Defaults preserve prior behavior
# except the text path, which now defaults to the streaming enqueue/drain model.
#
# Fix 4: stream every document through LightRAG's native pipeline (enqueue-all →
# drain-once) instead of per-doc ainsert()+poll. Real concurrency is LightRAG's
# MAX_PARALLEL_INSERT either way; this removes the redundant per-doc polling and the
# PDF reads that used to block the event loop. Set STREAMING_INGEST=0 for the legacy
# per-doc path (kept as a fallback).
STREAMING_INGEST = os.environ.get("STREAMING_INGEST", "1") == "1"
# Fix 2c: gate the per-call [LLM_DEBUG] prints — at high LLM_MAX_ASYNC these are
# hundreds of flush=True writes/sec that throttle the event loop. Off by default.
LLM_DEBUG = os.environ.get("LLM_DEBUG", "0") == "1"
# Fix 3: per-call embedding batch LightRAG hands to the embedder (distinct from
# EMBED_BATCH, the SentenceTransformer micro-batch). Bigger batches make far better
# use of a dedicated embedding GPU than extra async concurrency does.
EMBEDDING_BATCH_NUM = int(os.environ.get("EMBEDDING_BATCH_NUM", 128))
# Fix 3: if set, embed via an OpenAI-compatible server (scripts/server.py) on its
# own GPU instead of loading the model in-process. Empty = in-process (default).
EMBED_ENDPOINT = os.environ.get("EMBED_ENDPOINT", "").strip()
# Fix 1: opt-in incremental KV backends so LightRAG's per-doc _insert_done() stops
# rewriting the giant JSON KV stores every document. Empty = LightRAG defaults
# (JsonKVStorage / JsonDocStatusStorage). Requires the matching sidecar (e.g. Redis).
KV_STORAGE = os.environ.get("KV_STORAGE", "").strip()
DOC_STATUS_STORAGE = os.environ.get("DOC_STATUS_STORAGE", "").strip()
# Fix 2d: dedicated thread pools so blocking IO (PDF reads, doc-status polling) never
# competes with embedding for the default executor's threads.
IO_THREADS = int(os.environ.get("IO_THREADS", 8))
_IO_EXECUTOR = ThreadPoolExecutor(max_workers=IO_THREADS, thread_name_prefix="aprag-io")
_EMBED_EXECUTOR = ThreadPoolExecutor(
    max_workers=max(2, EMBED_FUNC_MAX_ASYNC), thread_name_prefix="aprag-embed"
)

# VLM multimodal ingestion (native LightRAG path; figures/tables/equations).
# When INGEST_VLM=1, ingest via apipeline_enqueue_documents(pending_parse): an
# external parser service (PARSE_ENGINE: mineru|docling) extracts figures/tables/
# equations into sidecars and LightRAG's `vlm` role (our Qwen3.6 endpoint) captions
# them. The scientific chunker + contextualization wrapper still run on the parser's
# full document text. The parser endpoint is read by LightRAG directly from the env
# (MINERU_API_MODE/MINERU_LOCAL_ENDPOINT or DOCLING_ENDPOINT), set by the SLURM job.
INGEST_VLM      = os.environ.get("INGEST_VLM", "0") == "1"
PARSE_ENGINE    = os.environ.get("PARSE_ENGINE", "mineru").strip().lower()
PROCESS_OPTIONS = os.environ.get("PROCESS_OPTIONS", "ite").strip()
VLM_MAX_ASYNC   = int(os.environ.get("VLM_MAX_ASYNC", LLM_MAX_ASYNC))

# 2A: Qdrant support — if QDRANT_URL is set, use QdrantVectorDBStorage
QDRANT_URL = os.environ.get("QDRANT_URL", "")
USE_QDRANT = bool(QDRANT_URL)

# 3A: Batched flush — flush storage every N docs instead of every 1
INSERT_DONE_EVERY_N = int(os.environ.get("INSERT_DONE_EVERY_N", 1))

# 4: Rebuild embeddings mode — skip LLM pipeline, recompute vectors from cache
REBUILD_EMBEDDINGS = os.environ.get("REBUILD_EMBEDDINGS", "0") == "1"
REBUILD_BATCH_SIZE = int(os.environ.get("REBUILD_BATCH_SIZE", 50))

# 5: Structure-aware chunker (replaces LightRAG's token chunker)
# CHUNKER_TYPE: "scientific" (default) | "book" | "auto" (per-document structure
# routing — classify each PDF as book/paper and dispatch; see document_router.py).
_CHUNKER_TYPE = os.environ.get("CHUNKER_TYPE", "scientific").lower()

if _CHUNKER_TYPE == "book":
    from pipeline.book_chunker import BookChunkerConfig, make_book_chunker
    CHUNKER_CONFIG = BookChunkerConfig.from_env()
    _chunk_cache_path = STORAGE_DIR / "book_chunk_cache.json"
    _CHUNK_CACHE = None
    if _chunk_cache_path.exists():
        _CHUNK_CACHE = json.loads(_chunk_cache_path.read_text())
        print(f"[CACHE] Loaded {len(_CHUNK_CACHE)} pre-chunked docs from {_chunk_cache_path.name}")
    else:
        print(f"[CACHE] No book chunk cache found — chunking will be computed live")
    SCIENTIFIC_CHUNKER = make_book_chunker(CHUNKER_CONFIG, chunk_cache=_CHUNK_CACHE)
elif _CHUNKER_TYPE == "auto":
    # Per-document structure routing: classify each PDF as book/paper from its
    # structure (TOC, chapter headings, IMRaD sections) and dispatch to the
    # matching chunker. Page count is only a tie-breaker. See document_router.py.
    from pipeline.book_chunker import BookChunkerConfig
    from pipeline.document_router import RouterConfig, make_auto_chunker
    from pipeline.scientific_chunker import ChunkerConfig

    _SCI_CONFIG = ChunkerConfig.from_env()
    _BOOK_CONFIG = BookChunkerConfig.from_env()
    _ROUTER_CONFIG = RouterConfig.from_env()
    CHUNKER_CONFIG = _SCI_CONFIG  # feeds the startup config print below
    # Merge both prechunk caches when present (papers/ and papers_large/ are
    # disjoint corpora, so their MD5 key spaces do not collide).
    _CHUNK_CACHE = {}
    for _cache_name in ("chunk_cache.json", "book_chunk_cache.json"):
        _cache_path = STORAGE_DIR / _cache_name
        if _cache_path.exists():
            _loaded = json.loads(_cache_path.read_text())
            _CHUNK_CACHE.update(_loaded)
            print(f"[CACHE] Loaded {len(_loaded)} pre-chunked docs from {_cache_name}")
    if not _CHUNK_CACHE:
        _CHUNK_CACHE = None
        print("[CACHE] No chunk caches found — chunking will be computed live")
    SCIENTIFIC_CHUNKER = make_auto_chunker(
        sci_config=_SCI_CONFIG,
        book_config=_BOOK_CONFIG,
        router_config=_ROUTER_CONFIG,
        chunk_cache=_CHUNK_CACHE,
    )
    print(
        f"[ROUTER] CHUNKER_TYPE=auto — per-document structure routing "
        f"(page_threshold={_ROUTER_CONFIG.page_threshold}, "
        f"min_chapters={_ROUTER_CONFIG.min_chapters}, "
        f"min_imrad={_ROUTER_CONFIG.min_imrad}, detect_toc={_ROUTER_CONFIG.detect_toc})"
    )
else:
    from pipeline.scientific_chunker import ChunkerConfig, make_scientific_chunker
    CHUNKER_CONFIG = ChunkerConfig.from_env()
    _chunk_cache_path = STORAGE_DIR / "chunk_cache.json"
    _CHUNK_CACHE = None
    if _chunk_cache_path.exists():
        _CHUNK_CACHE = json.loads(_chunk_cache_path.read_text())
        print(f"[CACHE] Loaded {len(_CHUNK_CACHE)} pre-chunked docs from {_chunk_cache_path.name}")
    else:
        print(f"[CACHE] No chunk cache found — chunking will be computed live")
    SCIENTIFIC_CHUNKER = make_scientific_chunker(CHUNKER_CONFIG, chunk_cache=_CHUNK_CACHE)

# ── Chunker timeout (SIGALRM) ──────────────────────────────────────────────────
# Some docs trigger an infinite loop in the scientific chunker. SIGALRM is the
# only reliable way to interrupt synchronous Python blocking the event loop.
# On timeout, the offending PDF is moved to EXCLUDED_DIR and the doc fails cleanly.

CHUNK_TIMEOUT = int(os.environ.get("CHUNK_TIMEOUT", 600))  # seconds (default 10 min)
EXCLUDED_DIR  = WORKDIR / os.environ.get("EXCLUDED_SUBDIR", "papers_excluded_not_processed_9061176")

_current_pdf_path: Path | None = None


class ChunkingTimeoutError(RuntimeError):
    pass


def _sigalrm_handler(signum, frame):
    raise ChunkingTimeoutError(f"Chunker hung for >{CHUNK_TIMEOUT}s")


_raw_chunker = SCIENTIFIC_CHUNKER


def SCIENTIFIC_CHUNKER(  # noqa: N816 — shadow module-level name intentionally
    tokenizer,
    content,
    split_by_character=None,
    split_by_character_only=False,
    chunk_overlap_token_size=100,
    chunk_token_size=1200,
):
    old = signal.signal(signal.SIGALRM, _sigalrm_handler)
    signal.alarm(CHUNK_TIMEOUT)
    try:
        result = _raw_chunker(
            tokenizer,
            content,
            split_by_character,
            split_by_character_only,
            chunk_overlap_token_size,
            chunk_token_size,
        )
        signal.alarm(0)
        return result
    except ChunkingTimeoutError:
        signal.alarm(0)
        if _current_pdf_path is not None and _current_pdf_path.exists():
            EXCLUDED_DIR.mkdir(parents=True, exist_ok=True)
            dest = EXCLUDED_DIR / _current_pdf_path.name
            _current_pdf_path.rename(dest)
            print(f"[TIMEOUT] Chunker hung: moved {_current_pdf_path.name} → {EXCLUDED_DIR.name}/", flush=True)
        raise
    finally:
        signal.signal(signal.SIGALRM, old)

# ── Embedding ──────────────────────────────────────────────────────────────────

_embed_model = None


def get_embed_model():
    global _embed_model
    if _embed_model is None:
        import torch
        from sentence_transformers import SentenceTransformer
        model_kwargs = {"torch_dtype": getattr(torch, EMBED_TORCH_DTYPE)}
        print(f"Loading embedding model {EMBED_MODEL_ID} on {EMBED_DEVICE} ({EMBED_TORCH_DTYPE})…", flush=True)
        import os as _os
        from pathlib import Path as _Path
        _hub = _Path(_os.environ.get("HF_HOME", _os.path.expanduser("~/.cache/huggingface"))) / "hub" / f"models--{EMBED_MODEL_ID.replace('/', '--')}"
        _refs = _hub / "refs" / "main"
        if _refs.exists():
            _commit = _refs.read_text().strip()
            _local_path = str(_hub / "snapshots" / _commit)
            print(f"Loading embedding model from local snapshot: {_local_path}", flush=True)
            _embed_model = SentenceTransformer(_local_path, device=EMBED_DEVICE, model_kwargs=model_kwargs)
        else:
            _embed_model = SentenceTransformer(EMBED_MODEL_ID, device=EMBED_DEVICE, model_kwargs=model_kwargs)
        print("Embedding model ready.", flush=True)
    return _embed_model


_embed_stats = {"calls": 0, "total_s": 0.0, "texts": 0, "concurrent": 0, "max_concurrent": 0}

_http_client = None


def _get_http_client():
    """Lazily-created shared async HTTP client for the remote embedder (Fix 3)."""
    global _http_client
    if _http_client is None:
        import httpx
        _http_client = httpx.AsyncClient(
            timeout=float(os.environ.get("EMBED_HTTP_TIMEOUT", 300))
        )
    return _http_client


_llm_httpx_client = None


def _get_llm_httpx_client():
    """Single shared, pooled async HTTP client for ALL vLLM LLM calls.

    LightRAG's openai_complete_if_cache builds a fresh AsyncOpenAI (and underlying
    httpx client) per call and `await`s client.close() in its finally on every code
    path. That churns one TCP connection per LLM call into TIME_WAIT; at high
    concurrency it exhausts ephemeral ports and surfaces as
    RetryError[APIConnectionError] — the failures seen above MAX_PARALLEL_INSERT~16.
    Injecting ONE keep-alive pooled client (openai_client_configs={"http_client":...})
    reuses connections so the ingest can feed the vLLM's full ~73x capacity. aclose()
    is a no-op so LightRAG's per-call close() doesn't tear down the shared pool; it
    lives for the run (the process exit cleans it up).
    """
    global _llm_httpx_client
    if _llm_httpx_client is None:
        import httpx

        class _KeepAliveAsyncClient(httpx.AsyncClient):
            async def aclose(self):  # keep the shared pool alive across LLM calls
                return None

        _llm_httpx_client = _KeepAliveAsyncClient(
            limits=httpx.Limits(
                max_connections=int(os.environ.get("LLM_MAX_CONNECTIONS", 256)),
                max_keepalive_connections=int(os.environ.get("LLM_MAX_KEEPALIVE", 256)),
                keepalive_expiry=float(os.environ.get("LLM_KEEPALIVE_EXPIRY", 120)),
            ),
            timeout=httpx.Timeout(
                float(os.environ.get("LLM_HTTP_TIMEOUT", 300)),
                connect=float(os.environ.get("LLM_CONNECT_TIMEOUT", 30)),
            ),
        )
    return _llm_httpx_client


async def _remote_embed(texts: list[str], context: str) -> np.ndarray:
    """Fix 3: embed via an OpenAI-compatible server (scripts/server.py) on a
    dedicated GPU instead of loading the model in-process. Honors the server's
    task-aware `context` hook (queries get the instruction, documents don't)."""
    payload = {"input": texts, "model": EMBED_MODEL_ID, "context": context}
    url = EMBED_ENDPOINT.rstrip("/") + "/v1/embeddings"
    resp = await _get_http_client().post(url, json=payload)
    resp.raise_for_status()
    data = resp.json()["data"]
    # OpenAI-compatible responses carry a per-item index; preserve input order.
    data.sort(key=lambda d: d.get("index", 0))
    return np.array([d["embedding"] for d in data], dtype=np.float32)


async def local_embed(texts: list[str], context: str = "document") -> np.ndarray:
    # Task-aware: queries get the Qwen3 instruction, documents get none. LightRAG
    # passes context="query"/"document" because EmbeddingFunc(supports_asymmetric=True).
    # During ingest/rebuild this is always "document" (chunks, entity/relation
    # descriptions); honored explicitly so the function is correct in any context.
    loop = asyncio.get_event_loop()
    _embed_stats["concurrent"] += 1
    if _embed_stats["concurrent"] > _embed_stats["max_concurrent"]:
        _embed_stats["max_concurrent"] = _embed_stats["concurrent"]
    t0 = time.time()
    try:
        if EMBED_ENDPOINT:
            embeddings = await _remote_embed(texts, context)
        else:
            # Fix 2d: use a dedicated executor so embedding never contends with
            # blocking IO (PDF reads, doc-status polling) on the default pool.
            model = get_embed_model()
            prompt = QUERY_PROMPT if context == "query" else None
            embeddings = await loop.run_in_executor(
                _EMBED_EXECUTOR,
                lambda: model.encode(
                    texts,
                    prompt=prompt,
                    normalize_embeddings=True,
                    batch_size=EMBED_BATCH,
                    show_progress_bar=False,
                ),
            )
    finally:
        _embed_stats["concurrent"] -= 1
    elapsed = time.time() - t0
    _embed_stats["calls"] += 1
    _embed_stats["total_s"] += elapsed
    _embed_stats["texts"] += len(texts)
    return np.array(embeddings)


# Column-aware extraction tunables (calibrated in scripts/audit_ocr.py over the
# full Westbury corpus; see docs and the OCR-audit memory).
_COL_GUTTER_BAND = (0.42, 0.58)   # central width fraction to look for a gutter
_COL_MIN_GUTTER_FRAC = 0.035      # gutter gap must exceed this fraction of width
_COL_MAX_STRADDLE = 0.030         # frac of words crossing the gutter -> 1-column
_COL_MIN_PAGE_WORDS = 40          # below this, trust the native extractor
_COL_MIN_SIDE_WORDS = 15          # each column needs this many words


def _detect_gutter(centers: list[float], width: float):
    """Return the x of the central whitespace gutter of a 2-column page, or None."""
    lo, hi = _COL_GUTTER_BAND[0] * width, _COL_GUTTER_BAND[1] * width
    cs = sorted(centers)
    best, gutter = 0.0, None
    for a, b in zip(cs, cs[1:]):
        if a < lo or b > hi:
            continue
        if b - a > best:
            best, gutter = b - a, (a + b) / 2
    if gutter is None or best < _COL_MIN_GUTTER_FRAC * width:
        return None
    return gutter


def _words_to_lines(words: list) -> list[str]:
    """words: (x0,y0,x1,y1,text,...). Group into visual lines (top->bottom),
    words left->right within a line; one line-string per line (newline-joinable)."""
    ws = sorted(words, key=lambda w: (w[1], w[0]))
    heights = sorted(w[3] - w[1] for w in ws)
    h = heights[len(heights) // 2] or 8.0
    tol = max(h * 0.6, 3.0)
    lines, cur, cur_y = [], [ws[0]], ws[0][1]
    for w in ws[1:]:
        if abs(w[1] - cur_y) > tol:
            lines.append(cur)
            cur, cur_y = [], w[1]
        cur.append(w)
    lines.append(cur)
    return [" ".join(w[4] for w in sorted(ln, key=lambda w: w[0])) for ln in lines]


_LINENO_MIN_COL = 8           # isolated marginal integers needed to call it a line-number column
_LINENO_MARGIN_FRAC = 0.15    # cluster center must sit within this fraction of either page edge


def _strip_line_number_column(words, W):
    """Drop a marginal column of manuscript line numbers without touching inline
    numbers. Detect the COLUMN, never judge a number by its value: a line number is
    an integer that is the only word on its text line; when >= _LINENO_MIN_COL such
    integers cluster tightly at a near-constant marginal x with values increasing
    down the page, that whole column is line numbering. Inline numbers ('value 17',
    'R2 = 0.92') share their line with words and are never matched. Returns
    (filtered_words, n_dropped)."""
    counts = {}
    for w in words:
        k = (w[5], w[6])                         # (block, line) per PyMuPDF word
        counts[k] = counts.get(k, 0) + 1
    isolated = [w for w in words if w[4].isdigit() and counts[(w[5], w[6])] == 1]
    if len(isolated) < _LINENO_MIN_COL:
        return words, 0
    isolated.sort(key=lambda w: (w[0] + w[2]) / 2)
    clusters, cur = [], [isolated[0]]            # greedily group by x-center (within 20pt)
    for w in isolated[1:]:
        if (w[0] + w[2]) / 2 - (cur[-1][0] + cur[-1][2]) / 2 <= 20:
            cur.append(w)
        else:
            clusters.append(cur)
            cur = [w]
    clusters.append(cur)
    drop = set()
    for members in clusters:
        if len(members) < _LINENO_MIN_COL:
            continue
        cx = sum((m[0] + m[2]) / 2 for m in members) / len(members)
        if not (cx < _LINENO_MARGIN_FRAC * W or cx > (1 - _LINENO_MARGIN_FRAC) * W):
            continue                             # not at a margin -> not line numbers
        seq = [int(m[4]) for m in sorted(members, key=lambda m: m[1])]   # ordered top→bottom
        if sum(b >= a for a, b in zip(seq, seq[1:])) >= 0.7 * (len(seq) - 1):  # mostly increasing
            drop.update(id(m) for m in members)
    if not drop:
        return words, 0
    return [w for w in words if id(w) not in drop], len(drop)


def _page_text_columnaware(page) -> str:
    """One page → text in correct reading order. Native extraction for single-
    column pages; for a confidently-detected 2-column page, emit the whole left
    column then the whole right column (the across-columns jumble that pypdf's
    extractor introduces). Line breaks are preserved so the chunker can still
    strip running heads / detect section headings."""
    W = page.rect.width
    words = [w for w in page.get_text("words") if w[4].strip()]
    if W <= 0 or len(words) < _COL_MIN_PAGE_WORDS:
        return page.get_text("text")
    words, n_lineno = _strip_line_number_column(words, W)  # drop marginal line-number column
    gutter = _detect_gutter([(w[0] + w[2]) / 2 for w in words], W)
    if gutter is not None:
        straddle = sum(1 for w in words if w[0] < gutter < w[2]) / len(words)
        if straddle <= _COL_MAX_STRADDLE:
            left = [w for w in words if (w[0] + w[2]) / 2 < gutter]
            right = [w for w in words if (w[0] + w[2]) / 2 >= gutter]
            if len(left) >= _COL_MIN_SIDE_WORDS and len(right) >= _COL_MIN_SIDE_WORDS:
                return "\n".join(_words_to_lines(left) + _words_to_lines(right))
    if n_lineno:  # stripped line numbers -> rebuild from filtered words (native get_text keeps them)
        return "\n".join(_words_to_lines(words))
    return page.get_text("text")  # single-column / unconfident: native order


# Visibility for the PyMuPDF→pypdf fallback. pypdf emits glyph-name artifacts
# (/uniFB01) and mojibake, so a SILENT fallback quietly corrupts chunks. Probe fitz
# once at import (a missing module degrades the entire run) and warn+count per file.
try:
    import fitz as _fitz_probe  # noqa: F401
    del _fitz_probe
except Exception:
    print("[extract] CRITICAL: PyMuPDF (fitz) is not importable — every PDF will use "
          "the pypdf fallback, which produces /uniFB01 glyph names and mojibake. "
          "Install pymupdf in the ingest env before running.", flush=True)
_PYPDF_FALLBACKS = 0


def _extract_pdf_text(pdf_path: Path) -> str:
    """Synchronous PDF → text (page boundaries preserved as form-feeds for the
    chunker). CPU-bound and pure-Python, so callers run it in _IO_EXECUTOR (Fix 2a)
    to keep it off the event loop.

    Primary path is PyMuPDF with column-aware reading order: pypdf's
    extract_text interleaves the two columns of many 2-column papers (the
    across-columns "jumble"), corrupting every downstream chunk. PyMuPDF reads
    columns correctly and also recovers text from files pypdf chokes on. Falls
    back to pypdf if PyMuPDF is unavailable, so ingest never hard-fails on it."""
    global _PYPDF_FALLBACKS
    text = None
    try:
        import fitz  # PyMuPDF

        with fitz.open(str(pdf_path)) as doc:
            page_texts = [_page_text_columnaware(p).strip() for p in doc]
        text = "\n\f\n".join(p for p in page_texts if p).strip()
    except Exception as exc:
        text = None  # fall through to pypdf
        _PYPDF_FALLBACKS += 1
        print(f"[extract] WARNING: PyMuPDF failed on {pdf_path.name} "
              f"({type(exc).__name__}: {exc}); using pypdf fallback — expect "
              f"/uniFB01 glyph names / mojibake [pypdf fallback #{_PYPDF_FALLBACKS}]",
              flush=True)

    if not text:
        from pypdf import PdfReader

        reader = PdfReader(str(pdf_path))
        page_texts = [(page.extract_text() or "").strip() for page in reader.pages]
        text = "\n\f\n".join(page for page in page_texts if page).strip()

    text = text.replace("<|endofprompt|>", "")
    # Drop C0 control characters (e.g. \x03 that some odd title-page fonts emit)
    # but keep \t \n \r and the \f page separator the chunker relies on.
    text = re.sub(r"[\x00-\x08\x0b\x0e-\x1f]", "", text)
    # Strip unpaired Unicode surrogates (e.g. \ud835 from mathematical-alphanumeric
    # glyphs that some PDFs extract as lone surrogates). They are the only code
    # points UTF-8 cannot encode, so leaving them in crashes the md5 doc_id,
    # apipeline_enqueue, embedding, and JSON KV writes downstream. "ignore" drops
    # only those surrogates and preserves all real text.
    return text.encode("utf-8", "ignore").decode("utf-8")


# ── Endpoint Discovery & Validation (1A) ──────────────────────────────────────

def _health_check(endpoint_url: str, timeout: float = 10.0) -> bool:
    """Check if a vLLM endpoint is alive via GET /health."""
    import urllib.request
    import urllib.error
    # endpoint_url is like http://host:port/v1 — health is at /health
    health_url = endpoint_url.rstrip("/").replace("/v1", "") + "/health"
    try:
        req = urllib.request.Request(health_url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def _is_slurm_job_running(job_id: str) -> bool:
    """Check if a SLURM job ID is still active via squeue."""
    try:
        result = subprocess.run(
            ["squeue", "--job", job_id, "--noheader", "-o", "%T"],
            capture_output=True, text=True, timeout=10,
        )
        state = result.stdout.strip()
        return state in ("RUNNING", "PENDING", "CONFIGURING")
    except Exception:
        # If squeue is unavailable, assume job is running (don't delete)
        return True


def _validate_endpoint_file(filepath: Path) -> str | None:
    """
    Validate a single endpoint file. Returns the endpoint URL if valid,
    or None if stale (and deletes the file).
    """
    endpoint = filepath.read_text().strip()
    if not endpoint:
        print(f"  [STALE] Empty endpoint file: {filepath.name} — deleting", flush=True)
        filepath.unlink(missing_ok=True)
        return None

    # Extract SLURM job ID from filename (e.g., "28818145.txt")
    job_id = filepath.stem

    # Check 1: Is the SLURM job still running?
    if not _is_slurm_job_running(job_id):
        print(f"  [STALE] Job {job_id} not in squeue — deleting {filepath.name}", flush=True)
        filepath.unlink(missing_ok=True)
        return None

    # Check 2: Does the endpoint respond to health check?
    if not _health_check(endpoint):
        print(f"  [STALE] {endpoint} failed health check — deleting {filepath.name}", flush=True)
        filepath.unlink(missing_ok=True)
        return None

    return endpoint


def discover_endpoints(timeout_s: int = 10800) -> list[str]:
    """Discover and validate vLLM endpoints. Deletes stale endpoint files."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        files = sorted(ENDPOINTS_DIR.glob("*.txt"))
        endpoints = []
        for f in files:
            ep = _validate_endpoint_file(f)
            if ep:
                endpoints.append(ep)

        if len(endpoints) >= N_VLLM:
            print(f"Discovered {len(endpoints)} validated vLLM endpoint(s):")
            for ep in endpoints:
                print(f"  {ep}")
            return endpoints
        print(f"  waiting for valid endpoints ({len(endpoints)}/{N_VLLM})…", flush=True)
        time.sleep(15)

    # Timeout — try with whatever we have
    files = sorted(ENDPOINTS_DIR.glob("*.txt"))
    endpoints = []
    for f in files:
        ep = _validate_endpoint_file(f)
        if ep:
            endpoints.append(ep)
    if not endpoints:
        print("ERROR: No valid vLLM endpoints discovered. Exiting.")
        sys.exit(1)
    print(f"WARNING: Timed out. Proceeding with {len(endpoints)} validated endpoint(s).")
    return endpoints


# ── LLM with Retry & Failover (3B) ────────────────────────────────────────────

# Mutable shared state for endpoint management
_live_endpoints: list[str] = []
_endpoint_lock = asyncio.Lock()


_llm_stats = {"calls": 0, "total_s": 0.0}


def build_round_robin_llm(endpoints: list[str]):
    """Build an LLM function with retry, exponential backoff, and endpoint failover."""
    from lightrag.llm.openai import openai_complete_if_cache

    _live_endpoints.clear()
    _live_endpoints.extend(endpoints)
    cycle = itertools.cycle(range(1_000_000))  # index counter

    async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
        if history_messages is None:
            history_messages = []

        # Fix 2c: the per-call debug prints are hundreds of flush=True writes/sec at
        # high LLM_MAX_ASYNC and throttle the event loop — gate them behind LLM_DEBUG.
        prompt_len = len(prompt)
        if LLM_DEBUG:
            kw_keys = [k for k in kwargs if k != "hashing_kv"]
            print(f"[LLM_DEBUG] llm_func called: prompt_len={prompt_len} chars, extra_kwargs={kw_keys}", flush=True)

        last_error = None
        for attempt in range(3):
            async with _endpoint_lock:
                if not _live_endpoints:
                    # All endpoints dead — try re-discovery
                    print("[FAILOVER] All endpoints exhausted, re-discovering…", flush=True)
                    new_eps = discover_endpoints(timeout_s=300)
                    _live_endpoints.extend(new_eps)
                idx = next(cycle) % len(_live_endpoints)
                endpoint = _live_endpoints[idx]

            try:
                if LLM_DEBUG:
                    print(f"[LLM_DEBUG] attempt={attempt+1} sending to {endpoint} prompt_len={prompt_len}", flush=True)
                t0 = time.time()
                result = await openai_complete_if_cache(
                    LLM_MODEL, "/no_think\n" + prompt,
                    system_prompt=system_prompt,
                    history_messages=history_messages,
                    api_key=LLM_API_KEY,
                    base_url=endpoint,
                    timeout=300,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                    openai_client_configs={"http_client": _get_llm_httpx_client()},
                    **kwargs,
                )
                elapsed_llm = time.time() - t0
                _llm_stats["calls"] += 1
                _llm_stats["total_s"] += elapsed_llm
                if LLM_DEBUG:
                    print(f"[LLM_DEBUG] SUCCESS in {elapsed_llm:.1f}s, result_len={len(str(result))}", flush=True)
                return result
            except (ConnectionError, OSError) as e:
                last_error = e
                print(f"[RETRY {attempt+1}/3] {endpoint} — {type(e).__name__}: {e}", flush=True)
                # Remove dead endpoint
                async with _endpoint_lock:
                    if endpoint in _live_endpoints:
                        _live_endpoints.remove(endpoint)
                        print(f"[FAILOVER] Removed {endpoint} ({len(_live_endpoints)} remaining)", flush=True)
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)  # 1s, 2s
            except Exception as e:
                # Non-connection errors (token limit, etc.) — don't retry
                print(f"[LLM_DEBUG] EXCEPTION {type(e).__name__}: {str(e)[:200]}", flush=True)
                raise

        raise last_error or RuntimeError("All LLM retry attempts failed")

    return llm_func


# ── Token Truncation ───────────────────────────────────────────────────────────

def truncate_to_tokens(text: str, max_tokens: int) -> tuple[str, bool]:
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        tokens = enc.encode(text)
        if len(tokens) <= max_tokens:
            return text, False
        return enc.decode(tokens[:max_tokens]), True
    except Exception:
        limit = max_tokens * 4
        if len(text) <= limit:
            return text, False
        return text[:limit], True


def cap_context_document(text: str) -> tuple[str, bool]:
    """Apply MAX_DOC_TOKENS only to contextualization document prompts."""
    if MAX_DOC_TOKENS <= 0:
        return text, False
    return truncate_to_tokens(text, MAX_DOC_TOKENS)


# ── Live Status Monitor (1C) ──────────────────────────────────────────────────

async def status_monitor(storage_dir: Path, t_start: float):
    """Background task that prints real extraction status and bottleneck stats every 30s."""
    status_path = storage_dir / "kv_store_doc_status.json"
    last_processed = 0
    last_llm_calls = 0
    last_embed_calls = 0
    last_check_time = t_start
    INTERVAL = 30
    while True:
        await asyncio.sleep(INTERVAL)
        try:
            if not status_path.exists():
                continue
            now = time.time()
            raw = await asyncio.get_event_loop().run_in_executor(
                _IO_EXECUTOR, status_path.read_text
            )
            data = json.loads(raw)
            counts = {}
            for k, v in data.items():
                if not k.startswith("doc-"):
                    continue
                s = v.get("status", "unknown")
                counts[s] = counts.get(s, 0) + 1

            processed = counts.get("processed", 0)
            processing = counts.get("processing", 0)
            pending = counts.get("pending", 0)
            failed = counts.get("failed", 0)
            elapsed_h = (now - t_start) / 3600
            interval_h = (now - last_check_time) / 3600

            # Rate: overall and delta (last interval)
            overall_rate = processed / elapsed_h if elapsed_h > 0 else 0
            delta_docs = processed - last_processed
            delta_rate = delta_docs / interval_h if interval_h > 0 else 0

            # LLM stats
            llm_calls = _llm_stats["calls"]
            llm_total_s = _llm_stats["total_s"]
            delta_llm = llm_calls - last_llm_calls
            avg_llm_s = llm_total_s / llm_calls if llm_calls > 0 else 0

            # Embed stats
            embed_calls = _embed_stats["calls"]
            embed_total_s = _embed_stats["total_s"]
            embed_texts = _embed_stats["texts"]
            delta_embed = embed_calls - last_embed_calls
            avg_embed_s = embed_total_s / embed_calls if embed_calls > 0 else 0
            avg_batch = embed_texts / embed_calls if embed_calls > 0 else 0

            print(
                f"[STATUS] processed={processed} (+{delta_docs}) | processing={processing} | "
                f"pending={pending} | failed={failed} | "
                f"rate={delta_rate:.0f}/hr (overall={overall_rate:.0f}/hr)",
                flush=True,
            )
            print(
                f"[STATUS] LLM: {llm_calls} calls (+{delta_llm}) avg={avg_llm_s:.1f}s/call | "
                f"Embed: {embed_calls} calls (+{delta_embed}) avg={avg_embed_s:.1f}s/call "
                f"batch={avg_batch:.0f} max_concurrent={_embed_stats['max_concurrent']}",
                flush=True,
            )

            last_processed = processed
            last_llm_calls = llm_calls
            last_embed_calls = embed_calls
            last_check_time = now
        except Exception:
            pass  # Don't crash on monitor errors


# ── Rebuild Embeddings from Cache (4) ─────────────────────────────────────────

async def rebuild_embeddings_from_cache():
    """
    Rebuild vector DBs from existing KV stores and graph. No LLM calls.

    Reads contextualized chunks from kv_store_text_chunks.json and
    entity/relation data from graph_chunk_entity_relation.graphml,
    then recomputes embeddings and inserts into the configured vector DB.

    Use when switching embedding models or vector DB backends without
    re-running the entire extraction pipeline.
    """
    import networkx as nx
    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc, compute_mdhash_id

    print("=" * 60)
    print("REBUILD EMBEDDINGS MODE")
    print("Reading cached intermediates — no LLM calls will be made.")
    print("=" * 60)

    STORAGE_DIR.mkdir(parents=True, exist_ok=True)

    # ── Verify cached intermediates exist ──
    chunks_path = STORAGE_DIR / "kv_store_text_chunks.json"
    graph_path = STORAGE_DIR / "graph_chunk_entity_relation.graphml"

    missing = []
    if not chunks_path.exists():
        missing.append(str(chunks_path))
    if not graph_path.exists():
        missing.append(str(graph_path))
    if missing:
        print("ERROR: Cannot rebuild — missing cached intermediates:")
        for m in missing:
            print(f"  {m}")
        print("Run a full ingestion first to populate the cache.")
        sys.exit(1)

    t_start = time.time()

    # ── Load cached data ──
    print("\nLoading cached intermediates...")
    chunks = json.loads(chunks_path.read_text())
    print(f"  Text chunks: {len(chunks)}")

    graph = nx.read_graphml(str(graph_path))
    n_entities = graph.number_of_nodes()
    n_relations = graph.number_of_edges()
    print(f"  Entities:    {n_entities}")
    print(f"  Relations:   {n_relations}")

    # ── Clear old vector DB data ──
    print("\nClearing old vector DB data...")
    for f in STORAGE_DIR.glob("vdb_*.json"):
        f.unlink()
        print(f"  Removed: {f.name}")

    # ── Pre-load embedding model (skip when served remotely — Fix 3) ──
    if not EMBED_ENDPOINT:
        get_embed_model()

    # ── Initialize LightRAG (embedding only, no LLM) ──
    async def _dummy_llm(*args, **kwargs):
        raise RuntimeError("LLM should not be called during REBUILD_EMBEDDINGS")

    os.environ.pop("ENTITY_TYPES", None)  # deprecated in LightRAG >=1.5 (see main ingest path)
    rag_kwargs = dict(
        working_dir=str(STORAGE_DIR),
        llm_model_func=_dummy_llm,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=8192,
            func=local_embed,
            supports_asymmetric=True,  # forward context="query"/"document"
        ),
        embedding_func_max_async=EMBED_FUNC_MAX_ASYNC,
        embedding_batch_num=EMBEDDING_BATCH_NUM,
        # The rebuild's final _insert_done flush embeds one large aggregate batch
        # (a 100k+ relation flush measured ~425s); LightRAG's default 75s per-task
        # embedding timeout is far too short and silently drops the whole collection
        # (relationships persisted = 0). Give the flush generous headroom.
        default_embedding_timeout=int(os.environ.get("EMBED_TIMEOUT", 1800)),
    )
    if USE_QDRANT:
        rag_kwargs["vector_storage"] = "QdrantVectorDBStorage"
        print(f"\nTarget vector DB: Qdrant ({QDRANT_URL})")
    else:
        print("\nTarget vector DB: NanoVectorDB")

    rag = LightRAG(**rag_kwargs)
    await rag.initialize_storages()

    def _get_existing_ids(vdb) -> set:
        """Scroll a Qdrant collection and return the set of stored item IDs."""
        if not USE_QDRANT:
            return set()
        existing = set()
        offset = None
        while True:
            points, next_offset = vdb._client.scroll(
                collection_name=vdb.final_namespace,
                scroll_filter=None,
                limit=1000,
                offset=offset,
                with_payload=["id"],
                with_vectors=False,
            )
            for pt in points:
                if pt.payload and "id" in pt.payload:
                    existing.add(pt.payload["id"])
            if next_offset is None:
                break
            offset = next_offset
        return existing

    # ── Rebuild chunk embeddings ──
    print(f"\nRebuilding chunk embeddings ({len(chunks)} chunks, batch={REBUILD_BATCH_SIZE})...")
    existing_ids = _get_existing_ids(rag.chunks_vdb)
    print(f"  Already embedded: {len(existing_ids)} — skipping")
    batch = {}
    done = len(existing_ids)
    embedded = 0
    for chunk_id, chunk_data in chunks.items():
        if chunk_id in existing_ids:
            continue
        batch[chunk_id] = {
            "content": chunk_data.get("content", ""),
            "full_doc_id": chunk_data.get("full_doc_id", ""),
            "file_path": chunk_data.get("file_path", ""),
        }
        if len(batch) >= REBUILD_BATCH_SIZE:
            await rag.chunks_vdb.upsert(batch)
            done += len(batch)
            embedded += len(batch)
            batch = {}
            elapsed = time.time() - t_start
            rate = embedded / (elapsed / 60) if elapsed > 0 else 0
            print(f"  Chunks: {done}/{len(chunks)} ({rate:.0f}/min)", flush=True)
    if batch:
        await rag.chunks_vdb.upsert(batch)
        done += len(batch)
        embedded += len(batch)
    print(f"  Chunks: {done}/{len(chunks)} done ({embedded} newly embedded)")

    # ── Rebuild entity embeddings ──
    print(f"\nRebuilding entity embeddings ({n_entities} entities, batch={REBUILD_BATCH_SIZE})...")
    existing_ids = _get_existing_ids(rag.entities_vdb)
    print(f"  Already embedded: {len(existing_ids)} — skipping")
    batch = {}
    done = len(existing_ids)
    embedded = 0
    for node_name, node_data in graph.nodes(data=True):
        description = node_data.get("description", "")
        entity_vdb_id = compute_mdhash_id(node_name, prefix="ent-")
        if entity_vdb_id in existing_ids:
            continue
        batch[entity_vdb_id] = {
            "content": f"{node_name}\n{description}",
            "entity_name": node_name,
            "source_id": node_data.get("source_id", ""),
            "description": description,
            "entity_type": node_data.get("entity_type", ""),
            "file_path": node_data.get("file_path", ""),
        }
        if len(batch) >= REBUILD_BATCH_SIZE:
            await rag.entities_vdb.upsert(batch)
            done += len(batch)
            embedded += len(batch)
            batch = {}
            elapsed = time.time() - t_start
            rate = embedded / (elapsed / 60) if elapsed > 0 else 0
            print(f"  Entities: {done}/{n_entities} ({rate:.0f}/min)", flush=True)
    if batch:
        await rag.entities_vdb.upsert(batch)
        done += len(batch)
        embedded += len(batch)
    print(f"  Entities: {done}/{n_entities} done ({embedded} newly embedded)")

    # ── Rebuild relation embeddings ──
    print(f"\nRebuilding relation embeddings ({n_relations} relations, batch={REBUILD_BATCH_SIZE})...")
    existing_ids = _get_existing_ids(rag.relationships_vdb)
    print(f"  Already embedded: {len(existing_ids)} — skipping")
    batch = {}
    done = len(existing_ids)
    embedded = 0
    for src, tgt, edge_data in graph.edges(data=True):
        keywords = edge_data.get("keywords", "")
        description = edge_data.get("description", "")
        rel_vdb_id = compute_mdhash_id(f"{src}_{tgt}", prefix="rel-")
        if rel_vdb_id in existing_ids:
            continue
        batch[rel_vdb_id] = {
            "src_id": src,
            "tgt_id": tgt,
            "source_id": edge_data.get("source_id", ""),
            "content": f"{keywords}\t{src}\n{tgt}\n{description}",
            "keywords": keywords,
            "description": description,
            "weight": float(edge_data.get("weight", 1.0)),
            "file_path": edge_data.get("file_path", ""),
        }
        if len(batch) >= REBUILD_BATCH_SIZE:
            await rag.relationships_vdb.upsert(batch)
            done += len(batch)
            embedded += len(batch)
            batch = {}
            elapsed = time.time() - t_start
            rate = embedded / (elapsed / 60) if elapsed > 0 else 0
            print(f"  Relations: {done}/{n_relations} ({rate:.0f}/min)", flush=True)
    if batch:
        await rag.relationships_vdb.upsert(batch)
        done += len(batch)
        embedded += len(batch)
    print(f"  Relations: {done}/{n_relations} done ({embedded} newly embedded)")

    # ── Flush and finalize ──
    await rag._insert_done()
    await rag.finalize_storages()

    elapsed = time.time() - t_start
    total = len(chunks) + n_entities + n_relations
    print(f"\n{'='*60}")
    print(f"Rebuild complete in {elapsed/60:.1f} min")
    print(f"  Chunks:    {len(chunks)}")
    print(f"  Entities:  {n_entities}")
    print(f"  Relations: {n_relations}")
    print(f"  Total embeddings: {total}")
    if elapsed > 0:
        print(f"  Rate: {total/(elapsed/60):.0f} embeddings/min")
    print(f"  Embed model: {EMBED_MODEL_ID}")
    print(f"  Vector DB:   {'Qdrant' if USE_QDRANT else 'NanoVectorDB'}")


# ── Native multimodal ingest (VLM figures/tables/equations) ────────────────────

async def ingest_native_multimodal(rag, papers):
    """Ingest every PDF through LightRAG's native multimodal pipeline.

    Unlike the text-only path (per-doc ``ainsert`` + status poll), this enqueues
    each PDF as ``docs_format="pending_parse"`` and then drains the queue once.
    LightRAG drives the full chain per document: parse (MinerU/Docling extracts
    figures/tables/equations into sidecars) → ``vlm`` role captions them →
    ``chunking_func`` (our scientific chunker + contextualization wrapper) runs on
    the parser's full text → entity/relation extraction → embed. The parser is
    selected by ``PARSE_ENGINE`` and reached via env vars LightRAG reads directly
    (MINERU_* / DOCLING_ENDPOINT).

    Resume is handled by LightRAG: the enqueue path dedups documents already known
    in doc-status, so re-running skips processed PDFs without the md5(text)→doc_id
    precompute the text path uses (here we never read the text before parsing).
    """
    enqueued = 0
    for pdf in papers:
        try:
            await rag.apipeline_enqueue_documents(
                input="",                      # content comes from the parser
                file_paths=str(pdf),
                docs_format="pending_parse",
                parse_engine=PARSE_ENGINE,
                process_options=PROCESS_OPTIONS,
            )
            enqueued += 1
        except Exception as e:  # noqa: BLE001 — one bad PDF must not abort the batch
            print(f"[VLM] enqueue failed: {pdf.name[:55]} — {type(e).__name__}: {e}", flush=True)
    print(
        f"[VLM] Enqueued {enqueued}/{len(papers)} PDFs "
        f"(engine={PARSE_ENGINE}, options={PROCESS_OPTIONS}); draining pipeline…",
        flush=True,
    )
    # Drives parse → VLM caption → chunk → contextualize → extract → embed for the
    # whole queue, with LightRAG's own concurrency (MAX_PARALLEL_INSERT etc.).
    await rag.apipeline_process_enqueue_documents()
    print("[VLM] Pipeline drained.", flush=True)


async def ingest_streaming_text(rag, papers, known_doc_ids, enqueued_files=None):
    """Fix 4: stream the text path through LightRAG's native pipeline.

    Instead of per-doc ``ainsert()`` + a per-doc poll loop (each task re-reading the
    whole growing ``doc_status.json`` every 5 s), read/extract PDFs concurrently in a
    dedicated IO thread pool, enqueue each as a RAW doc, then drain the pipeline ONCE.
    LightRAG then streams documents through its parse/extract/merge workers at full
    ``max_parallel_insert`` concurrency. This uses only LightRAG's public API
    (``apipeline_enqueue_documents`` + ``apipeline_process_enqueue_documents``) — the
    same pattern as the VLM path — so the nested LightRAG/ stays patch-free.

    Resume/skip: we keep the text-path ``md5(text) → doc_id`` precompute and the
    ``known_doc_ids`` filter; LightRAG also dedups by id on enqueue.

    Note: unlike the legacy path this does not set the global ``_current_pdf_path``,
    so the SIGALRM chunk-timeout still fails a hung document cleanly but no longer
    moves the offending PDF aside (the producer no longer knows which PDF is being
    chunked at drain time). This matches the VLM path's behavior.

    Returns ``(enqueued, skipped)``.
    """
    loop = asyncio.get_event_loop()
    read_sem = asyncio.Semaphore(PARALLEL_DOCS)  # bound concurrent PDF reads
    enqueued = skipped = 0
    # Enqueue in BATCHES, not per-doc. apipeline_enqueue_documents rewrites the whole
    # (growing) full_docs/doc_status JSON once per call; calling it per-doc over a large
    # corpus is O(N²) in bytes written and stalls the run for hours before the drain
    # ever starts. Reading concurrently and enqueuing a list per call makes it O(N):
    # one flush per batch instead of one per document.
    ENQUEUE_BATCH = int(os.environ.get("ENQUEUE_BATCH", 512))
    _enqueued_names = enqueued_files or set()  # resume-skip: filenames already enqueued

    async def _read_one(pdf: Path):
        """Return (doc_id, text, path) for a new doc, or None to skip."""
        if pdf.name in _enqueued_names:
            return None  # resume-skip: already enqueued in a prior run — don't re-read the PDF
        async with read_sem:
            try:
                text = await loop.run_in_executor(_IO_EXECUTOR, _extract_pdf_text, pdf)
            except Exception as e:  # noqa: BLE001 — one bad PDF must not abort the batch
                print(f"  {pdf.name[:55]} [read failed]  {e}", flush=True)
                return None
        if not text:
            return None
        doc_id = "doc-" + hashlib.md5(text.encode("utf-8")).hexdigest()
        if doc_id in known_doc_ids:
            return None  # already processed in a prior run (resume)
        return (doc_id, text, str(pdf))

    print(
        f"Reading + enqueuing {len(papers)} PDFs "
        f"(read concurrency={PARALLEL_DOCS}, enqueue batch={ENQUEUE_BATCH})…",
        flush=True,
    )
    seen_ids = set()  # doc_ids enqueued this run — dedup text-identical PDFs
    for bstart in range(0, len(papers), ENQUEUE_BATCH):
        batch = papers[bstart:bstart + ENQUEUE_BATCH]
        reads = await asyncio.gather(*[_read_one(p) for p in batch])
        # Dedup within the run: two PDFs with identical extracted text yield the same
        # md5 doc_id; passing duplicate ids to apipeline_enqueue_documents raises
        # "IDs must be unique" and drops the whole batch. Keep the first, skip the rest.
        valid = []
        for r in reads:
            if r is None or r[0] in seen_ids:
                continue
            seen_ids.add(r[0])
            valid.append(r)
        skipped += len(batch) - len(valid)
        if valid:
            try:
                await rag.apipeline_enqueue_documents(
                    [t for _, t, _ in valid],
                    ids=[d for d, _, _ in valid],
                    file_paths=[p for _, _, p in valid],
                )
                enqueued += len(valid)
            except Exception as e:  # noqa: BLE001 — a bad batch must not abort the run
                # Fall back to per-doc enqueue so one bad doc can't drop the whole batch.
                print(f"  [batch @{bstart} failed: {type(e).__name__}: {e}; retrying per-doc]", flush=True)
                for d, t, p in valid:
                    try:
                        await rag.apipeline_enqueue_documents(t, ids=d, file_paths=p)
                        enqueued += 1
                    except Exception as e2:  # noqa: BLE001
                        print(f"    {Path(p).name[:50]} [enqueue failed] {e2}", flush=True)
                        skipped += 1
        print(
            f"  read {min(bstart + ENQUEUE_BATCH, len(papers))}/{len(papers)} "
            f"(enqueued={enqueued}, skipped={skipped})",
            flush=True,
        )

    print(
        f"Enqueued {enqueued} new doc(s) ({skipped} skipped). Draining pipeline "
        f"(MAX_PARALLEL_INSERT={MAX_PARALLEL_INSERT})…",
        flush=True,
    )
    # Single drain: this call becomes the pipeline driver and processes the whole
    # queue at MAX_PARALLEL_INSERT concurrency, returning when fully drained.
    await rag.apipeline_process_enqueue_documents()
    print("Pipeline drained.", flush=True)
    return enqueued, skipped


# ── Main ───────────────────────────────────────────────────────────────────────

def _verify_chunk_method(doc_status_path: Path) -> None:
    """Post-ingest guard: warn if any *processed* document was chunked by a
    built-in LightRAG chunker instead of the AP-RAG custom one.

    With no F/R/V/P selector in process_options, the upstream pipeline records
    ``metadata.chunk_method == "legacy_chunking_func"`` (our chunking_func ran).
    Any other value (e.g. ``"fixed_token"``) means the custom chunker was
    bypassed — a silent regression worth shouting about. Docs predating the
    chunk_method metadata field carry no value and are skipped."""
    if not doc_status_path.exists():
        return
    try:
        data = json.loads(doc_status_path.read_text())
    except Exception:
        return
    custom = 0
    bypassed: dict[str, int] = {}
    for k, v in data.items():
        if not k.startswith("doc-") or not isinstance(v, dict):
            continue
        if v.get("status") != "processed":
            continue
        method = (v.get("metadata") or {}).get("chunk_method")
        if method is None:
            continue  # pre-dates chunk_method metadata — can't tell
        if method == "legacy_chunking_func":
            custom += 1
        else:
            bypassed[method] = bypassed.get(method, 0) + 1
    if bypassed:
        n = sum(bypassed.values())
        print(
            f"\n⚠️  [CHUNKER GUARD] {n} processed doc(s) were chunked by a BUILT-IN "
            f"LightRAG chunker, NOT the AP-RAG custom chunker: {bypassed}",
            flush=True,
        )
        print(
            "    The structure-aware chunker was bypassed. Verify process_options "
            "names no F/R/V/P selector and that chunking_func is wired.",
            flush=True,
        )
    elif custom:
        print(
            f"[CHUNKER GUARD] OK — all {custom} processed doc(s) used the custom "
            f"chunker (chunk_method=legacy_chunking_func).",
            flush=True,
        )


async def main():
    # ── Rebuild mode: skip full pipeline, only recompute embeddings ──
    if REBUILD_EMBEDDINGS:
        await rebuild_embeddings_from_cache()
        return

    # ── Guard: the custom chunker must not be silently bypassed ──
    # LightRAG only invokes our injected chunking_func when process_options names
    # NO chunking selector (F/R/V/P). Any selector makes the upstream dispatcher
    # route to a built-in chunker and ignore chunking_func — a silent regression
    # that would chunk the entire corpus with the wrong strategy. Fail fast.
    try:
        from lightrag.constants import PROCESS_OPTION_CHUNK_CHARS as _CHUNK_SELECTORS
    except Exception:
        _CHUNK_SELECTORS = frozenset("FRVP")
    _bad_selectors = sorted(set(_CHUNK_SELECTORS) & set(PROCESS_OPTIONS))
    if _bad_selectors:
        raise SystemExit(
            f"PROCESS_OPTIONS={PROCESS_OPTIONS!r} contains chunking selector(s) "
            f"{_bad_selectors}; this makes LightRAG bypass the AP-RAG structure-aware "
            f"chunker. Remove {_bad_selectors} from PROCESS_OPTIONS (use only i/t/e)."
        )

    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    ENDPOINTS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Papers dir    : {PAPERS_DIR}")
    print(f"Storage dir   : {STORAGE_DIR}")
    print(f"Embed model   : {EMBED_MODEL_ID}")
    print(f"Waiting for   : {N_VLLM} vLLM node(s)")
    print(f"PARALLEL_DOCS : {PARALLEL_DOCS}")
    print(f"LLM_MAX_ASYNC : {LLM_MAX_ASYNC}")
    print(f"CTX_MAX_ASYNC : {CONTEXT_MAX_ASYNC}")
    print(f"EMBED_MAX_ASYNC: {EMBED_FUNC_MAX_ASYNC}")
    print(f"MAX_PARALLEL_INSERT: {MAX_PARALLEL_INSERT}")
    print(f"CONTEXTUALIZE_CHUNKS: {CONTEXTUALIZE_CHUNKS}")
    if CONTEXTUALIZE_CHUNKS:
        print(f"MAX_DOC_TOKENS (context cap): {MAX_DOC_TOKENS}")
    else:
        print("MAX_DOC_TOKENS (context cap): disabled (contextualization off)")
    print(f"QDRANT_URL    : {QDRANT_URL or '(not set — using NanoVectorDB)'}")
    print(f"INSERT_DONE_N : {INSERT_DONE_EVERY_N}")
    print(f"Chunker       : {_CHUNKER_TYPE} (target={CHUNKER_CONFIG.target_tokens}, "
          f"max={CHUNKER_CONFIG.max_tokens}, min={CHUNKER_CONFIG.min_tokens}, "
          f"overlap={CHUNKER_CONFIG.overlap_tokens})")
    print(f"STREAMING     : {STREAMING_INGEST} (enqueue-all/drain-once text path)")
    print(f"EMBED         : {'remote ' + EMBED_ENDPOINT if EMBED_ENDPOINT else 'in-process'} "
          f"(batch_num={EMBEDDING_BATCH_NUM}, func_max_async={EMBED_FUNC_MAX_ASYNC})")
    if KV_STORAGE or DOC_STATUS_STORAGE:
        print(f"KV_STORAGE    : {KV_STORAGE or '(default)'} | DOC_STATUS_STORAGE: {DOC_STATUS_STORAGE or '(default)'}")
    print(f"[v2] Endpoint validation, resume support, status monitor, LLM failover\n")

    # Pre-load embedding model now (takes ~1 min) while waiting for vLLM —
    # skipped when embedding is served remotely on its own GPU (Fix 3).
    if not EMBED_ENDPOINT:
        get_embed_model()
    else:
        print(f"Embedding served remotely at {EMBED_ENDPOINT} — not loading in-process.", flush=True)

    endpoints = discover_endpoints()

    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc

    llm_func = build_round_robin_llm(endpoints)

    # 5: Contextual Retrieval is a *wrapper* around the chunker, not a LightRAG patch,
    # so the nested LightRAG/ stays upgradable (see CLAUDE.md "Why LightRAG is nested").
    # When enabled, each chunk is prefixed with an LLM-generated situating context before
    # embedding/extraction; the full-doc text in each prompt is capped to MAX_DOC_TOKENS.
    context_cap_stats = {"documents": 0, "truncated": 0}

    def _record_context_cap(was_truncated: bool):
        context_cap_stats["documents"] += 1
        if was_truncated:
            context_cap_stats["truncated"] += 1

    if CONTEXTUALIZE_CHUNKS:
        from pipeline.contextual_retrieval import make_contextualizing_chunker
        active_chunker = make_contextualizing_chunker(
            SCIENTIFIC_CHUNKER,
            llm_func,
            max_async=CONTEXT_MAX_ASYNC,
            cap_doc_content=(cap_context_document if MAX_DOC_TOKENS > 0 else None),
            on_doc=_record_context_cap,
        )
    else:
        active_chunker = SCIENTIFIC_CHUNKER

    # LightRAG >= 1.5 removed the ENTITY_TYPES env var (it now fail-fasts if the var
    # is merely present) and takes entity-type guidance as a prompt string via
    # addon_params instead. Pop the deprecated var (LightRAG's dotenv loads it from
    # .env at import) and pass the academic schema through the supported API — this
    # keeps the nested LightRAG/ patch-free (see CLAUDE.md "Why LightRAG is nested").
    os.environ.pop("ENTITY_TYPES", None)
    entity_types_guidance = os.environ.get("ENTITY_TYPES_GUIDANCE") or (
        "Classify each entity using one of the following types. If no type fits, use `Other`.\n\n"
        "- Author: Researchers, scholars, or authors of scientific work\n"
        "- Concept: Abstract ideas, constructs, or principles discussed in the literature\n"
        "- Method: Procedures, techniques, analyses, models, or experimental paradigms\n"
        "- Theory: Named theories, frameworks, or formal/computational models\n"
        "- Dataset: Corpora, datasets, norms, or collections of stimuli or measurements\n"
        "- Result: Reported quantitative or statistical outcomes\n"
        "- Experiment: Specific studies, experiments, or empirical investigations\n"
        "- Finding: Conclusions, effects, or claims established by research\n"
        "- Institution: Universities, laboratories, organizations, or funding bodies\n"
        "- Publication: Papers, journals, books, or other cited works"
    )

    # Build LightRAG kwargs — conditionally add Qdrant and batched flush
    rag_kwargs = dict(
        working_dir=str(STORAGE_DIR),
        llm_model_func=llm_func,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=8192,
            func=local_embed,
            supports_asymmetric=True,  # forward context="query"/"document"
        ),
        chunking_func=active_chunker,  # 5: structure-aware chunker (+ optional contextualizer)
        llm_model_max_async=LLM_MAX_ASYNC,
        embedding_func_max_async=EMBED_FUNC_MAX_ASYNC,
        embedding_batch_num=EMBEDDING_BATCH_NUM,  # Fix 3: bigger per-call embed batches
        max_parallel_insert=MAX_PARALLEL_INSERT,
        default_embedding_timeout=300,
        default_llm_timeout=int(os.environ.get("LLM_TIMEOUT", 1800)),
        addon_params={"entity_types_guidance": entity_types_guidance},
    )

    # Fix 1: opt-in incremental KV/doc-status backends (e.g. Redis) so LightRAG's
    # per-doc _insert_done() stops rewriting the giant JSON KV stores every document.
    if KV_STORAGE:
        rag_kwargs["kv_storage"] = KV_STORAGE
        print(f"[Fix1] Using kv_storage={KV_STORAGE}")
    if DOC_STATUS_STORAGE:
        rag_kwargs["doc_status_storage"] = DOC_STATUS_STORAGE
        print(f"[Fix1] Using doc_status_storage={DOC_STATUS_STORAGE}")

    # 2A: Use Qdrant if QDRANT_URL is set
    if USE_QDRANT:
        rag_kwargs["vector_storage"] = "QdrantVectorDBStorage"
        print(f"[2A] Using QdrantVectorDBStorage at {QDRANT_URL}")

    # VLM: enable native multimodal analysis and point the `vlm` role at our Qwen3.6
    # round-robin endpoint. The role wrapper strips `_priority` before calling our
    # func, and `llm_func` already forwards `image_inputs`/`response_format` through
    # **kwargs into openai_complete_if_cache, so no dedicated VLM caller is needed.
    if INGEST_VLM:
        rag_kwargs["vlm_process_enable"] = True
        rag_kwargs["role_llm_configs"] = {
            "vlm": {"func": llm_func, "max_async": VLM_MAX_ASYNC}
        }
        print(
            f"[VLM] Multimodal ingest ENABLED: parse_engine={PARSE_ENGINE}, "
            f"process_options={PROCESS_OPTIONS}, vlm_max_async={VLM_MAX_ASYNC}"
        )
        if PARSE_ENGINE == "mineru":
            _mode = os.environ.get("MINERU_API_MODE", "local")
            _ep = os.environ.get("MINERU_LOCAL_ENDPOINT", "")
            if _mode == "local" and not _ep:
                print("[VLM] WARNING: MINERU_API_MODE=local but MINERU_LOCAL_ENDPOINT "
                      "is unset — parsing will fail.", flush=True)
            else:
                print(f"[VLM] MinerU: mode={_mode} endpoint={_ep or '(official cloud)'}")
        elif PARSE_ENGINE == "docling":
            _ep = os.environ.get("DOCLING_ENDPOINT", "")
            if not _ep:
                print("[VLM] WARNING: PARSE_ENGINE=docling but DOCLING_ENDPOINT is "
                      "unset — parsing will fail.", flush=True)
            else:
                print(f"[VLM] Docling endpoint={_ep}")
        else:
            print(f"[VLM] WARNING: unknown PARSE_ENGINE={PARSE_ENGINE!r}", flush=True)

    rag = LightRAG(**rag_kwargs)

    await rag.initialize_storages()

    print("Testing LLM connections…")
    for ep in endpoints:
        try:
            from lightrag.llm.openai import openai_complete_if_cache
            result = await openai_complete_if_cache(
                LLM_MODEL, "Reply with exactly: OK",
                api_key=LLM_API_KEY, base_url=ep,
            )
            print(f"  {ep} → {str(result).strip()[:20]}")
        except Exception as e:
            print(f"  {ep} → ERROR: {e}")

    papers = sorted(PAPERS_DIR.glob("*.pdf"))
    if not papers:
        print(f"No PDFs found in {PAPERS_DIR}")
        await rag.finalize_storages()
        sys.exit(1)

    # ── (VLM) Native multimodal path: parser extracts figures/tables/equations, the
    #     `vlm` role captions them, then LightRAG chunks/extracts/embeds. LightRAG
    #     handles resume/dedup internally, so we skip the text-path doc-id precompute.
    if INGEST_VLM:
        print(f"\nFound {len(papers)} papers. Native multimodal ingest "
              f"(INGEST_VLM=1, engine={PARSE_ENGINE}, options={PROCESS_OPTIONS})…\n")
        t_start = time.time()
        monitor_task = asyncio.create_task(status_monitor(STORAGE_DIR, t_start))
        try:
            await ingest_native_multimodal(rag, papers)
        finally:
            monitor_task.cancel()
            try:
                await monitor_task
            except asyncio.CancelledError:
                pass
            await rag.finalize_storages()

        elapsed = time.time() - t_start
        print(f"\n{'='*60}")
        print(f"Done in {elapsed/3600:.1f}h (native multimodal, engine={PARSE_ENGINE})")
        doc_status_path = STORAGE_DIR / "kv_store_doc_status.json"
        if doc_status_path.exists():
            try:
                raw = json.loads(doc_status_path.read_text())
                final_counts = {}
                for k, v in raw.items():
                    if k.startswith("doc-"):
                        s = v.get("status", "unknown")
                        final_counts[s] = final_counts.get(s, 0) + 1
                print(f"Final doc_status: {final_counts}")
            except Exception:
                pass
        return

    # ── (1B) Skip docs already known to LightRAG (processed, pending, processing) ──
    # Only re-submit docs that LightRAG has never seen. Pending/processing docs
    # are already in the pipeline and will be picked up by apipeline_process_enqueue_documents.
    doc_status_path = STORAGE_DIR / "kv_store_doc_status.json"
    # Self-heal (resume/chain): a cycle killed at walltime can leave docs stranded
    # mid-pipeline (processing/analyzing/parsing). With resume-skip they'd be skipped
    # from re-reading yet aren't 'pending', so the drain never picks them up. Reset them.
    if doc_status_path.exists():
        try:
            _ds = json.loads(doc_status_path.read_text())
            _hits = [k for k, v in _ds.items()
                     if k.startswith("doc-") and v.get("status") in ("processing", "analyzing", "parsing")]
            for _k in _hits:
                _ds[_k]["status"] = "pending"
            if _hits:
                doc_status_path.write_text(json.dumps(_ds))
                print(f"Self-heal: reset {len(_hits)} stranded in-flight doc(s) -> pending.", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"Self-heal reset skipped: {type(e).__name__}: {e}", flush=True)
    known_doc_ids = set()
    enqueued_files = set()  # resume-skip: basenames of PDFs already in the pipeline (don't re-read)
    status_counts = {"processed": 0, "pending": 0, "processing": 0, "failed": 0}
    if doc_status_path.exists():
        try:
            raw = json.loads(doc_status_path.read_text())
            for k, v in raw.items():
                if not k.startswith("doc-"):
                    continue
                status = v.get("status", "unknown")
                if status in ("processed", "pending", "processing"):
                    known_doc_ids.add(k)
                # resume-skip covers EVERY doc already in doc_status (incl. 'failed'):
                # don't re-read any known file. Failed docs stay failed so the chain can
                # self-terminate instead of re-attempting persistent failures every cycle —
                # retrying failures is a deliberate end-of-run pass.
                fp = v.get("file_path", "")
                if fp:
                    enqueued_files.add(Path(fp).name)
                status_counts[status] = status_counts.get(status, 0) + 1
        except Exception:
            pass
    print(f"Doc status: {status_counts}")
    print(f"Known doc IDs (will skip): {len(known_doc_ids)}")
    if enqueued_files:
        print(f"Resume-skip: {len(enqueued_files)} PDFs already enqueued — skipping their re-read.")

    _mode_desc = "streaming enqueue/drain" if STREAMING_INGEST else "per-doc legacy"
    print(f"\nFound {len(papers)} papers. Starting ingestion "
          f"({_mode_desc}, PARALLEL_DOCS={PARALLEL_DOCS})…\n")

    t_start = time.time()

    # Start status monitor (1C)
    monitor_task = asyncio.create_task(status_monitor(STORAGE_DIR, t_start))

    succeeded = failed = skipped = 0
    counter_lock = asyncio.Lock()
    sem = asyncio.Semaphore(PARALLEL_DOCS)

    async def process_one(idx: int, pdf_path: Path):
        nonlocal succeeded, failed, skipped
        t_queued = time.time()
        loop = asyncio.get_event_loop()
        async with sem:
            t_sem_acquired = time.time()
            sem_wait_s = t_sem_acquired - t_queued
            try:
                # Fix 2a: PDF extraction is CPU-bound, pure-Python — run it off the
                # event loop so it can't stall every other in-flight document.
                text = await loop.run_in_executor(_IO_EXECUTOR, _extract_pdf_text, pdf_path)
                if not text:
                    print(f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} ⚠  Empty — skipping", flush=True)
                    async with counter_lock:
                        skipped += 1
                    return

                doc_id = "doc-" + hashlib.md5(text.encode("utf-8")).hexdigest()
                if doc_id in known_doc_ids:
                    print(f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} ↷  already known — skipping", flush=True)
                    async with counter_lock:
                        skipped += 1
                    return

                global _current_pdf_path
                _current_pdf_path = pdf_path
                t_ainsert_start = time.time()
                await rag.ainsert(
                    text,
                    ids=doc_id,
                    file_paths=str(pdf_path),
                )
                _current_pdf_path = None
                t_ainsert_returned = time.time()

                # ainsert() returns early after queuing — hold the semaphore
                # until LightRAG has actually finished extraction for this doc.
                # Timeout after DOC_POLL_TIMEOUT seconds to release stuck slots.
                status_file = STORAGE_DIR / "kv_store_doc_status.json"
                DOC_POLL_TIMEOUT = int(os.environ.get("DOC_POLL_TIMEOUT", 1800))
                t_poll_start = time.time()
                timed_out = False
                while True:
                    try:
                        raw = await loop.run_in_executor(_IO_EXECUTOR, status_file.read_text)
                        statuses = json.loads(raw)
                        entry = statuses.get(doc_id, {})
                        if isinstance(entry, dict) and entry.get("status") in ("processed", "failed"):
                            break
                    except Exception:
                        pass
                    if time.time() - t_poll_start > DOC_POLL_TIMEOUT:
                        timed_out = True
                        print(
                            f"[POLL_TIMEOUT] {pdf_path.name[:55]} stuck in extraction "
                            f">{DOC_POLL_TIMEOUT}s, releasing slot",
                            flush=True,
                        )
                        break
                    await asyncio.sleep(5)

                t_done = time.time()
                poll_s = t_done - t_poll_start
                ainsert_s = t_ainsert_returned - t_ainsert_start
                total_s = t_done - t_sem_acquired

                async with counter_lock:
                    succeeded += 1
                    elapsed = time.time() - t_start
                    rate = succeeded / (elapsed / 3600) if elapsed > 0 else 0
                    eta_h = (len(papers) - idx) / rate if rate > 0 else float("inf")
                    timeout_tag = " [POLL_TIMEOUT]" if timed_out else ""
                    print(
                        f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} [done{timeout_tag}]"
                        f"  total={total_s:.0f}s (sem_wait={sem_wait_s:.0f}s"
                        f" ainsert={ainsert_s:.0f}s poll={poll_s:.0f}s)"
                        f"  {rate:.0f}/hr | ETA {eta_h:.1f}h",
                        flush=True,
                    )

            except Exception as e:
                print(f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} [ainsert failed]  {e}", flush=True)
                async with counter_lock:
                    failed += 1

    if STREAMING_INGEST:
        # Fix 4: enqueue every doc, then drain LightRAG's native pipeline once.
        # process_one (above) is unused in this mode but kept for the legacy fallback.
        s_enqueued, s_skipped = await ingest_streaming_text(rag, papers, known_doc_ids, enqueued_files)
        succeeded, skipped = s_enqueued, s_skipped  # failures surface in doc_status below
    else:
        tasks = [process_one(i, p) for i, p in enumerate(papers, 1)]
        await asyncio.gather(*tasks)

    # Stop status monitor
    monitor_task.cancel()
    try:
        await monitor_task
    except asyncio.CancelledError:
        pass

    await rag.finalize_storages()

    # Final status report from doc_status.json
    elapsed = time.time() - t_start
    print(f"\n{'='*60}")
    print(f"Done in {elapsed/3600:.1f}h")
    print(f"  Submitted : {succeeded}")
    print(f"  Skipped   : {skipped}")
    if CONTEXTUALIZE_CHUNKS and MAX_DOC_TOKENS > 0:
        print(f"  Context-capped docs : {context_cap_stats['truncated']}/{context_cap_stats['documents']}")
    print(f"  Failed    : {failed}")

    # Print actual extraction results
    if doc_status_path.exists():
        try:
            raw = json.loads(doc_status_path.read_text())
            final_counts = {}
            for k, v in raw.items():
                if k.startswith("doc-"):
                    s = v.get("status", "unknown")
                    final_counts[s] = final_counts.get(s, 0) + 1
            print(f"\nFinal doc_status: {final_counts}")
            # Self-terminate (chain mode): if no work remains, cancel the rest of the
            # chained cycles (downstream vLLM + pending ingests) so dead cycles don't
            # burn vLLM walltime. Gated by CHAIN_SELFTERMINATE=1 (standalone never scancels).
            if os.environ.get("CHAIN_SELFTERMINATE") == "1":
                _left = sum(final_counts.get(s, 0)
                            for s in ("pending", "processing", "analyzing", "parsing"))
                if _left == 0:
                    import subprocess
                    _u = os.environ.get("USER", "devon7y")
                    print("Chain self-terminate: 0 docs left — cancelling downstream cycles.", flush=True)
                    for _a in (["scancel", "-u", _u, "-n", "westbury_vllm"],
                               ["scancel", "-u", _u, "-t", "PENDING", "-n", "westbury_ingest"]):
                        try:
                            subprocess.run(_a, timeout=30, check=False)
                        except Exception as _e:  # noqa: BLE001
                            print(f"  scancel failed: {_e}", flush=True)
                else:
                    print(f"Chain continues: {_left} docs still pending.", flush=True)
        except Exception:
            pass

    # Post-ingest guard: confirm the custom chunker actually ran (not bypassed).
    _verify_chunk_method(doc_status_path)


if __name__ == "__main__":
    asyncio.run(main())
