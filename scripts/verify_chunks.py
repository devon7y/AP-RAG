#!/usr/bin/env python3
"""Verify chunk quality for the excluded PDFs after the fix."""
import signal
import sys
import time
from pathlib import Path
from collections import Counter

import tiktoken
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).parent))
from pipeline.scientific_chunker import ChunkerConfig, chunk_document

EXCLUDED_DIR = Path.home() / "Downloads" / "papers_excluded_not_processed_9061176"
TIMEOUT = 60

class TimeoutError(RuntimeError): pass
def _handler(signum, frame): raise TimeoutError()
signal.signal(signal.SIGALRM, _handler)


def process_pdf(pdf_path, tokenizer, config):
    reader = PdfReader(str(pdf_path))
    page_texts = [(page.extract_text() or "").strip() for page in reader.pages]
    text = "\n\f\n".join(p for p in page_texts if p).strip()
    if not text:
        return None, None
    signal.alarm(TIMEOUT)
    try:
        chunks = chunk_document(tokenizer, text, config)
    finally:
        signal.alarm(0)
    return chunks, text


def main():
    tokenizer = tiktoken.get_encoding("cl100k_base")
    config = ChunkerConfig.from_env()

    pdfs = sorted(EXCLUDED_DIR.glob("*.pdf"))

    all_token_counts = []
    undersized = []   # chunks below min_tokens
    oversized = []    # chunks above max_tokens
    empty_chunks = []
    problem_pdfs = []

    print(f"{'PDF':<60} {'chunks':>6} {'<min':>5} {'>max':>5} {'avg_tok':>7} {'min_tok':>7} {'max_tok':>7}")
    print("-" * 105)

    ok_count = 0
    for pdf_path in pdfs:
        try:
            chunks, text = process_pdf(pdf_path, tokenizer, config)
        except Exception as e:
            continue
        if chunks is None:
            continue

        ok_count += 1
        token_counts = [c.get("token_count_without_overlap", c.get("tokens", 0)) for c in chunks]
        all_token_counts.extend(token_counts)

        n_under = sum(1 for t in token_counts if t < config.min_tokens)
        n_over  = sum(1 for t in token_counts if t > config.max_tokens)
        n_empty = sum(1 for c in chunks if not c.get("content", "").strip())

        avg = sum(token_counts) / len(token_counts) if token_counts else 0
        mn  = min(token_counts) if token_counts else 0
        mx  = max(token_counts) if token_counts else 0

        flag = ""
        if n_empty > 0: flag += " EMPTY"
        if n_over  > 0: flag += " OVER"

        print(f"{pdf_path.name[:60]:<60} {len(chunks):>6} {n_under:>5} {n_over:>5} {avg:>7.0f} {mn:>7} {mx:>7}{flag}")

        for i, chunk in enumerate(chunks):
            content = chunk.get("content", "")
            tok = chunk.get("token_count_without_overlap", chunk.get("tokens", 0))
            if not content.strip():
                empty_chunks.append((pdf_path.name, i, tok))
            if tok < config.min_tokens:
                undersized.append(tok)
            if tok > config.max_tokens:
                oversized.append((pdf_path.name, i, tok))

    print("-" * 105)
    print(f"\nProcessed {ok_count} PDFs | {len(all_token_counts)} total chunks")
    print(f"  Config: min={config.min_tokens}  target={config.target_tokens}  max={config.max_tokens}")
    print(f"\nChunk token distribution:")
    if all_token_counts:
        buckets = Counter()
        for t in all_token_counts:
            if   t < 100:  buckets["<100"] += 1
            elif t < 300:  buckets["100-299"] += 1
            elif t < 600:  buckets["300-599"] += 1
            elif t < 800:  buckets["600-799"] += 1
            elif t < 1000: buckets["800-999"] += 1
            else:          buckets[">=1000"] += 1
        for label in ["<100", "100-299", "300-599", "600-799", "800-999", ">=1000"]:
            n = buckets[label]
            bar = "█" * (n // max(1, len(all_token_counts) // 50))
            print(f"  {label:>8}: {n:5d}  {bar}")

    print(f"\nUndersized chunks (<{config.min_tokens} tokens): {len(undersized)}")
    if undersized:
        avg_u = sum(undersized) / len(undersized)
        print(f"  avg size: {avg_u:.0f} tokens  (these are tolerated — unkillable tiny sections)")

    print(f"Oversized chunks (>{config.max_tokens} tokens): {len(oversized)}")
    for fname, idx, tok in oversized[:10]:
        print(f"  {fname[:50]}  chunk {idx}: {tok} tokens")

    print(f"Empty chunks: {len(empty_chunks)}")
    for fname, idx, tok in empty_chunks[:10]:
        print(f"  {fname[:50]}  chunk {idx}: {tok} tokens")

    # Spot-check a few chunks from a previously-problematic PDF
    print("\n--- Spot-check: first 3 chunks of 1-s2.0-S0191886921006322-main.pdf ---")
    spot = EXCLUDED_DIR / "1-s2.0-S0191886921006322-main.pdf"
    if spot.exists():
        chunks, _ = process_pdf(spot, tokenizer, config)
        if chunks:
            for c in chunks[:3]:
                content = c.get("content", "")
                tok = c.get("token_count_without_overlap", c.get("tokens", 0))
                print(f"  [{tok} tok] {content[:200].replace(chr(10), ' ')!r}")


if __name__ == "__main__":
    main()
