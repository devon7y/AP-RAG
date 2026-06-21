"""
Manual validation of scientific and book chunkers against real PDFs.

Tests four documents covering the main structural patterns:
  - Review article:  Grammaticalgenderreview_AcceptedManuscript.pdf
  - PhD dissertation: 2020EganCiaraPhD.pdf
  - Edited volume:   1983_Book_HandbookOfHumorResearch.pdf
  - Monograph:       Heidegger, Martin - Being and Time [trans...].pdf

Usage (from repo root):
    cd westbury && python test_chunkers_pdf.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from pypdf import PdfReader

from pipeline.book_chunker import BookChunkerConfig, chunk_book_document, detect_book_sections
from pipeline.scientific_chunker import ChunkerConfig, chunk_document, detect_sections


# ── Tokenizer (word-count, no external model needed) ──────────────────────────


class WordTokenizer:
    """Treats each whitespace-delimited token as one unit."""

    def encode(self, text: str) -> list[int]:
        return list(range(len(text.split()))) if text and text.strip() else []

    def decode(self, tokens: list[int]) -> str:
        return " ".join(f"w{i}" for i in tokens)


# ── PDF extraction ─────────────────────────────────────────────────────────────


def extract_pdf_text(path: str | Path) -> str:
    reader = PdfReader(str(path))
    pages = []
    for page in reader.pages:
        t = (page.extract_text() or "").strip()
        if t:
            pages.append(t)
    return "\f".join(pages)  # form-feed as page separator (used by furniture stripper)


# ── Report helpers ─────────────────────────────────────────────────────────────


def _section_summary(sections, max_show: int = 30) -> None:
    kept = [s for s in sections if not s.is_excluded]
    excluded = [s for s in sections if s.is_excluded]

    print(f"  Sections detected: {len(sections)}  "
          f"(kept: {len(kept)}, excluded: {len(excluded)})")

    for s in sections[:max_show]:
        flag = " [EXCLUDED]" if s.is_excluded else ""
        preview = s.text[:60].replace("\n", " ").strip()
        print(f"    {'[X]' if s.is_excluded else '   '} {s.title!r:55s} | {preview!r}")

    if len(sections) > max_show:
        print(f"    ... ({len(sections) - max_show} more sections)")


def _chunk_stats(chunks) -> None:
    if not chunks:
        print("  !! No chunks produced")
        return
    tok = [c.get("token_count_without_overlap", c.get("tokens", 0)) for c in chunks]
    n = len(tok)
    print(f"  Chunks: {n}  |  "
          f"min={min(tok)}  mean={sum(tok)//n}  max={max(tok)} tokens")

    # Section distribution
    seen: list[str] = []
    for c in chunks:
        t = c.get("section_title", "?")
        if not seen or seen[-1] != t:
            seen.append(t)
    print(f"  Unique sections in chunks: {len(seen)}")
    for s in seen[:20]:
        print(f"    → {s!r}")
    if len(seen) > 20:
        print(f"    ... ({len(seen)-20} more)")


def run_test(
    label: str,
    pdf_path: str | Path,
    *,
    use_book_chunker: bool = False,
) -> None:
    sep = "=" * 70
    print(f"\n{sep}")
    print(f"  {label}")
    print(f"  {Path(pdf_path).name}")
    print(sep)

    if not Path(pdf_path).exists():
        print(f"  !! FILE NOT FOUND: {pdf_path}")
        return

    text = extract_pdf_text(pdf_path)
    print(f"  Extracted text: {len(text):,} chars")

    tok = WordTokenizer()

    if use_book_chunker:
        config = BookChunkerConfig()
        sections = detect_book_sections(text, config)
        print("\n── Book section detection ──")
        _section_summary(sections)
        print("\n── Chunks ──")
        chunks = chunk_book_document(tok, text, config)
        _chunk_stats(chunks)
    else:
        config = ChunkerConfig()
        sections = detect_sections(text, config)
        print("\n── Scientific section detection ──")
        _section_summary(sections)
        print("\n── Chunks ──")
        chunks = chunk_document(tok, text, config)
        _chunk_stats(chunks)


# ── Test cases ─────────────────────────────────────────────────────────────────

SMALLER_PAPERS = Path("/Users/devon7y/Downloads/smaller_papers")
PAPERS_LARGE = Path("/Users/devon7y/Downloads/papers_large")

if __name__ == "__main__":
    # ── smaller_papers: review article ────────────────────────────────────────
    run_test(
        "REVIEW ARTICLE — numbered sections with descriptive titles",
        SMALLER_PAPERS / "Grammaticalgenderreview_AcceptedManuscript.pdf",
        use_book_chunker=False,
    )

    # ── smaller_papers: PhD dissertation ──────────────────────────────────────
    run_test(
        "PhD DISSERTATION — Chapter N. with N.M. subsections",
        SMALLER_PAPERS / "2020EganCiaraPhD.pdf",
        use_book_chunker=False,
    )

    # ── papers_large: edited volume ───────────────────────────────────────────
    run_test(
        "EDITED VOLUME — numbered chapters, each by different author",
        PAPERS_LARGE / "1983_Book_HandbookOfHumorResearch.pdf",
        use_book_chunker=True,
    )

    # ── papers_large: philosophical monograph ─────────────────────────────────
    run_test(
        "MONOGRAPH — Part/Division/§N structure",
        PAPERS_LARGE / "Heidegger, Martin - Being and Time [trans. Macquarrie & Robinson] (Blackwell, 1962).pdf",
        use_book_chunker=True,
    )
