#!/usr/bin/env python3
"""Audit whether each ingested paper's text is actually in the PDF of that name.

The reader shows a passage from the store and opens the PDF named in the store. If those
two disagree, a citation opens the wrong paper. This tool measures that disagreement and
separates its two very different causes:

  located       the passage places cleanly — reader works
  same-paper    the passage's words are all in the PDF but not in that ORDER, so
                sequence alignment fails. Ingest extracted the text with a different
                extractor (pypdf jumbles two-column layouts; the viewer reads PyMuPDF),
                so the PDF is right and only the highlight is missing.
  wrong-paper   the passage's words are largely absent — the file under this name is a
                DIFFERENT paper than the one ingested under it. A citation opens the
                wrong PDF and its APA reference names the wrong work.
  no-text       the PDF has no usable text layer (a scan); nothing can be located.

Word presence is order-independent, which is what tells "same paper, reordered text"
apart from "different paper".

MUST RUN ON THE PC (needs Qdrant on :6333, the papers on D:, and the manifest):

    C:\\rag_server\\venv\\Scripts\\python audit_store_vs_files.py --limit 400
    C:\\rag_server\\venv\\Scripts\\python audit_store_vs_files.py --all --out audit.json

Read-only: opens PDFs and scrolls Qdrant, writes nothing but the optional report.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

# aprag_pdf.py sits beside this file on the PC (C:\rag_server) but one level up in the
# repo, so the script runs from either location.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [_HERE, os.path.dirname(_HERE), r"C:\rag_server"]

import aprag_pdf as pdfsrv  # noqa: E402

PAPERS_DIR = os.environ.get("PAPERS_DIR", r"D:\aprag_papers")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
CHUNK_COLLECTION = "lightrag_vdb_chunks"

#: Words too common to distinguish one paper from another.
STOP = {
    "the", "and", "for", "with", "from", "that", "this", "were", "was", "are",
    "their", "which", "have", "been", "also", "more", "than", "these", "those",
    "when", "such", "into", "each", "other", "between", "would", "could", "there",
}
#: A passage counts as "present" in the PDF when this share of its distinctive words is.
SAME_PAPER_COVERAGE = 0.6
#: Below this many characters of extracted text, treat the PDF as a scan.
MIN_TEXT_CHARS = 400


def sample_chunks(want: int, take_all: bool) -> dict[str, str]:
    """One representative chunk per file, straight from the vector store."""
    from qdrant_client import QdrantClient

    client = QdrantClient(url=QDRANT_URL, timeout=120)
    by_file: dict[str, str] = {}
    offset = None
    while take_all or len(by_file) < want:
        points, offset = client.scroll(
            collection_name=CHUNK_COLLECTION, limit=512,
            with_payload=True, with_vectors=False, offset=offset)
        if not points:
            break
        for point in points:
            payload = point.payload or {}
            filename = payload.get("file_path") or ""
            content = payload.get("content") or ""
            # Short chunks (figure captions, headers) are poor evidence either way.
            if filename and filename not in by_file and len(content) > 400:
                by_file[filename] = content
        if offset is None:
            break
    return by_file


def distinctive_words(passage: str) -> set[str]:
    words = {re.sub(r"[^a-z0-9]", "", w.lower()) for w in passage.split()}
    return {w for w in words if len(w) > 4 and w not in STOP}


def classify(filename: str, content: str) -> tuple[str, float]:
    """(verdict, coverage) for one paper."""
    import pymupdf

    path = os.path.join(PAPERS_DIR, os.path.basename(filename))
    if not os.path.isfile(path):
        return "missing-file", 0.0

    # Chunks are stored as "<ingest blurb>\n\n<passage>"; the blurb is model-written and
    # is in no paper, so compare only the passage.
    passage = content.split("\n\n", 1)[1] if "\n\n" in content else content

    if pdfsrv.locate_quote(path, passage)["page"] is not None:
        return "located", 1.0

    doc = pymupdf.open(path)
    try:
        text = " ".join(doc[i].get_text() for i in range(doc.page_count)).lower()
    finally:
        doc.close()
    if len(text.strip()) < MIN_TEXT_CHARS:
        return "no-text", 0.0

    flat = re.sub(r"[^a-z0-9 ]", " ", text)
    words = distinctive_words(passage)
    if not words:
        return "located", 1.0
    coverage = sum(1 for w in words if w in flat) / len(words)
    return ("same-paper" if coverage >= SAME_PAPER_COVERAGE else "wrong-paper"), coverage


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=400,
                        help="how many distinct papers to sample (default 400)")
    parser.add_argument("--all", action="store_true",
                        help="audit every paper in the store (slow: ~20ms each)")
    parser.add_argument("--out", help="write the full per-paper verdict to this JSON file")
    args = parser.parse_args()

    by_file = sample_chunks(args.limit, args.all)
    print(f"papers sampled from the store: {len(by_file)}\n")

    counts: dict[str, int] = {}
    rows: list[dict] = []
    for i, (filename, content) in enumerate(sorted(by_file.items()), 1):
        verdict, coverage = classify(filename, content)
        counts[verdict] = counts.get(verdict, 0) + 1
        rows.append({"filename": filename, "verdict": verdict,
                     "coverage": round(coverage, 3)})
        if i % 100 == 0:
            print(f"  …{i}/{len(by_file)}", flush=True)

    total = sum(counts.values()) or 1
    print("\nverdicts:")
    for verdict in ("located", "same-paper", "wrong-paper", "no-text", "missing-file"):
        n = counts.get(verdict, 0)
        print(f"  {verdict:14s} {n:6d}  ({n / total * 100:5.1f}%)")

    wrong = sorted((r for r in rows if r["verdict"] == "wrong-paper"),
                   key=lambda r: r["coverage"])
    if wrong:
        print(f"\nfiles holding a DIFFERENT paper than the store thinks ({len(wrong)}):")
        for row in wrong[:40]:
            print(f"   {row['filename']:40s} {row['coverage'] * 100:4.0f}% of words present")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump({"counts": counts, "papers": rows}, fh, indent=2)
        print(f"\nfull report: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
