"""
ingest_cml_octen.py — LightRAG ingestion for CML lab papers using
Octen-Embedding-8B (local, sentence-transformers on GPU) for embeddings
and Qwen2.5-72B via vLLM for entity extraction.

Keeps storage completely separate from the Westbury OpenAI database.

Environment variables (set by job_ingest_cml_octen.slurm):
    WORKDIR          — HPC working directory
    N_VLLM           — number of vLLM nodes to wait for (default 3)
    ENDPOINTS_SUBDIR — subdirectory name for vLLM endpoint files (default: vllm_endpoints_cml)
    PAPERS_SUBDIR    — subdirectory containing PDFs (default: papers_raw)
    STORAGE_SUBDIR   — subdirectory for LightRAG storage (default: rag_storage_octen)
    MAX_DOC_TOKENS   — max tokens per document before truncation (default: 120000)
    PARALLEL_DOCS    — number of documents to ingest concurrently (default: 4)
    LLM_MAX_ASYNC    — max concurrent LLM requests (default: 8)
    CONTEXT_MAX_ASYNC — max concurrent contextualization requests (default: 8)

Key settings:
    EMBED_MODEL      = Octen/Octen-Embedding-8B (loaded locally on GPU)
    EMBEDDING_DIM    = 4096
    MAX_TOKEN_SIZE   = 8192
    embedding_func_max_async = 4   (local GPU batch inference)
"""

import asyncio
import hashlib
import itertools
import json
import os
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
N_VLLM        = int(os.environ.get("N_VLLM", 3))

LLM_MODEL  = os.environ.get("LLM_MODEL", "Qwen/Qwen3.5-27B-FP8")
LLM_API_KEY = "EMPTY"

EMBED_MODEL_ID = "Octen/Octen-Embedding-8B-INT8"
EMBEDDING_DIM  = 4096
EMBED_BATCH    = 16   # sentences per GPU batch

MAX_DOC_TOKENS    = int(os.environ.get("MAX_DOC_TOKENS", 120_000))
PARALLEL_DOCS     = int(os.environ.get("PARALLEL_DOCS", 4))
LLM_MAX_ASYNC     = int(os.environ.get("LLM_MAX_ASYNC", 8))
CONTEXT_MAX_ASYNC = int(os.environ.get("CONTEXT_MAX_ASYNC", 8))
EMBED_FUNC_MAX_ASYNC = int(os.environ.get("EMBED_FUNC_MAX_ASYNC", 1))
MAX_PARALLEL_INSERT  = int(os.environ.get("MAX_PARALLEL_INSERT", 2))

# ──────────────────────────────────────────────────────────────────────────────

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
    """
    Wraps synchronous sentence-transformers encode in a thread so it
    doesn't block the asyncio event loop.
    Prepends '- ' per Octen/Qwen3 model instructions.
    """
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


def discover_endpoints(timeout_s: int = 3600) -> list[str]:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        files = sorted(ENDPOINTS_DIR.glob("*.txt"))
        endpoints = [f.read_text().strip() for f in files if f.read_text().strip()]
        if len(endpoints) >= N_VLLM:
            print(f"Discovered {len(endpoints)} vLLM endpoint(s):")
            for ep in endpoints:
                print(f"  {ep}")
            return endpoints
        print(f"  waiting for endpoints ({len(endpoints)}/{N_VLLM})…", flush=True)
        time.sleep(15)
    files = sorted(ENDPOINTS_DIR.glob("*.txt"))
    endpoints = [f.read_text().strip() for f in files if f.read_text().strip()]
    if not endpoints:
        print("ERROR: No vLLM endpoints discovered. Exiting.")
        sys.exit(1)
    print(f"WARNING: Timed out. Proceeding with {len(endpoints)} endpoint(s).")
    return endpoints


def build_round_robin_llm(endpoints: list[str]):
    from lightrag.llm.openai import openai_complete_if_cache
    cycle = itertools.cycle(endpoints)

    async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
        endpoint = next(cycle)
        if history_messages is None:
            history_messages = []
        # Prepend /no_think to disable Qwen3.x thinking mode (model-native soft switch).
        # Also pass via extra_body as belt-and-suspenders for vLLM chat template kwargs.
        return await openai_complete_if_cache(
            LLM_MODEL, "/no_think\n" + prompt,
            system_prompt=system_prompt,
            history_messages=history_messages,
            api_key=LLM_API_KEY,
            base_url=endpoint,
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            **kwargs,
        )

    return llm_func


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


