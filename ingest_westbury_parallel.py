"""
ingest_westbury_parallel.py — Parallel LightRAG ingestion for Westbury papers.

Distributes LLM calls round-robin across multiple vLLM nodes discovered via
shared endpoint files. A single asyncio process handles all storage writes
(safe with file-based storage), while GPU inference is parallelised across
N nodes.

Environment variables (set by job_ingest_parallel.slurm):
    WORKDIR           — HPC working directory containing vllm_endpoints/ etc.
    N_VLLM            — number of vLLM nodes to wait for (default 3)
    OPENAI_API_KEY    — for OpenAI text-embedding-3-large

Key settings:
    MAX_ASYNC=32               — concurrent LLM calls for entity extraction
    CONTEXTUALIZE_MAX_ASYNC=32 — concurrent LLM calls for contextualization
    EMBEDDING_FUNC_MAX_ASYNC=16
    --max-model-len 65536      — set in job_vllm.slurm; documents truncated
                                 to 60K tokens to leave headroom
"""

import asyncio
import itertools
import os
import sys
import time
from functools import partial
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────

WORKDIR     = Path(os.environ["WORKDIR"])
PAPERS_DIR  = WORKDIR / "papers"
STORAGE_DIR = WORKDIR / "rag_storage"
ENDPOINTS_DIR = WORKDIR / "vllm_endpoints"
N_VLLM      = int(os.environ.get("N_VLLM", 3))

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
LLM_MODEL      = "Qwen/Qwen2.5-72B-Instruct"
LLM_API_KEY    = "EMPTY"

# Documents longer than this are truncated before contextualisation.
# Leaves ~5K tokens of headroom in the 65K context window for the
# entity-extraction prompt and output.
MAX_DOC_TOKENS = 120_000

# ──────────────────────────────────────────────────────────────────────────────


def discover_endpoints(timeout_s: int = 1800) -> list[str]:
    """
    Block until all N_VLLM endpoint files appear in ENDPOINTS_DIR.
    Each vLLM SLURM task writes one file containing its http://host:port/v1 URL.
    """
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
    # Proceed with whatever is available
    files = sorted(ENDPOINTS_DIR.glob("*.txt"))
    endpoints = [f.read_text().strip() for f in files if f.read_text().strip()]
    if not endpoints:
        print("ERROR: No vLLM endpoints discovered. Exiting.")
        sys.exit(1)
    print(f"WARNING: Timed out waiting. Proceeding with {len(endpoints)} endpoint(s).")
    return endpoints


def build_round_robin_llm(endpoints: list[str]):
    """
    Returns an async LLM function that cycles through the provided vLLM
    endpoints on each call (round-robin load balancing).
    """
    from lightrag.llm.openai import openai_complete_if_cache

    cycle = itertools.cycle(endpoints)

    async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
        endpoint = next(cycle)
        if history_messages is None:
            history_messages = []
        return await openai_complete_if_cache(
            LLM_MODEL,
            prompt,
            system_prompt=system_prompt,
            history_messages=history_messages,
            api_key=LLM_API_KEY,
            base_url=endpoint,
            **kwargs,
        )

    return llm_func


def truncate_to_tokens(text: str, max_tokens: int) -> tuple[str, bool]:
    """
    Truncate text to at most max_tokens using tiktoken (cl100k_base).
    Returns (truncated_text, was_truncated).
    """
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        tokens = enc.encode(text)
        if len(tokens) <= max_tokens:
            return text, False
        return enc.decode(tokens[:max_tokens]), True
    except Exception:
        # Fallback: rough character estimate (1 token ≈ 4 chars)
        limit = max_tokens * 4
        if len(text) <= limit:
            return text, False
        return text[:limit], True


async def main():
    if not OPENAI_API_KEY:
        print("ERROR: OPENAI_API_KEY is not set.")
        sys.exit(1)

    STORAGE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Papers dir  : {PAPERS_DIR}")
    print(f"Storage dir : {STORAGE_DIR}")
    print(f"Waiting for : {N_VLLM} vLLM node(s)\n")

    endpoints = discover_endpoints()

    from lightrag import LightRAG, QueryParam
    from lightrag.llm.openai import openai_embed
    from lightrag.utils import EmbeddingFunc

    llm_func = build_round_robin_llm(endpoints)

    rag = LightRAG(
        working_dir=str(STORAGE_DIR),
        llm_model_func=llm_func,
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
        contextualize_chunks=True,
        # Crank concurrency — single asyncio process, file storage is safe
        llm_model_max_async=32,
        contextualize_max_async=32,
        embedding_func_max_async=16,
    )

    await rag.initialize_storages()

    # Verify LLM connectivity on each endpoint
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

    print(f"\nFound {len(papers)} papers. Starting ingestion…\n")

    from pypdf import PdfReader

    succeeded, failed, skipped, truncated = 0, 0, 0, 0
    t_start = time.time()

    for i, pdf_path in enumerate(papers, 1):
        elapsed = time.time() - t_start
        rate = succeeded / (elapsed / 3600) if elapsed > 0 and succeeded > 0 else 0
        eta = (len(papers) - i) / rate if rate > 0 else float("inf")
        print(
            f"[{i:04d}/{len(papers)}] {pdf_path.name[:60]}"
            f"  ({rate:.0f}/hr, ETA {eta:.1f}h)",
            flush=True,
        )
        try:
            reader = PdfReader(str(pdf_path))
            text = "\n\n".join(
                page.extract_text() or "" for page in reader.pages
            ).strip()

            if not text:
                print(f"           ⚠  No extractable text — skipping")
                skipped += 1
                continue

            text, was_truncated = truncate_to_tokens(text, MAX_DOC_TOKENS)
            if was_truncated:
                print(f"           ✂  Truncated to {MAX_DOC_TOKENS:,} tokens")
                truncated += 1

            await rag.ainsert(text, file_paths=[str(pdf_path)])
            print(f"           ✓  Ingested ({len(text):,} chars)")
            succeeded += 1

        except Exception as e:
            print(f"           ✗  Error: {e}")
            failed += 1

    await rag.finalize_storages()

    elapsed_h = (time.time() - t_start) / 3600
    print(f"\n{'─'*60}")
    print(f"Done in {elapsed_h:.1f}h")
    print(f"  {succeeded} ingested  |  {truncated} truncated  |  {skipped} skipped  |  {failed} failed")
    print(f"Knowledge graph saved to: {STORAGE_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
