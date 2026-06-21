#!/usr/bin/env python3
"""Pre-chunk all book PDFs through the book chunker and save to a JSON cache.

Mirrors prechunk_all.py but uses BookChunkerConfig / chunk_book_document
for the large-book corpus (papers_large).

Usage:
    WORKDIR=/scratch/devon7y/westbury_rag python prechunk_books.py

Outputs:
    $WORKDIR/$STORAGE_SUBDIR/book_chunk_cache.json

Environment variables:
    PAPERS_SUBDIR           Papers subdirectory (default: papers_large)
    STORAGE_SUBDIR          Storage subdirectory (default: rag_storage_westbury_qwen3_32b)
    PRECHUNK_WORKERS        Optional explicit worker count.
    PRECHUNK_PROGRESS_EVERY Progress print interval in completed docs (default 1).
    PRECHUNK_SKIP_FILE      Optional newline-delimited filename list to skip.

    Book chunker config (passed through BookChunkerConfig.from_env()):
    BOOK_CHUNK_TARGET_TOKENS  (default 1000)
    BOOK_CHUNK_MAX_TOKENS     (default 1500)
    BOOK_CHUNK_MIN_TOKENS     (default 250)
    BOOK_CHUNK_OVERLAP_TOKENS (default 200)
"""

from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict
import hashlib
import json
import os
import time
from pathlib import Path

from pypdf import PdfReader

WORKDIR = Path(os.environ["WORKDIR"])
PAPERS_DIR = WORKDIR / os.environ.get("PAPERS_SUBDIR", "papers_large")
STORAGE_DIR = WORKDIR / os.environ.get("STORAGE_SUBDIR", "rag_storage_westbury_qwen3_32b")

from book_chunker import BookChunkerConfig, chunk_book_document

_WORKER_TOKENIZER = None
_WORKER_CONFIG = None


def get_tokenizer():
    import tiktoken
    return tiktoken.get_encoding("cl100k_base")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _default_worker_count(total_docs: int) -> int:
    requested = _env_int("PRECHUNK_WORKERS", 0)
    if requested <= 0:
        requested = _env_int("SLURM_CPUS_PER_TASK", 0)
    if requested <= 0:
        requested = _env_int("SLURM_CPUS_ON_NODE", 0)
    if requested <= 0:
        requested = os.cpu_count() or 1
    return max(1, min(requested, max(1, total_docs)))


def _process_pdf(index: int, pdf_path: Path, tokenizer, config: BookChunkerConfig) -> dict:
    try:
        reader = PdfReader(str(pdf_path))
        page_texts = [(page.extract_text() or "").strip() for page in reader.pages]
        text = "\n\f\n".join(p for p in page_texts if p).strip()

        if not text:
            return {
                "index": index,
                "file": pdf_path.name,
                "status": "skipped",
            }

        content_hash = hashlib.md5(text.encode("utf-8")).hexdigest()
        chunks = chunk_book_document(tokenizer, text, config)
        return {
            "index": index,
            "file": pdf_path.name,
            "status": "ok",
            "content_hash": content_hash,
            "chunks": chunks,
            "chunk_count": len(chunks),
        }
    except Exception as exc:
        return {
            "index": index,
            "file": pdf_path.name,
            "status": "error",
            "error": str(exc),
        }


def _worker_init(config_dict: dict) -> None:
    global _WORKER_TOKENIZER, _WORKER_CONFIG
    _WORKER_TOKENIZER = get_tokenizer()
    _WORKER_CONFIG = BookChunkerConfig(**config_dict)


def _worker_process_one(index: int, pdf_path_str: str) -> dict:
    if _WORKER_TOKENIZER is None or _WORKER_CONFIG is None:
        raise RuntimeError("Worker not initialized")
    return _process_pdf(index, Path(pdf_path_str), _WORKER_TOKENIZER, _WORKER_CONFIG)


