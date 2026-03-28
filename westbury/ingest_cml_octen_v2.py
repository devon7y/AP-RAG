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
    CHUNK_TARGET_TOKENS  — target chunk size in tokens (5, default 800)
    CHUNK_MAX_TOKENS     — hard max chunk size in tokens (5, default 1000)
    CHUNK_MIN_TOKENS     — min chunk size; smaller tails are rebalanced (5, default 300)
    CHUNK_OVERLAP_TOKENS — sentence-aware overlap between chunks (5, default 150)
    CHUNK_EXCLUDE_REFS   — exclude References section from chunks (5, default 1)
    CHUNK_EXCLUDE_ACK    — exclude Acknowledgements section (5, default 1)
"""

import asyncio
import hashlib
import itertools
import json
import os
import signal
import subprocess
import sys
import time
from functools import partial
from pathlib import Path

import numpy as np

# ── Configuration ──────────────────────────────────────────────────────────────

WORKDIR       = Path(os.environ["WORKDIR"])
PAPERS_DIR    = WORKDIR / os.environ.get("PAPERS_SUBDIR", "papers_raw")
STORAGE_DIR   = WORKDIR / os.environ.get("STORAGE_SUBDIR", "rag_storage_octen")
ENDPOINTS_DIR = WORKDIR / os.environ.get("ENDPOINTS_SUBDIR", "vllm_endpoints_cml")
N_VLLM        = int(os.environ.get("N_VLLM", 1))

LLM_MODEL  = os.environ.get("LLM_MODEL", "Qwen/Qwen3.5-27B-FP8")
LLM_API_KEY = "EMPTY"

EMBED_MODEL_ID = "Octen/Octen-Embedding-8B-INT8"
EMBEDDING_DIM  = 4096
EMBED_BATCH    = 16   # sentences per GPU batch

MAX_DOC_TOKENS    = int(os.environ.get("MAX_DOC_TOKENS", 120_000))
PARALLEL_DOCS     = int(os.environ.get("PARALLEL_DOCS", 4))
LLM_MAX_ASYNC     = int(os.environ.get("LLM_MAX_ASYNC", 8))
CONTEXT_MAX_ASYNC = int(os.environ.get("CONTEXT_MAX_ASYNC", 8))
CONTEXTUALIZE_CHUNKS = os.environ.get("CONTEXTUALIZE_CHUNKS", "1") == "1"
EMBED_FUNC_MAX_ASYNC = int(os.environ.get("EMBED_FUNC_MAX_ASYNC", 1))
MAX_PARALLEL_INSERT  = int(os.environ.get("MAX_PARALLEL_INSERT", 2))

# 2A: Qdrant support — if QDRANT_URL is set, use QdrantVectorDBStorage
QDRANT_URL = os.environ.get("QDRANT_URL", "")
USE_QDRANT = bool(QDRANT_URL)

# 3A: Batched flush — flush storage every N docs instead of every 1
INSERT_DONE_EVERY_N = int(os.environ.get("INSERT_DONE_EVERY_N", 1))

# 4: Rebuild embeddings mode — skip LLM pipeline, recompute vectors from cache
REBUILD_EMBEDDINGS = os.environ.get("REBUILD_EMBEDDINGS", "0") == "1"
REBUILD_BATCH_SIZE = int(os.environ.get("REBUILD_BATCH_SIZE", 50))

# 5: Structure-aware scientific paper chunker (replaces LightRAG's token chunker)
from scientific_chunker import ChunkerConfig, make_scientific_chunker

CHUNKER_CONFIG = ChunkerConfig.from_env()

# Load pre-computed chunk cache if available (from prechunk_all.py).
# Cache hits are instant dict lookups — no CPU-bound work — so
# PARALLEL_DOCS > 1 won't block the asyncio event loop.
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
        from sentence_transformers import SentenceTransformer
        print(f"Loading embedding model {EMBED_MODEL_ID} on cuda…", flush=True)
        _embed_model = SentenceTransformer(EMBED_MODEL_ID, device="cuda")
        print("Embedding model ready.", flush=True)
    return _embed_model


async def local_embed(texts: list[str]) -> np.ndarray:
    model = get_embed_model()
    prefixed = ["- " + t for t in texts]
    loop = asyncio.get_event_loop()
    embeddings = await loop.run_in_executor(
        None,
        lambda: model.encode(
            prefixed,
            normalize_embeddings=True,
            batch_size=EMBED_BATCH,
            show_progress_bar=False,
        ),
    )
    return np.array(embeddings)


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


def discover_endpoints(timeout_s: int = 3600) -> list[str]:
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


def build_round_robin_llm(endpoints: list[str]):
    """Build an LLM function with retry, exponential backoff, and endpoint failover."""
    from lightrag.llm.openai import openai_complete_if_cache

    _live_endpoints.clear()
    _live_endpoints.extend(endpoints)
    cycle = itertools.cycle(range(1_000_000))  # index counter

    async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
        if history_messages is None:
            history_messages = []

        # Debug: log prompt size and kwargs
        prompt_len = len(prompt)
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
                print(f"[LLM_DEBUG] attempt={attempt+1} sending to {endpoint} prompt_len={prompt_len}", flush=True)
                t0 = time.time()
                result = await openai_complete_if_cache(
                    LLM_MODEL, "/no_think\n" + prompt,
                    system_prompt=system_prompt,
                    history_messages=history_messages,
                    api_key=LLM_API_KEY,
                    base_url=endpoint,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                    **kwargs,
                )
                print(f"[LLM_DEBUG] SUCCESS in {time.time()-t0:.1f}s, result_len={len(str(result))}", flush=True)
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
    """Background task that prints real extraction status every 30s."""
    status_path = storage_dir / "kv_store_doc_status.json"
    last_processed = 0
    while True:
        await asyncio.sleep(30)
        try:
            if not status_path.exists():
                continue
            raw = json.loads(status_path.read_text())
            counts = {}
            for k, v in raw.items():
                if not k.startswith("doc-"):
                    continue
                s = v.get("status", "unknown")
                counts[s] = counts.get(s, 0) + 1

            processed = counts.get("processed", 0)
            processing = counts.get("processing", 0)
            pending = counts.get("pending", 0)
            failed = counts.get("failed", 0)
            elapsed_h = (time.time() - t_start) / 3600

            # Rate based on newly processed docs
            rate = processed / elapsed_h if elapsed_h > 0 else 0
            remaining = processing + pending
            eta_h = remaining / rate if rate > 0 else float("inf")

            print(
                f"[STATUS] processed: {processed} | processing: {processing} | "
                f"pending: {pending} | failed: {failed} | "
                f"elapsed: {elapsed_h:.1f}h | rate: {rate:.0f}/hr | ETA: {eta_h:.1f}h",
                flush=True,
            )
            last_processed = processed
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

    # ── Pre-load embedding model ──
    get_embed_model()

    # ── Initialize LightRAG (embedding only, no LLM) ──
    async def _dummy_llm(*args, **kwargs):
        raise RuntimeError("LLM should not be called during REBUILD_EMBEDDINGS")

    rag_kwargs = dict(
        working_dir=str(STORAGE_DIR),
        llm_model_func=_dummy_llm,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=8192,
            func=local_embed,
        ),
        embedding_func_max_async=EMBED_FUNC_MAX_ASYNC,
    )
    if USE_QDRANT:
        rag_kwargs["vector_storage"] = "QdrantVectorDBStorage"
        print(f"\nTarget vector DB: Qdrant ({QDRANT_URL})")
    else:
        print("\nTarget vector DB: NanoVectorDB")

    rag = LightRAG(**rag_kwargs)
    await rag.initialize_storages()

    # ── Rebuild chunk embeddings ──
    print(f"\nRebuilding chunk embeddings ({len(chunks)} chunks, batch={REBUILD_BATCH_SIZE})...")
    batch = {}
    done = 0
    for chunk_id, chunk_data in chunks.items():
        batch[chunk_id] = {
            "content": chunk_data.get("content", ""),
            "full_doc_id": chunk_data.get("full_doc_id", ""),
            "file_path": chunk_data.get("file_path", ""),
        }
        if len(batch) >= REBUILD_BATCH_SIZE:
            await rag.chunks_vdb.upsert(batch)
            done += len(batch)
            batch = {}
            elapsed = time.time() - t_start
            rate = done / (elapsed / 60) if elapsed > 0 else 0
            print(f"  Chunks: {done}/{len(chunks)} ({rate:.0f}/min)", flush=True)
    if batch:
        await rag.chunks_vdb.upsert(batch)
        done += len(batch)
    print(f"  Chunks: {done}/{len(chunks)} done")

    # ── Rebuild entity embeddings ──
    print(f"\nRebuilding entity embeddings ({n_entities} entities, batch={REBUILD_BATCH_SIZE})...")
    batch = {}
    done = 0
    for node_name, node_data in graph.nodes(data=True):
        description = node_data.get("description", "")
        entity_vdb_id = compute_mdhash_id(node_name, prefix="ent-")
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
            batch = {}
            elapsed = time.time() - t_start
            rate = done / (elapsed / 60) if elapsed > 0 else 0
            print(f"  Entities: {done}/{n_entities} ({rate:.0f}/min)", flush=True)
    if batch:
        await rag.entities_vdb.upsert(batch)
        done += len(batch)
    print(f"  Entities: {done}/{n_entities} done")

    # ── Rebuild relation embeddings ──
    print(f"\nRebuilding relation embeddings ({n_relations} relations, batch={REBUILD_BATCH_SIZE})...")
    batch = {}
    done = 0
    for src, tgt, edge_data in graph.edges(data=True):
        keywords = edge_data.get("keywords", "")
        description = edge_data.get("description", "")
        rel_vdb_id = compute_mdhash_id(f"{src}_{tgt}", prefix="rel-")
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
            batch = {}
            elapsed = time.time() - t_start
            rate = done / (elapsed / 60) if elapsed > 0 else 0
            print(f"  Relations: {done}/{n_relations} ({rate:.0f}/min)", flush=True)
    if batch:
        await rag.relationships_vdb.upsert(batch)
        done += len(batch)
    print(f"  Relations: {done}/{n_relations} done")

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


# ── Main ───────────────────────────────────────────────────────────────────────

async def main():
    # ── Rebuild mode: skip full pipeline, only recompute embeddings ──
    if REBUILD_EMBEDDINGS:
        await rebuild_embeddings_from_cache()
        return

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
    print(f"Chunker       : scientific (target={CHUNKER_CONFIG.target_tokens}, "
          f"max={CHUNKER_CONFIG.max_tokens}, min={CHUNKER_CONFIG.min_tokens}, "
          f"overlap={CHUNKER_CONFIG.overlap_tokens})")
    print(f"[v2] Endpoint validation, resume support, status monitor, LLM failover\n")

    # Pre-load embedding model now (takes ~1 min) while waiting for vLLM
    get_embed_model()

    endpoints = discover_endpoints()

    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc

    llm_func = build_round_robin_llm(endpoints)

    # Build LightRAG kwargs — conditionally add Qdrant and batched flush
    rag_kwargs = dict(
        working_dir=str(STORAGE_DIR),
        llm_model_func=llm_func,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=8192,
            func=local_embed,
        ),
        chunking_func=SCIENTIFIC_CHUNKER,  # 5: structure-aware chunker
        contextualize_chunks=CONTEXTUALIZE_CHUNKS,
        llm_model_max_async=LLM_MAX_ASYNC,
        contextualize_max_async=CONTEXT_MAX_ASYNC,
        embedding_func_max_async=EMBED_FUNC_MAX_ASYNC,
        max_parallel_insert=MAX_PARALLEL_INSERT,
        default_embedding_timeout=300,
    )

    # 2A: Use Qdrant if QDRANT_URL is set
    if USE_QDRANT:
        rag_kwargs["vector_storage"] = "QdrantVectorDBStorage"
        print(f"[2A] Using QdrantVectorDBStorage at {QDRANT_URL}")

    rag = LightRAG(**rag_kwargs)

    # Keep full-document ingestion, but cap doc context sent into contextualization prompts.
    context_cap_stats = {"documents": 0, "truncated": 0}
    if rag.contextualize_chunks and MAX_DOC_TOKENS > 0:
        original_contextualize_chunks = rag._contextualize_chunks

        async def _contextualize_chunks_with_doc_cap(chunks: dict[str, dict], doc_content: str):
            capped_doc_content, was_truncated = cap_context_document(doc_content)
            context_cap_stats["documents"] += 1
            if was_truncated:
                context_cap_stats["truncated"] += 1
            return await original_contextualize_chunks(chunks, capped_doc_content)

        rag._contextualize_chunks = _contextualize_chunks_with_doc_cap

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

    # ── (1B) Skip docs already known to LightRAG (processed, pending, processing) ──
    # Only re-submit docs that LightRAG has never seen. Pending/processing docs
    # are already in the pipeline and will be picked up by apipeline_process_enqueue_documents.
    doc_status_path = STORAGE_DIR / "kv_store_doc_status.json"
    known_doc_ids = set()
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
                status_counts[status] = status_counts.get(status, 0) + 1
        except Exception:
            pass
    print(f"Doc status: {status_counts}")
    print(f"Known doc IDs (will skip): {len(known_doc_ids)}")

    print(f"\nFound {len(papers)} papers. Starting ingestion (PARALLEL_DOCS={PARALLEL_DOCS})…\n")

    from pypdf import PdfReader

    t_start = time.time()

    # Start status monitor (1C)
    monitor_task = asyncio.create_task(status_monitor(STORAGE_DIR, t_start))

    succeeded = failed = skipped = 0
    counter_lock = asyncio.Lock()
    sem = asyncio.Semaphore(PARALLEL_DOCS)

    async def process_one(idx: int, pdf_path: Path):
        nonlocal succeeded, failed, skipped
        async with sem:
            try:
                reader = PdfReader(str(pdf_path))
                page_texts = [
                    (page.extract_text() or "").strip()
                    for page in reader.pages
                ]
                text = "\n\f\n".join(page for page in page_texts if page).strip()
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
                await rag.ainsert(
                    text,
                    ids=doc_id,
                    file_paths=str(pdf_path),
                )
                _current_pdf_path = None

                async with counter_lock:
                    succeeded += 1
                    elapsed = time.time() - t_start
                    rate = succeeded / (elapsed / 3600) if elapsed > 0 else 0
                    eta_h = (len(papers) - idx) / rate if rate > 0 else float("inf")
                    print(
                        f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} ✓"
                        + f"  ({rate:.0f}/hr, ETA {eta_h:.1f}h)",
                        flush=True,
                    )

            except Exception as e:
                print(f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} ✗  {e}", flush=True)
                async with counter_lock:
                    failed += 1

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
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
