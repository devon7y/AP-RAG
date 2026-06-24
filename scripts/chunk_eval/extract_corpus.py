#!/usr/bin/env python3
"""
Chunk-size eval — step 1 (LOCAL): extract PDF text to a corpus JSONL.

Replicates pipeline/ingest.py's extraction EXACTLY (pypdf, per-page
`extract_text()`, pages joined with "\\n\\f\\n") so the eval chunks the same
text production sees. Page boundaries are preserved as form-feeds so the
structure-aware chunker can strip running heads/footers just like in ingest.

Usage:
    python scripts/chunk_eval/extract_corpus.py \
        --papers /Users/devon7y/VS_Code/semanticfa/papers \
        --out    scripts/chunk_eval/corpus.jsonl

Output: one JSON object per line: {doc_id, filename, n_pages, n_chars, text}.
Empty/scanned PDFs (no extractable text layer) are reported and skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pypdf import PdfReader


def extract_pdf_text(pdf_path: Path) -> tuple[str, int]:
    """Return (text, n_pages) with pages joined by form-feed, matching ingest."""
    reader = PdfReader(str(pdf_path))
    page_texts = [(page.extract_text() or "").strip() for page in reader.pages]
    text = "\n\f\n".join(p for p in page_texts if p).strip()
    return text, len(page_texts)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--papers", required=True, type=Path, help="directory of PDFs")
    ap.add_argument("--out", required=True, type=Path, help="output corpus.jsonl")
    ap.add_argument("--min-chars", type=int, default=500,
                    help="skip docs whose extracted text is shorter than this (likely scanned)")
    args = ap.parse_args()

    pdfs = sorted(args.papers.glob("*.pdf"))
    if not pdfs:
        print(f"No PDFs found in {args.papers}", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    kept, skipped_empty, failed = 0, [], []
    page_counts: list[int] = []

    with args.out.open("w") as f:
        for pdf in pdfs:
            try:
                text, n_pages = extract_pdf_text(pdf)
            except Exception as e:  # noqa: BLE001 — report and continue
                failed.append((pdf.name, f"{type(e).__name__}: {e}"))
                continue
            if len(text) < args.min_chars:
                skipped_empty.append((pdf.name, len(text)))
                continue
            rec = {
                "doc_id": pdf.stem,
                "filename": pdf.name,
                "n_pages": n_pages,
                "n_chars": len(text),
                "text": text,
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            kept += 1
            page_counts.append(n_pages)

    print(f"Extracted {kept}/{len(pdfs)} PDFs → {args.out}")
    if page_counts:
        page_counts.sort()
        print(f"  pages: min={page_counts[0]} median={page_counts[len(page_counts)//2]} "
              f"max={page_counts[-1]}")
    if skipped_empty:
        print(f"  skipped (text < {args.min_chars} chars — likely scanned/no text layer): "
              f"{len(skipped_empty)}")
        for name, n in skipped_empty[:10]:
            print(f"    {name} ({n} chars)")
    if failed:
        print(f"  FAILED to read: {len(failed)}")
        for name, err in failed[:10]:
            print(f"    {name}: {err}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