async def main():
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
    print(f"MAX_PARALLEL_INSERT: {MAX_PARALLEL_INSERT}\n")

    # Pre-load embedding model now (takes ~1 min) while waiting for vLLM
    get_embed_model()

    endpoints = discover_endpoints()

    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc

    llm_func = build_round_robin_llm(endpoints)

    rag = LightRAG(
        working_dir=str(STORAGE_DIR),
        llm_model_func=llm_func,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM,
            max_token_size=8192,
            func=local_embed,
        ),
        contextualize_chunks=True,
        llm_model_max_async=LLM_MAX_ASYNC,
        contextualize_max_async=CONTEXT_MAX_ASYNC,
        embedding_func_max_async=EMBED_FUNC_MAX_ASYNC,
        max_parallel_insert=MAX_PARALLEL_INSERT,
    )

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

    # Skip papers already fully processed (avoids dup-* entries in doc_status).
    # Pending/failed docs still need ainsert() to trigger the pipeline worker.
    # LightRAG doc_id = "doc-" + md5(text).hexdigest()
    doc_status_path = STORAGE_DIR / "kv_store_doc_status.json"
    processed_doc_ids = set()
    if doc_status_path.exists():
        try:
            raw = json.loads(doc_status_path.read_text())
            processed_doc_ids = {
                k for k, v in raw.items()
                if k.startswith("doc-") and v.get("status") == "processed"
            }
        except Exception:
            pass
    print(f"Already processed: {len(processed_doc_ids)}")

    print(f"\nFound {len(papers)} papers. Starting ingestion (PARALLEL_DOCS={PARALLEL_DOCS})…\n")

    from pypdf import PdfReader

    succeeded = failed = skipped = truncated = 0
    counter_lock = asyncio.Lock()
    t_start = time.time()
    sem = asyncio.Semaphore(PARALLEL_DOCS)

    async def process_one(idx: int, pdf_path: Path):
        nonlocal succeeded, failed, skipped, truncated
        async with sem:
            try:
                reader = PdfReader(str(pdf_path))
                text = "\n".join(
                    page.extract_text() or "" for page in reader.pages
                ).strip()
                if not text:
                    print(f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} ⚠  Empty — skipping", flush=True)
                    async with counter_lock:
                        skipped += 1
                    return

                text, was_trunc = truncate_to_tokens(text, MAX_DOC_TOKENS)

                doc_id = "doc-" + hashlib.md5(text.encode("utf-8")).hexdigest()
                if doc_id in processed_doc_ids:
                    print(f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} ↷  already processed — skipping", flush=True)
                    async with counter_lock:
                        skipped += 1
                    return

                await rag.ainsert(text)

                async with counter_lock:
                    succeeded += 1
                    if was_trunc:
                        truncated += 1
                    elapsed = time.time() - t_start
                    rate = succeeded / (elapsed / 3600) if elapsed > 0 else 0
                eta_h = (len(papers) - succeeded) / rate if rate > 0 else float("inf")
                print(
                    f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} ✓"
                    + (" [trunc]" if was_trunc else "")
                    + f"  ({rate:.0f}/hr, ETA {eta_h:.1f}h)",
                    flush=True,
                )

            except Exception as e:
                print(f"[{idx:04d}/{len(papers)}] {pdf_path.name[:55]} ✗  {e}", flush=True)
                async with counter_lock:
                    failed += 1

    tasks = [process_one(i, p) for i, p in enumerate(papers, 1)]
    await asyncio.gather(*tasks)

    await rag.finalize_storages()

    elapsed = time.time() - t_start
    print(f"\n{'='*60}")
    print(f"Done in {elapsed/3600:.1f}h")
    print(f"  Succeeded : {succeeded}")
    print(f"  Skipped   : {skipped}")
    print(f"  Truncated : {truncated}")
    print(f"  Failed    : {failed}")


if __name__ == "__main__":
    asyncio.run(main())
