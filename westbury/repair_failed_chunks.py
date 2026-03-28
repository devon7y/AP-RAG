#!/usr/bin/env python3
"""Audit chunk cache integrity and re-chunk only suspicious documents.

This script is intended to run after `prechunk_all.py` has produced
`chunk_cache.json`.

It identifies potentially bad cache entries (for example:
  - missing cache entry for a PDF
  - very low retained-token ratio
  - single giant chunk for a large document
)
and recomputes chunks only for those documents.

Usage:
    WORKDIR=/scratch/devon7y/westbury_rag python repair_failed_chunks.py

Environment variables:
    REPAIR_WORKERS                   Optional explicit worker count.
    REPAIR_PROGRESS_EVERY            Progress print interval (default 25).
    REPAIR_MIN_RAW_TOKENS            Min doc tokens for large-doc checks (default 5000).
    REPAIR_MIN_RETENTION_RATIO       Min retained/raw ratio before flagging (default 0.10).
    REPAIR_SINGLE_CHUNK_TOKEN_LIMIT  Single-chunk size threshold (default 3000).
    REPAIR_DRY_RUN                   If "1", only report; do not write cache (default 0).
    REPAIR_WRITE_BACKUP              If "1", write timestamped backup first (default 1).
"""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import asdict
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

from pypdf import PdfReader

from scientific_chunker import ChunkerConfig, chunk_document

WORKDIR = Path(os.environ["WORKDIR"])
PAPERS_DIR = WORKDIR / os.environ.get("PAPERS_SUBDIR", "papers")
STORAGE_DIR = WORKDIR / os.environ.get("STORAGE_SUBDIR", "rag_storage_westbury_qwen3_32b")
CACHE_PATH = STORAGE_DIR / "chunk_cache.json"

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


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _default_worker_count(total_docs: int) -> int:
    requested = _env_int("REPAIR_WORKERS", 0)
    if requested <= 0:
        requested = _env_int("SLURM_CPUS_PER_TASK", 0)
    if requested <= 0:
        requested = _env_int("SLURM_CPUS_ON_NODE", 0)
    if requested <= 0:
        requested = os.cpu_count() or 1
    return max(1, min(requested, max(1, total_docs)))


def _extract_text(pdf_path: Path) -> str:
    reader = PdfReader(str(pdf_path))
    page_texts = [(page.extract_text() or "").strip() for page in reader.pages]
    return "\n\f\n".join(p for p in page_texts if p).strip()


def _sum_chunk_tokens(chunks: list[dict]) -> int:
    total = 0
    for chunk in chunks:
        total += int(chunk.get("token_count_without_overlap", chunk.get("tokens", 0)))
    return total


def _max_chunk_tokens(chunks: list[dict]) -> int:
    max_tok = 0
    for chunk in chunks:
        tok = int(chunk.get("token_count_without_overlap", chunk.get("tokens", 0)))
        if tok > max_tok:
            max_tok = tok
    return max_tok


def _worker_init(config_dict: dict) -> None:
    global _WORKER_TOKENIZER, _WORKER_CONFIG
    _WORKER_TOKENIZER = get_tokenizer()
    _WORKER_CONFIG = ChunkerConfig(**config_dict)


def _inspect_pdf(index: int, pdf_path_str: str) -> dict:
    pdf_path = Path(pdf_path_str)
    try:
        text = _extract_text(pdf_path)
        if not text:
            return {"index": index, "file": pdf_path.name, "status": "empty"}
        raw_tokens = len(_WORKER_TOKENIZER.encode(text))
        content_hash = hashlib.md5(text.encode("utf-8")).hexdigest()
        return {
            "index": index,
            "file": pdf_path.name,
            "status": "ok",
            "content_hash": content_hash,
            "raw_tokens": raw_tokens,
        }
    except Exception as exc:
        return {
            "index": index,
            "file": pdf_path.name,
            "status": "error",
            "error": str(exc),
        }


def _rechunk_pdf(index: int, pdf_path_str: str) -> dict:
    pdf_path = Path(pdf_path_str)
    try:
        text = _extract_text(pdf_path)
        if not text:
            return {"index": index, "file": pdf_path.name, "status": "empty"}

        content_hash = hashlib.md5(text.encode("utf-8")).hexdigest()
        raw_tokens = len(_WORKER_TOKENIZER.encode(text))
        chunks = chunk_document(_WORKER_TOKENIZER, text, _WORKER_CONFIG)
        kept_tokens = _sum_chunk_tokens(chunks)
        return {
            "index": index,
            "file": pdf_path.name,
            "status": "ok",
            "content_hash": content_hash,
            "raw_tokens": raw_tokens,
            "chunks": chunks,
            "chunk_count": len(chunks),
            "kept_tokens": kept_tokens,
            "retention_ratio": (kept_tokens / raw_tokens) if raw_tokens else 1.0,
        }
    except Exception as exc:
        return {
            "index": index,
            "file": pdf_path.name,
            "status": "error",
            "error": str(exc),
        }


