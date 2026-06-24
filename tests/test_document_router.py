"""
Tests for the structure-based document router (pipeline/document_router.py).

Run: python -m pytest tests/test_document_router.py -v
"""

import pytest

from pipeline.document_router import (
    RouterConfig,
    _normalize_header,
    classify_document,
    make_auto_chunker,
)


class MockTokenizer:
    """Treat each whitespace-separated token as one token."""

    def encode(self, text: str) -> list[int]:
        if not text or not text.strip():
            return []
        return list(range(len(text.split())))

    def decode(self, tokens: list[int]) -> str:
        return " ".join(f"w{i}" for i in tokens)


@pytest.fixture
def tokenizer():
    return MockTokenizer()


@pytest.fixture
def cfg():
    # Explicit config so tests don't depend on ambient ROUTER_* env vars.
    return RouterConfig(
        page_threshold=50, min_chapters=3, min_imrad=3, detect_toc=True, toc_scan_pages=15
    )


# A short IMRaD paper (each section header on its own line).
_PAPER = (
    "Abstract\n"
    "We investigate how humor is processed in the brain.\n\n"
    "Introduction\n"
    "Humor has fascinated researchers for decades. Prior work has examined many facets.\n\n"
    "Methods\n"
    "Forty participants completed a rating task under controlled conditions.\n\n"
    "Results\n"
    "We observed a significant effect of incongruity on funniness ratings.\n\n"
    "Discussion\n"
    "These findings extend incongruity-resolution theories of humor.\n\n"
    "References\n"
    "Smith, J. (2020). On laughter. Journal of Humor, 1, 1-10.\n"
)


def _pad_pages(n: int) -> str:
    """A run of body text spanning n form-feed-separated pages, no headers."""
    return "".join(f"This is ordinary body prose on page {i} with several words.\n\f\n" for i in range(n))


# ── classify_document ────────────────────────────────────────────────────────


def test_imrad_paper_is_paper(cfg):
    assert classify_document(_PAPER, cfg) == "paper"


def test_toc_page_forces_book(cfg):
    text = (
        "Contents\n"
        "Chapter 1  Introduction  3\n"
        "Chapter 2  Theories of Humor  21\n"
        "Chapter 3  Laughter  45\n"
        "\f\n"
        "Chapter 1\n"
        "Introduction\n"
        "Humor has been studied since antiquity, and this chapter surveys the field.\n"
    )
    assert classify_document(text, cfg) == "book"


def test_many_chapters_no_toc_is_book(cfg):
    text = (
        "Chapter 1\nThe first chapter body text goes here with enough words.\n\f\n"
        "Chapter 2\nThe second chapter body text continues the argument.\n\f\n"
        "Chapter 3\nThe third chapter develops a further point.\n\f\n"
        "Chapter 4\nThe fourth chapter concludes the discussion.\n"
    )
    assert classify_document(text, cfg) == "book"


def test_short_unstructured_text_is_paper(cfg):
    assert classify_document("Just a few sentences. Nothing structural here at all.", cfg) == "paper"


def test_long_unstructured_text_is_book_by_tiebreak(cfg):
    # 60 pages, no detectable structure → page-count tie-breaker → book.
    assert classify_document(_pad_pages(60), cfg) == "book"


def test_long_imrad_review_is_paper_despite_page_count(cfg):
    """The key guarantee: structure beats page count. A 60+-page review article
    with IMRaD sections must route to the paper chunker, not the book chunker."""
    text = _PAPER + _pad_pages(60)
    assert classify_document(text, cfg) == "paper"


def test_roman_numbered_imrad_sections_count_as_paper(cfg):
    text = (
        "I. Introduction\nWe motivate the study of incongruity in humor.\n\n"
        "II. Methods\nParticipants rated jokes for funniness.\n\n"
        "III. Results\nIncongruity predicted higher funniness.\n\n"
        "IV. Discussion\nThe results support resolution theories.\n"
    )
    # Roman-numbered sections must be read as IMRaD, not mistaken for chapters.
    assert classify_document(text, cfg) == "paper"


def test_empty_text_defaults_to_paper(cfg):
    assert classify_document("", cfg) == "paper"
    assert classify_document("   \n  ", cfg) == "paper"


def test_page_threshold_is_configurable():
    # A 10-page unstructured doc is a book only when the threshold drops to ≤10.
    text = _pad_pages(10)
    assert classify_document(text, RouterConfig(page_threshold=50)) == "paper"
    assert classify_document(text, RouterConfig(page_threshold=10)) == "book"


def test_normalize_header_strips_numbering():
    assert _normalize_header("Abstract") == "abstract"
    assert _normalize_header("3.2 Results") == "results"
    assert _normalize_header("I. Introduction") == "introduction"
    assert _normalize_header("2. Methods:") == "methods"
    assert _normalize_header("Chapter 1") == "chapter 1"  # not IMRaD → stays distinct


# ── make_auto_chunker dispatch ───────────────────────────────────────────────


def _required_keys_ok(chunks):
    return chunks and all(
        {"tokens", "content", "chunk_order_index"}.issubset(c) for c in chunks
    )


def test_auto_chunker_routes_paper(tokenizer, cfg):
    chunker = make_auto_chunker(router_config=cfg)
    chunks = chunker(tokenizer, _PAPER)
    assert _required_keys_ok(chunks)
    # Paper chunker tags chunks with detected IMRaD section titles.
    titles = {c.get("section_title", "").lower() for c in chunks}
    assert any(t in {"abstract", "introduction", "methods", "results", "discussion"} for t in titles)


def test_auto_chunker_routes_book(tokenizer, cfg):
    book = (
        "Chapter 1\nThe first chapter body text goes here with enough words to chunk.\n\f\n"
        "Chapter 2\nThe second chapter body text continues the argument at length.\n\f\n"
        "Chapter 3\nThe third chapter develops a further point across sentences.\n\f\n"
        "Chapter 4\nThe fourth chapter concludes the discussion of the matter.\n"
    )
    chunker = make_auto_chunker(router_config=cfg)
    chunks = chunker(tokenizer, book)
    assert _required_keys_ok(chunks)


def test_auto_chunker_cache_short_circuits(tokenizer, cfg):
    import hashlib

    content = _PAPER
    sentinel = [{"tokens": 1, "content": "CACHED", "chunk_order_index": 0}]
    cache = {hashlib.md5(content.encode("utf-8")).hexdigest(): sentinel}
    chunker = make_auto_chunker(router_config=cfg, chunk_cache=cache)
    assert chunker(tokenizer, content) is sentinel
