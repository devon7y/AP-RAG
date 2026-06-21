#!/usr/bin/env python3
"""Test the fixed scientific chunker against the 112 excluded PDFs.

Run from the westbury/ directory:
    python test_excluded_pdfs.py
"""
import signal
import sys
import time
from pathlib import Path

import tiktoken
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).parent))
from pipeline.scientific_chunker import ChunkerConfig, chunk_document

EXCLUDED_DIR = Path.home() / "Downloads" / "papers_excluded_not_processed_9061176"
TIMEOUT = 60  # seconds per PDF — well under the original 10-min hang


class TimeoutError(RuntimeError):
    pass


def _handler(signum, frame):
    raise TimeoutError("still hanging after fix!")


def process_pdf(pdf_path: Path, tokenizer, config: ChunkerConfig) -> dict:
    try:
        reader = PdfReader(str(pdf_path))
        page_texts = [(page.extract_text() or "").strip() for page in reader.pages]
        text = "\n\f\n".join(p for p in page_texts if p).strip()
        if not text:
            return {"status": "skipped", "reason": "no text extracted"}

        signal.signal(signal.SIGALRM, _handler)
        signal.alarm(TIMEOUT)
        t0 = time.time()
        try:
            chunks = chunk_document(tokenizer, text, config)
            signal.alarm(0)
        except TimeoutError as e:
            return {"status": "timeout", "reason": str(e), "elapsed": time.time() - t0}

        return {
            "status": "ok",
            "chunks": len(chunks),
            "elapsed": round(time.time() - t0, 2),
        }
    except Exception as exc:
        return {"status": "error", "reason": str(exc)}


def main():
    tokenizer = tiktoken.get_encoding("cl100k_base")
    config = ChunkerConfig.from_env()
    print(f"Config: target={config.target_tokens} max={config.max_tokens} "
          f"min={config.min_tokens} overlap={config.overlap_tokens}\n")

    pdfs = sorted(EXCLUDED_DIR.glob("*.pdf"))
    print(f"Found {len(pdfs)} PDFs in {EXCLUDED_DIR}\n")

    ok = timeout = skipped = errors = 0
    t_total = time.time()

    for i, pdf_path in enumerate(pdfs, 1):
        result = process_pdf(pdf_path, tokenizer, config)
        status = result["status"]
        if status == "ok":
            ok += 1
            print(f"[{i:03d}/{len(pdfs)}] OK  ({result['chunks']:3d} chunks, {result['elapsed']:.1f}s)  {pdf_path.name[:70]}")
        elif status == "timeout":
            timeout += 1
            print(f"[{i:03d}/{len(pdfs)}] TIMEOUT ({result['elapsed']:.0f}s)  {pdf_path.name[:70]}")
        elif status == "skipped":
            skipped += 1
            print(f"[{i:03d}/{len(pdfs)}] SKIP  {pdf_path.name[:70]}")
        else:
            errors += 1
            print(f"[{i:03d}/{len(pdfs)}] ERR   {result['reason'][:60]}  {pdf_path.name[:50]}")

    elapsed = time.time() - t_total
    print(f"\n{'='*60}")
    print(f"Done in {elapsed:.1f}s")
    print(f"  OK      : {ok}")
    print(f"  Timeout : {timeout}  ← still broken after fix")
    print(f"  Skipped : {skipped}  (no text)")
    print(f"  Errors  : {errors}")


if __name__ == "__main__":
    main()
