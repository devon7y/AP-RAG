#!/usr/bin/env python3
"""
dedup_doc_status.py — Remove stale/duplicate doc entries from LightRAG storage.

Strategy:
  1. Re-extract text from all PDFs using the exact same method as ingest_cml_octen.py
     (single-newline join, tiktoken truncation at MAX_DOC_TOKENS).
  2. Compute the canonical doc ID for each PDF (MD5 of the final text).
  3. Keep only doc_status and full_docs entries that match a canonical ID.
  4. Everything else is from a previous run that used different text extraction
     (e.g. double-newline join) — remove it.

Preserves 'processed' docs whose canonical ID still exists in storage.
"""

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

WORKDIR     = Path("/home/devon7y/scratch/devon7y/westbury_rag")
PAPERS_DIR  = WORKDIR / "papers"
STORAGE_DIR = WORKDIR / "rag_storage_octen"
MAX_DOC_TOKENS = 120_000


def compute_doc_id(text: str) -> str:
    return "doc-" + hashlib.md5(text.encode()).hexdigest()


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        tokens = enc.encode(text)
        if len(tokens) <= max_tokens:
            return text
        return enc.decode(tokens[:max_tokens])
    except Exception:
        limit = max_tokens * 4
        return text[:limit] if len(text) > limit else text


def main():
    from pypdf import PdfReader

    pdfs = sorted(PAPERS_DIR.glob("*.pdf"))
    print(f"Found {len(pdfs)} PDFs in {PAPERS_DIR}")

    print("Re-extracting text to compute canonical doc IDs...")
    canonical_ids: set[str] = set()
    id_to_name: dict[str, str] = {}
    read_errors = 0

    for i, pdf_path in enumerate(pdfs, 1):
        if i % 200 == 0:
            print(f"  {i}/{len(pdfs)} ({len(canonical_ids)} IDs so far)...")
        try:
            reader = PdfReader(str(pdf_path))
            text = "\n".join(page.extract_text() or "" for page in reader.pages).strip()
            if not text:
                continue
            text = truncate_to_tokens(text, MAX_DOC_TOKENS)
            doc_id = compute_doc_id(text)
            canonical_ids.add(doc_id)
            id_to_name[doc_id] = pdf_path.name
        except Exception as e:
            print(f"  ERROR reading {pdf_path.name}: {e}")
            read_errors += 1

    print(f"Canonical IDs: {len(canonical_ids)}  (read errors: {read_errors})")

    # ── Clean kv_store_doc_status.json ─────────────────────────────────────────
    status_path = STORAGE_DIR / "kv_store_doc_status.json"
    with open(status_path) as f:
        doc_status = json.load(f)

    before = len(doc_status)
    kept_status = {k: v for k, v in doc_status.items() if k in canonical_ids}
    removed = before - len(kept_status)
    kept_counts = Counter(v["status"] for v in kept_status.values())

    print(f"\nkv_store_doc_status.json: {before} → {len(kept_status)} entries ({removed} removed)")
    print(f"  Kept breakdown: {dict(kept_counts)}")

    # Backup then overwrite
    backup = status_path.with_suffix(".json.bak")
    backup.write_text(status_path.read_text())
    with open(status_path, "w") as f:
        json.dump(kept_status, f)
    print(f"  Backup saved to {backup}")

    # ── Clean kv_store_full_docs.json ──────────────────────────────────────────
    full_docs_path = STORAGE_DIR / "kv_store_full_docs.json"
    with open(full_docs_path) as f:
        full_docs = json.load(f)

    before = len(full_docs)
    kept_docs = {k: v for k, v in full_docs.items() if k in canonical_ids}
    removed = before - len(kept_docs)

    print(f"\nkv_store_full_docs.json: {before} → {len(kept_docs)} entries ({removed} removed)")

    backup = full_docs_path.with_suffix(".json.bak")
    backup.write_text(full_docs_path.read_text())
    with open(full_docs_path, "w") as f:
        json.dump(kept_docs, f)
    print(f"  Backup saved to {backup}")

    # ── Summary ────────────────────────────────────────────────────────────────
    processed = kept_counts.get("processed", 0)
    pending   = kept_counts.get("pending", 0)
    remaining = len(canonical_ids) - processed
    print(f"\nSummary:")
    print(f"  {processed} papers already processed (will be skipped on next run)")
    print(f"  {pending} papers pending")
    print(f"  {remaining} papers still need ingestion")
    print("\nDone.")


if __name__ == "__main__":
    main()
