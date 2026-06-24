"""
Structure-based document router for AP-RAG.

Classifies each document as a ``"book"`` or a ``"paper"`` from its *structure*
(not a page-count threshold) and dispatches to the matching structure-aware
chunker:

  - ``book``  → :func:`pipeline.book_chunker.chunk_book_document`
  - ``paper`` → :func:`pipeline.scientific_chunker.chunk_document`

Why structure, not page count: a 60-page review article is a *paper*; a 35-page
edited-volume chapter or handbook is a *book*. The recent RAG literature routes
on structure — table-of-contents extractability and chapter/heading detection —
rather than length (e.g. BookRAG 2025; HiChunk 2025). Page count is used here
only as a cheap tie-breaker when the structural signals are absent or ambiguous.

Signals (one pass over the extracted text; page boundaries are the form-feed
``\\f`` markers the PDF text extractor inserts between pages):

  - book  : a detectable table-of-contents page, OR ≥ ``min_chapters`` distinct
            chapter / part / division / §-section headers.
  - paper : ≥ ``min_imrad`` distinct canonical IMRaD section headers
            (Abstract / Introduction / Methods / Results / Discussion / …).
  - tie   : page count ≥ ``page_threshold`` → book, else → paper.

IMRaD headers are checked *before* book-structural ones, so a paper that
numbers its sections ("I. Introduction", "II. Related Work") is still routed to
the paper chunker rather than miscounted as chapters.

Used by :mod:`pipeline.ingest` when ``CHUNKER_TYPE=auto``.

Integration::

    from pipeline.document_router import make_auto_chunker, RouterConfig

    rag = LightRAG(chunking_func=make_auto_chunker(), ...)

Environment variables (consumed by :meth:`RouterConfig.from_env`):
    ROUTER_PAGE_THRESHOLD   page-count tie-breaker, ≥ ⇒ book (default 50)
    ROUTER_MIN_CHAPTERS     distinct chapter/part headers ⇒ book (default 3)
    ROUTER_MIN_IMRAD        distinct IMRaD section headers ⇒ paper (default 3)
    ROUTER_DETECT_TOC       "1"/"0" enable TOC-page detection (default 1)
    ROUTER_TOC_SCAN_PAGES   leading pages scanned for a TOC (default 15)
    ROUTER_DEBUG            "1"/"0" print the per-document routing decision (default 0)
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import Any, Callable

from pipeline.book_chunker import (
    BookChunkerConfig,
    _BOOK_CHAPTER,
    _BOOK_DIVISION,
    _BOOK_PART,
    _SECTION_SYMBOL,
    _looks_like_toc_page,
    _split_page_into_blocks,
    chunk_book_document,
)
from pipeline.scientific_chunker import (
    ChunkerConfig,
    Tokenizer,
    _NUM_PREFIX,
    _NUM_PREFIX_DOT,
    _classify_section_header,
    chunk_document,
)

# Canonical IMRaD / scientific-paper section names. A document with several of
# these as hard headers is structurally a paper. Kept narrower than the full
# scientific_chunker._HARD_SECTIONS so generic words ("summary", "overview")
# that also appear in book chapters do not, on their own, force a "paper" verdict.
_IMRAD_CORE: frozenset[str] = frozenset(
    {
        "abstract",
        "introduction",
        "background",
        "related work",
        "literature review",
        "method",
        "methods",
        "methodology",
        "materials and methods",
        "experimental setup",
        "experimental design",
        "results",
        "findings",
        "discussion",
        "general discussion",
        "conclusion",
        "conclusions",
        "references",
        "bibliography",
    }
)

# Book-structural header patterns reused from book_chunker. Roman-numeral section
# headers (_ROMAN_SECTION) are intentionally excluded: papers use "II. Methods"
# too, and IMRaD detection (checked first) already handles those cases.
_BOOK_HEADER_PATTERNS = (_BOOK_CHAPTER, _BOOK_PART, _BOOK_DIVISION, _SECTION_SYMBOL)


@dataclass
class RouterConfig:
    """Thresholds for the structure-based book/paper router."""

    page_threshold: int = 50
    min_chapters: int = 3
    min_imrad: int = 3
    detect_toc: bool = True
    toc_scan_pages: int = 15
    debug: bool = False

    @classmethod
    def from_env(cls) -> RouterConfig:
        return cls(
            page_threshold=int(os.environ.get("ROUTER_PAGE_THRESHOLD", 50)),
            min_chapters=int(os.environ.get("ROUTER_MIN_CHAPTERS", 3)),
            min_imrad=int(os.environ.get("ROUTER_MIN_IMRAD", 3)),
            detect_toc=os.environ.get("ROUTER_DETECT_TOC", "1") == "1",
            toc_scan_pages=int(os.environ.get("ROUTER_TOC_SCAN_PAGES", 15)),
            debug=os.environ.get("ROUTER_DEBUG", "0") == "1",
        )


def _normalize_header(title: str) -> str:
    """Strip a leading section number (digits "3.2", dotted "3.", or uppercase
    Roman "IV.") then lower-case and drop a trailing ``.``/``:`` so the result
    can be compared against :data:`_IMRAD_CORE`. The numbering prefix is matched
    on the original-case string because the Roman pattern is uppercase-only."""
    t = title.strip()
    for pat in (_NUM_PREFIX_DOT, _NUM_PREFIX):
        match = pat.match(t)
        if match:
            t = t[match.end() :].strip()
            break
    return t.lower().rstrip(".:").strip()


def _is_book_structural_header(line: str) -> bool:
    """True if a line is a chapter / part / division / §-section header."""
    return any(pat.match(line) for pat in _BOOK_HEADER_PATTERNS)


def _has_toc_page(text: str, scan_pages: int) -> bool:
    """Scan the leading ``scan_pages`` pages for a table-of-contents page,
    reusing book_chunker's TOC detector on the same per-page line view that
    :func:`pipeline.book_chunker.detect_book_sections` builds."""
    pages = re.split(r"\s*\f\s*", text) if "\f" in text else [text]
    for page in pages[: max(1, scan_pages)]:
        page_lines = [line for block in _split_page_into_blocks(page) for line in block]
        # previous_page_was_toc=False: we only need to spot the first TOC page,
        # which the detector recognizes on its own (no continuation context).
        if _looks_like_toc_page(page_lines, False):
            return True
    return False


def classify_document(text: str, config: RouterConfig | None = None) -> str:
    """Return ``"book"`` or ``"paper"`` for a document's extracted text.

    Structure-first: a detectable TOC or ≥ ``min_chapters`` chapter headers ⇒
    book; else ≥ ``min_imrad`` IMRaD headers ⇒ paper; else page count decides.
    Pure text analysis — no tokenizer or model required.
    """
    cfg = config or RouterConfig.from_env()
    if not text or not text.strip():
        return "paper"

    n_pages = text.count("\f") + 1

    # Distinct headers (sets dedupe repeated running heads like "Chapter 3"
    # reprinted on every page of the chapter).
    chapter_headers: set[str] = set()
    imrad_headers: set[str] = set()
    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        # IMRaD first so numbered section headers ("II. Methods") count as paper
        # structure rather than being mistaken for book chapters.
        kind, title = _classify_section_header(line)
        if kind == "hard":
            norm = _normalize_header(title)
            if norm in _IMRAD_CORE:
                imrad_headers.add(norm)
                continue
        if _is_book_structural_header(line):
            chapter_headers.add(line.lower())

    n_chapters = len(chapter_headers)
    n_imrad = len(imrad_headers)
    has_toc = cfg.detect_toc and _has_toc_page(text, cfg.toc_scan_pages)

    if has_toc or n_chapters >= cfg.min_chapters:
        decision, reason = "book", f"toc={has_toc} chapters={n_chapters}"
    elif n_imrad >= cfg.min_imrad:
        decision, reason = "paper", f"imrad={n_imrad}"
    elif n_pages >= cfg.page_threshold:
        decision, reason = "book", f"pages={n_pages}≥{cfg.page_threshold} tie-break"
    else:
        decision, reason = "paper", f"pages={n_pages}<{cfg.page_threshold} tie-break"

    if cfg.debug:
        print(
            f"[ROUTER] {decision}: {reason} "
            f"(pages={n_pages} chapters={n_chapters} imrad={n_imrad} toc={has_toc})",
            flush=True,
        )
    return decision


def make_auto_chunker(
    sci_config: ChunkerConfig | None = None,
    book_config: BookChunkerConfig | None = None,
    router_config: RouterConfig | None = None,
    chunk_cache: dict[str, list[dict[str, Any]]] | None = None,
) -> Callable:
    """Return a LightRAG-compatible ``chunking_func`` that routes each document
    to the scientific or book chunker by detected structure.

    Args:
        sci_config:    scientific chunker config (default ChunkerConfig.from_env()).
        book_config:   book chunker config (default BookChunkerConfig.from_env()).
        router_config: routing thresholds (default RouterConfig.from_env()).
        chunk_cache:   optional pre-computed chunk cache keyed by MD5 of the
            document content. For ``auto`` runs over a mixed corpus, merge the
            scientific and book prechunk caches (their key spaces are disjoint
            because the prechunk scripts run on disjoint directories).
    """
    sci_cfg = sci_config or ChunkerConfig.from_env()
    book_cfg = book_config or BookChunkerConfig.from_env()
    rcfg = router_config or RouterConfig.from_env()

    def chunking_func(
        tokenizer: Tokenizer,
        content: str,
        split_by_character=None,
        split_by_character_only=False,
        chunk_overlap_token_size=100,
        chunk_token_size=1200,
    ) -> list[dict[str, Any]]:
        # NOTE: LightRAG's chunk_overlap_token_size / chunk_token_size are
        # intentionally ignored here — chunk geometry comes from the per-strategy
        # ChunkerConfig / BookChunkerConfig (the CHUNK_* / BOOK_CHUNK_* env vars).
        if chunk_cache is not None:
            content_hash = hashlib.md5(content.encode("utf-8")).hexdigest()
            cached = chunk_cache.get(content_hash)
            if cached is not None:
                return cached
        if classify_document(content, rcfg) == "book":
            return chunk_book_document(tokenizer, content, book_cfg)
        return chunk_document(tokenizer, content, sci_cfg)

    return chunking_func