def main() -> None:
    if not CACHE_PATH.exists():
        raise SystemExit(f"chunk cache not found: {CACHE_PATH}")

    papers = sorted(PAPERS_DIR.glob("*.pdf"))
    total_docs = len(papers)
    workers = _default_worker_count(total_docs)
    progress_every = max(1, _env_int("REPAIR_PROGRESS_EVERY", 25))
    min_raw_tokens = _env_int("REPAIR_MIN_RAW_TOKENS", 5000)
    min_retention_ratio = _env_float("REPAIR_MIN_RETENTION_RATIO", 0.10)
    single_chunk_token_limit = _env_int("REPAIR_SINGLE_CHUNK_TOKEN_LIMIT", 3000)
    dry_run = os.environ.get("REPAIR_DRY_RUN", "0") == "1"
    write_backup = os.environ.get("REPAIR_WRITE_BACKUP", "1") == "1"

    cache = json.loads(CACHE_PATH.read_text())
    chunk_cfg = ChunkerConfig.from_env()
    t0 = time.time()

    print(f"Loaded cache entries: {len(cache)} from {CACHE_PATH}")
    print(f"Papers discovered: {total_docs} in {PAPERS_DIR}")
    print(
        f"Workers={workers}, min_raw_tokens={min_raw_tokens}, "
        f"min_retention_ratio={min_retention_ratio}, "
        f"single_chunk_token_limit={single_chunk_token_limit}",
        flush=True,
    )

    config_dict = asdict(chunk_cfg)
    inspected = empty_docs = inspect_errors = 0
    suspects_by_hash: dict[str, dict] = {}
    suspect_files = 0

    with ProcessPoolExecutor(
        max_workers=workers,
        initializer=_worker_init,
        initargs=(config_dict,),
    ) as executor:
        futures = {
            executor.submit(_inspect_pdf, i, str(pdf_path)): (i, pdf_path)
            for i, pdf_path in enumerate(papers, 1)
        }
        for future in as_completed(futures):
            i, pdf_path = futures[future]
            inspected += 1
            try:
                result = future.result()
            except Exception as exc:
                inspect_errors += 1
                print(f"[{inspected:04d}/{total_docs}] INSPECT ERROR {pdf_path.name}: {exc}", flush=True)
                continue

            status = result.get("status")
            if status == "empty":
                empty_docs += 1
            elif status == "error":
                inspect_errors += 1
                print(
                    f"[{inspected:04d}/{total_docs}] INSPECT ERROR {result.get('file')}: "
                    f"{result.get('error')}",
                    flush=True,
                )
            else:
                content_hash = result["content_hash"]
                raw_tokens = int(result["raw_tokens"])
                cached = cache.get(content_hash)

                reasons: list[str] = []
                chunk_count = 0
                kept_tokens = 0
                max_chunk_tokens = 0
                retention_ratio = 0.0

                if cached is None:
                    reasons.append("missing_cache")
                else:
                    chunk_count = len(cached)
                    kept_tokens = _sum_chunk_tokens(cached)
                    max_chunk_tokens = _max_chunk_tokens(cached)
                    retention_ratio = (kept_tokens / raw_tokens) if raw_tokens else 1.0

                    if chunk_count == 0:
                        reasons.append("zero_chunks")

                    if raw_tokens >= min_raw_tokens and retention_ratio < min_retention_ratio:
                        reasons.append("low_retention")

                    if (
                        raw_tokens >= min_raw_tokens
                        and chunk_count == 1
                        and max_chunk_tokens >= single_chunk_token_limit
                    ):
                        reasons.append("single_huge_chunk")

                if reasons:
                    suspect_files += 1
                    existing = suspects_by_hash.get(content_hash)
                    if existing is None:
                        suspects_by_hash[content_hash] = {
                            "index": result["index"],
                            "file": result["file"],
                            "pdf_path": str(pdf_path),
                            "content_hash": content_hash,
                            "raw_tokens": raw_tokens,
                            "before_chunk_count": chunk_count,
                            "before_kept_tokens": kept_tokens,
                            "before_retention_ratio": retention_ratio,
                            "before_max_chunk_tokens": max_chunk_tokens,
                            "reasons": sorted(set(reasons)),
                            "also_files": [],
                        }
                    else:
                        existing["also_files"].append(result["file"])
                        existing["reasons"] = sorted(set(existing["reasons"] + reasons))

            if inspected % progress_every == 0 or inspected == total_docs:
                elapsed = time.time() - t0
                rate = inspected / (elapsed / 3600) if elapsed > 0 else 0
                print(
                    f"[{inspected:04d}/{total_docs}] inspected | "
                    f"suspect_files={suspect_files} unique_hashes={len(suspects_by_hash)} "
                    f"| {rate:.0f} docs/hr",
                    flush=True,
                )

    suspects = sorted(suspects_by_hash.values(), key=lambda x: x["index"])
    print("\nInspection summary:")
    print(f"  Inspected docs : {inspected}")
    print(f"  Empty docs     : {empty_docs}")
    print(f"  Inspect errors : {inspect_errors}")
    print(f"  Suspect files  : {suspect_files}")
    print(f"  Suspect hashes : {len(suspects)}")

    if suspects:
        print("\nTop suspects:")
        for row in suspects[:20]:
            print(
                f"  - {row['file']}: reasons={','.join(row['reasons'])} "
                f"raw={row['raw_tokens']} chunks={row['before_chunk_count']} "
                f"ret={row['before_retention_ratio']:.4f}",
                flush=True,
            )

    if not suspects:
        print("\nNo suspicious entries detected. Nothing to repair.")
        return

    if dry_run:
        print("\nDry run enabled (REPAIR_DRY_RUN=1): cache not modified.")
        return

    repaired = 0
    repair_errors = 0
    reports: list[dict] = []

    repair_workers = max(1, min(workers, len(suspects)))
    print(f"\nRe-chunking {len(suspects)} suspect hashes with {repair_workers} workers...", flush=True)
    repair_t0 = time.time()

    with ProcessPoolExecutor(
        max_workers=repair_workers,
        initializer=_worker_init,
        initargs=(config_dict,),
    ) as executor:
        futures = {
            executor.submit(_rechunk_pdf, row["index"], row["pdf_path"]): row
            for row in suspects
        }
        done = 0
        for future in as_completed(futures):
            row = futures[future]
            done += 1
            try:
                result = future.result()
            except Exception as exc:
                repair_errors += 1
                print(f"[{done:04d}/{len(suspects)}] REPAIR ERROR {row['file']}: {exc}", flush=True)
                continue

            if result.get("status") != "ok":
                repair_errors += 1
                print(
                    f"[{done:04d}/{len(suspects)}] REPAIR ERROR {row['file']}: "
                    f"{result.get('error', result.get('status'))}",
                    flush=True,
                )
                continue

            content_hash = result["content_hash"]
            cache[content_hash] = result["chunks"]
            repaired += 1

            reports.append(
                {
                    "file": row["file"],
                    "also_files": row["also_files"],
                    "content_hash": content_hash,
                    "reasons": row["reasons"],
                    "before_chunk_count": row["before_chunk_count"],
                    "before_kept_tokens": row["before_kept_tokens"],
                    "before_retention_ratio": row["before_retention_ratio"],
                    "after_chunk_count": result["chunk_count"],
                    "after_kept_tokens": result["kept_tokens"],
                    "after_retention_ratio": result["retention_ratio"],
                    "raw_tokens": result["raw_tokens"],
                }
            )

            if done % progress_every == 0 or done == len(suspects):
                elapsed = time.time() - repair_t0
                rate = done / (elapsed / 3600) if elapsed > 0 else 0
                print(
                    f"[{done:04d}/{len(suspects)}] repaired={repaired} errors={repair_errors} "
                    f"| {rate:.0f} docs/hr",
                    flush=True,
                )

    if write_backup:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = CACHE_PATH.with_name(f"chunk_cache.backup_{stamp}.json")
        shutil.copy2(CACHE_PATH, backup_path)
        print(f"\nBackup written: {backup_path}")

    CACHE_PATH.write_text(json.dumps(cache))
    report_path = STORAGE_DIR / "chunk_cache_repair_report.json"
    report_path.write_text(json.dumps(reports, indent=2))

    elapsed = time.time() - t0
    print("\nRepair summary:")
    print(f"  Repaired entries : {repaired}")
    print(f"  Repair errors    : {repair_errors}")
    print(f"  Updated cache    : {CACHE_PATH}")
    print(f"  Repair report    : {report_path}")
    print(f"  Elapsed          : {elapsed:.0f}s ({elapsed/60:.1f} min)")


if __name__ == "__main__":
    main()