def main():
    tokenizer = get_tokenizer()
    config = BookChunkerConfig.from_env()

    papers = sorted(PAPERS_DIR.glob("*.pdf"))
    papers_total = len(papers)
    skip_file = os.environ.get("PRECHUNK_SKIP_FILE", "").strip()
    skip_names: set[str] = set()
    if skip_file:
        skip_path = Path(skip_file)
        if skip_path.exists():
            for line in skip_path.read_text().splitlines():
                name = line.strip()
                if not name or name.startswith("#"):
                    continue
                skip_names.add(name)
            print(f"Skip file: {skip_path} ({len(skip_names)} names)", flush=True)
        else:
            print(f"Skip file not found: {skip_path} (ignoring)", flush=True)
    if skip_names:
        papers = [p for p in papers if p.name not in skip_names]

    total_docs = len(papers)
    workers = _default_worker_count(total_docs)
    progress_every = max(1, _env_int("PRECHUNK_PROGRESS_EVERY", 1))

    if skip_names:
        print(
            f"Found {len(papers)} PDFs in {PAPERS_DIR} "
            f"(skipped {papers_total - len(papers)} from skip file)",
            flush=True,
        )
    else:
        print(f"Found {len(papers)} PDFs in {PAPERS_DIR}")
    print(f"Chunker: target={config.target_tokens}, max={config.max_tokens}, "
          f"min={config.min_tokens}, overlap={config.overlap_tokens}")
    print(
        "Workers: "
        f"{workers} "
        f"(PRECHUNK_WORKERS={os.environ.get('PRECHUNK_WORKERS', 'unset')}, "
        f"SLURM_CPUS_PER_TASK={os.environ.get('SLURM_CPUS_PER_TASK', 'unset')}, "
        f"SLURM_CPUS_ON_NODE={os.environ.get('SLURM_CPUS_ON_NODE', 'unset')})",
        flush=True,
    )

    cache = {}
    t_start = time.time()
    skipped = errors = 0
    total_chunks = 0
    completed = 0
    collisions = 0

    def handle_result(result: dict) -> str:
        nonlocal skipped, errors, total_chunks, completed, collisions
        completed += 1
        status = result.get("status")
        if status == "skipped":
            skipped += 1
        elif status == "ok":
            content_hash = result["content_hash"]
            if content_hash in cache:
                collisions += 1
            cache[content_hash] = result["chunks"]
            total_chunks += result["chunk_count"]
        else:
            errors += 1
            print(
                f"[{result.get('index', 0):04d}/{total_docs}] ERROR: "
                f"{result.get('file', '<unknown>')}: {result.get('error', 'unknown')}",
                flush=True,
            )
        return str(result.get("file", ""))

    if workers == 1 or total_docs <= 1:
        for i, pdf_path in enumerate(papers, 1):
            last_file = handle_result(_process_pdf(i, pdf_path, tokenizer, config))
            elapsed = time.time() - t_start
            rate = completed / (elapsed / 3600) if elapsed > 0 else 0
            if completed % progress_every == 0 or completed == total_docs:
                print(
                    f"[{completed:04d}/{total_docs}] {total_chunks:5d} chunks total | "
                    f"{rate:.0f} docs/hr | {last_file[:50]}",
                    flush=True,
                )
    else:
        config_dict = asdict(config)
        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=_worker_init,
            initargs=(config_dict,),
        ) as executor:
            futures = {
                executor.submit(_worker_process_one, i, str(pdf_path)): (i, pdf_path.name)
                for i, pdf_path in enumerate(papers, 1)
            }
            for future in as_completed(futures):
                i, pdf_name = futures[future]
                try:
                    result = future.result()
                except Exception as exc:
                    errors += 1
                    completed += 1
                    print(
                        f"[{i:04d}/{total_docs}] ERROR: {pdf_name}: {exc}",
                        flush=True,
                    )
                    result = {"file": pdf_name}
                last_file = handle_result(result) if "status" in result else pdf_name
                elapsed = time.time() - t_start
                rate = completed / (elapsed / 3600) if elapsed > 0 else 0
                if completed % progress_every == 0 or completed == total_docs:
                    print(
                        f"[{completed:04d}/{total_docs}] {total_chunks:5d} chunks total | "
                        f"{rate:.0f} docs/hr | {last_file[:50]}",
                        flush=True,
                    )

    cache_path = STORAGE_DIR / "book_chunk_cache.json"
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "w") as f:
        json.dump(cache, f)

    elapsed = time.time() - t_start
    size_mb = cache_path.stat().st_size / 1024 / 1024
    print(f"\nDone in {elapsed:.0f}s ({elapsed / 60:.1f} min)")
    print(f"  Docs cached : {len(cache)}")
    print(f"  Total chunks: {total_chunks}")
    print(f"  Skipped     : {skipped} (empty)")
    print(f"  Errors      : {errors}")
    print(f"  Hash collisions: {collisions}")
    print(f"  Cache file  : {cache_path} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
