"""
ingest_westbury.py — LightRAG ingestion for Westbury papers.

Reads all PDFs from INPUT_DIR (/Volumes/T7/Westbury papers), extracts text,
and builds a separate LightRAG knowledge graph in rag_storage_westbury.
Designed to run with the LLM on your HPC (same setup as ingest.py).

────────────────────────────────────────────────────────────────────────────
HPC SETUP (do this before running)
────────────────────────────────────────────────────────────────────────────
1. SSH tunnel to expose your HPC's LLM endpoint locally:

     ssh -L 8000:localhost:8000 fir

2. On the HPC, start your model (if not already running):

     vllm serve Qwen/Qwen2.5-72B-Instruct --host 0.0.0.0 --port 8000

3. Keep the tunnel open, then run this script:
     cd /Users/devon7y/VS_Code/rag_testing/LightRAG
     source .venv/bin/activate
     python ../ingest_westbury.py
────────────────────────────────────────────────────────────────────────────
"""

import asyncio
import os
import sys
from functools import partial
from pathlib import Path

from dotenv import load_dotenv

# Load config from westbury/.env
_env_path = Path(__file__).parent / "westbury" / ".env"
load_dotenv(dotenv_path=_env_path, override=False)

from lightrag import LightRAG, QueryParam  # noqa: E402
from lightrag.llm.openai import openai_complete_if_cache, openai_embed  # noqa: E402
from lightrag.utils import EmbeddingFunc  # noqa: E402

# ── Configuration ─────────────────────────────────────────────────────────────

PAPERS_DIR = Path(os.getenv("INPUT_DIR", "/Volumes/T7/Westbury papers"))
STORAGE_DIR = Path(os.getenv("WORKING_DIR", str(Path(__file__).parent / "LightRAG" / "rag_storage_westbury")))

HPC_LLM_HOST = os.getenv("LLM_BINDING_HOST", "http://localhost:8000/v1")
HPC_LLM_MODEL = os.getenv("LLM_MODEL", "Qwen/Qwen2.5-72B-Instruct")
HPC_LLM_API_KEY = os.getenv("LLM_BINDING_API_KEY", "EMPTY")

OPENAI_API_KEY = os.getenv("EMBEDDING_BINDING_API_KEY") or os.getenv("OPENAI_API_KEY", "")

# ──────────────────────────────────────────────────────────────────────────────


async def llm_func(prompt, system_prompt=None, history_messages=None, **kwargs):
    if history_messages is None:
        history_messages = []
    return await openai_complete_if_cache(
        HPC_LLM_MODEL,
        prompt,
        system_prompt=system_prompt,
        history_messages=history_messages,
        api_key=HPC_LLM_API_KEY,
        base_url=HPC_LLM_HOST,
        **kwargs,
    )


async def main():
    if not OPENAI_API_KEY or OPENAI_API_KEY == "YOUR_OPENAI_API_KEY_HERE":
        print("ERROR: Set EMBEDDING_BINDING_API_KEY in westbury/.env")
        sys.exit(1)

    STORAGE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"LLM endpoint : {HPC_LLM_HOST}  (model: {HPC_LLM_MODEL})")
    print(f"Embeddings   : OpenAI text-embedding-3-large")
    print(f"Papers dir   : {PAPERS_DIR}")
    print(f"Storage dir  : {STORAGE_DIR}\n")

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
    )

    await rag.initialize_storages()

    print("Testing LLM connection...")
    try:
        test = await llm_func("Reply with exactly: OK")
        print(f"LLM OK: {str(test).strip()[:40]}\n")
    except Exception as e:
        print(f"ERROR: Cannot reach LLM at {HPC_LLM_HOST}: {e}")
        print("Is your SSH tunnel running? Is the model server started?")
        await rag.finalize_storages()
        sys.exit(1)

    papers = sorted(PAPERS_DIR.glob("*.pdf"))
    if not papers:
        print(f"No PDFs found in {PAPERS_DIR}")
        await rag.finalize_storages()
        sys.exit(1)

    print(f"Found {len(papers)} papers. Starting ingestion...\n")

    from pypdf import PdfReader

    succeeded, failed, skipped = 0, 0, 0
    for i, pdf_path in enumerate(papers, 1):
        print(f"[{i:04d}/{len(papers)}] {pdf_path.name}")
        try:
            reader = PdfReader(str(pdf_path))
            text = "\n\n".join(
                page.extract_text() or "" for page in reader.pages
            ).strip()
            if not text:
                print(f"           ⚠  No extractable text — skipping")
                skipped += 1
                continue
            await rag.ainsert(text, file_paths=[str(pdf_path)])
            print(f"           ✓  Ingested ({len(text):,} chars)")
            succeeded += 1
        except Exception as e:
            print(f"           ✗  Error: {e}")
            failed += 1

    await rag.finalize_storages()

    print(f"\n{'─'*50}")
    print(f"Done.  {succeeded} ingested, {skipped} skipped (no text), {failed} failed.")
    print(f"Knowledge graph saved to: {STORAGE_DIR}")
    print(f"\nNext step: run query_westbury.py to ask questions.")


if __name__ == "__main__":
    asyncio.run(main())
