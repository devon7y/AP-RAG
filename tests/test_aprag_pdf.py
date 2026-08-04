"""
Tests for aprag_pdf.py — PDF serving path safety, cache identity, and rasterization.

The path-safety tests are the important ones: ``safe_pdf_path`` is the boundary between
a browser-supplied filename and the PC's filesystem.

Run: python -m pytest tests/test_aprag_pdf.py -v
"""

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import aprag_pdf as p  # noqa: E402


@pytest.fixture
def papers(tmp_path):
    root = tmp_path / "papers"
    root.mkdir()
    (root / "Westbury_2019.pdf").write_bytes(b"%PDF-1.4 fake")
    (root / "notes.txt").write_text("not a pdf")
    outside = tmp_path / "secrets"
    outside.mkdir()
    (outside / "private.pdf").write_bytes(b"%PDF-1.4 secret")
    return root, outside


# ── safe_pdf_path (the security boundary) ────────────────────────────────────


def test_accepts_plain_pdf_basename(papers):
    root, _ = papers
    got = p.safe_pdf_path(str(root), "Westbury_2019.pdf")
    assert got == os.path.realpath(str(root / "Westbury_2019.pdf"))


def test_rejects_traversal_and_separators(papers):
    root, _ = papers
    for bad in [
        "../secrets/private.pdf",
        "..\\secrets\\private.pdf",
        "subdir/Westbury_2019.pdf",
        "/etc/passwd.pdf",
        "..",
        "",
        "   ",
    ]:
        assert p.safe_pdf_path(str(root), bad) is None, bad


def test_rejects_non_pdf_and_missing(papers):
    root, _ = papers
    assert p.safe_pdf_path(str(root), "notes.txt") is None
    assert p.safe_pdf_path(str(root), "nope.pdf") is None


def test_rejects_symlink_escape(papers):
    root, outside = papers
    link = root / "sneaky.pdf"
    try:
        link.symlink_to(outside / "private.pdf")
    except OSError:
        pytest.skip("symlinks unavailable")
    assert p.safe_pdf_path(str(root), "sneaky.pdf") is None


def test_sibling_prefix_directory_is_not_inside(tmp_path):
    (tmp_path / "papers").mkdir()
    evil = tmp_path / "papers_evil"
    evil.mkdir()
    (evil / "x.pdf").write_bytes(b"%PDF")
    # A path that shares the root's string prefix must not resolve as inside it.
    assert p.safe_pdf_path(str(tmp_path / "papers"), "x.pdf") is None


def test_empty_papers_dir_is_rejected():
    assert p.safe_pdf_path("", "a.pdf") is None


# ── cache identity ───────────────────────────────────────────────────────────


def test_etag_changes_when_bytes_change(tmp_path):
    f = tmp_path / "a.pdf"
    f.write_bytes(b"one")
    first = p.file_etag(f.stat())
    assert first.startswith('"') and first.endswith('"')
    os.utime(f, (1_700_000_000, 1_700_000_000))
    pinned = p.file_etag(f.stat())
    f.write_bytes(b"different length")
    os.utime(f, (1_700_000_000, 1_700_000_000))  # same mtime, new size
    assert p.file_etag(f.stat()) != pinned


def test_page_cache_path_encodes_params_and_signature():
    a = p.page_cache_path("/c", "Westbury_2019.pdf", 12, 1200, 80, "abc123")
    assert a.endswith(os.path.join("Westbury_2019", "p12_w1200_q80_abc123.webp"))
    # A re-OCR'd PDF (new signature) maps to a different cache file.
    b = p.page_cache_path("/c", "Westbury_2019.pdf", 12, 1200, 80, "def456")
    assert a != b
    # Params are part of the key too.
    assert p.page_cache_path("/c", "Westbury_2019.pdf", 12, 900, 80, "abc123") != a


def test_page_cache_path_sanitizes_stem():
    # A stem is only ever a manifest basename, but the cache path must not inherit
    # separators or drive-letter colons from it regardless.
    got = p.page_cache_path("/c", "we/ird na:me.pdf", 1, 1200, 80, "sig")
    subdir = os.path.basename(os.path.dirname(got))
    assert subdir == "ird_na_me"  # directory part dropped, then sanitized
    assert ":" not in got


def test_clamps():
    assert p.clamp_width(50) == p.MIN_WIDTH
    assert p.clamp_width(99_999) == p.MAX_WIDTH
    assert p.clamp_width(None) == p.DEFAULT_WIDTH
    assert p.clamp_width("abc") == p.DEFAULT_WIDTH
    assert p.clamp_width(1000) == 1000
    assert p.clamp_quality(1) == p.MIN_QUALITY
    assert p.clamp_quality(100) == p.MAX_QUALITY
    assert p.clamp_quality(None) == p.DEFAULT_QUALITY


# ── rasterization (needs PyMuPDF + Pillow, as on the PC) ─────────────────────


@pytest.fixture
def real_pdf(tmp_path):
    pymupdf = pytest.importorskip("pymupdf")
    pytest.importorskip("PIL")
    path = tmp_path / "sample.pdf"
    doc = pymupdf.open()
    for i in range(3):
        page = doc.new_page()
        page.insert_text((72, 144), f"Page {i + 1}: word frequency and humor.", fontsize=18)
    doc.save(str(path))
    doc.close()
    return path


def test_render_page_returns_webp_and_count(real_pdf):
    data, count, rendered = p.render_page_image(str(real_pdf), 2, width=800)
    assert count == 3 and rendered == 2
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"


def test_render_clamps_out_of_range_page(real_pdf):
    _data, count, rendered = p.render_page_image(str(real_pdf), 99)
    assert count == 3 and rendered == 3
    _data, _count, rendered = p.render_page_image(str(real_pdf), 0)
    assert rendered == 1


def test_normalize_quote_collapses_pdf_linebreaks():
    assert p.normalize_quote("word\nfrequency   and\n\nhumor") == "word frequency and humor"
    assert p.normalize_quote(None) == ""


def test_locate_finds_the_right_page_with_fractional_rects(real_pdf):
    got = p.locate_quote(str(real_pdf), "Page 2: word frequency and humor.")
    assert got["page"] == 2, got
    assert got["page_count"] == 3
    assert got["rects"], "expected highlight rectangles"
    for x0, y0, x1, y1 in got["rects"]:
        assert 0.0 <= x0 < x1 <= 1.0
        assert 0.0 <= y0 < y1 <= 1.0


def test_locate_tolerates_broken_whitespace(real_pdf):
    # Chunk text arrives with PDF line breaks; the search must still match.
    assert p.locate_quote(str(real_pdf), "Page 3:\n   word\nfrequency")["page"] == 3


def test_locate_highlights_a_contiguous_run(tmp_path):
    """The highlight must cover the whole passage as one span. Sampling phrases from it
    instead produced disconnected fragments scattered down the page."""
    pymupdf = pytest.importorskip("pymupdf")
    pytest.importorskip("PIL")
    path = tmp_path / "prose.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    lines = [
        "Generative artificial intelligence is reshaping core activities",
        "in psychometrics, reflecting a broader shift toward treating",
        "language as a scalable behavioral trace for cognitive modelling",
        "and for the measurement of individual differences at scale.",
    ]
    for i, line in enumerate(lines):
        page.insert_text((60, 120 + i * 22), line, fontsize=11)
    doc.save(str(path))
    doc.close()

    got = p.locate_quote(str(path), " ".join(lines))
    assert got["page"] == 1
    # One rectangle per line of the passage, not a scatter of word-level fragments.
    assert len(got["rects"]) == len(lines), got["rects"]


def test_locate_survives_symbol_only_tokens(tmp_path):
    """Statistics text is full of standalone '=' and minus signs, which carry no
    letters or digits; a run of them used to desync alignment and lose the passage."""
    pymupdf = pytest.importorskip("pymupdf")
    path = tmp_path / "stats.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((60, 120), "The effect was reliable (z = -0.30, P = 0.767,", fontsize=11)
    page.insert_text((60, 142), "d < 0.01) across the temporal and spatial conditions.", fontsize=11)
    doc.save(str(path))
    doc.close()

    got = p.locate_quote(
        str(path),
        "The effect was reliable (z = -0.30, P = 0.767, d < 0.01) across the temporal "
        "and spatial conditions.",
    )
    assert got["page"] == 1 and got["rects"]


def test_locate_misses_cleanly_when_absent(real_pdf):
    got = p.locate_quote(str(real_pdf), "this sentence is nowhere in the document at all")
    assert got["page"] is None and got["rects"] == []


def test_locate_ignores_too_short_a_quote(real_pdf):
    assert p.locate_quote(str(real_pdf), "the")["page"] is None


def test_render_raises_on_garbage(tmp_path):
    pytest.importorskip("pymupdf")
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"this is not a pdf at all")
    with pytest.raises(RuntimeError):
        p.render_page_image(str(bad), 1)


def test_locate_survives_a_contextual_blurb_prefix(tmp_path):
    """Retrieved chunks are stored as "<situating blurb>\\n\\n<passage>", and the blurb is
    written by the ingest model — it appears nowhere in the paper. A long one reaches the
    locator, so anchoring on the opening words searches for text that cannot exist."""
    pymupdf = pytest.importorskip("pymupdf")
    path = tmp_path / "blurbed.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    lines = [
        "As a validation, we also calibrated the respondent proficiency",
        "distribution using the fixed item parameter methods described",
        "above, and obtained correlations within 0.02 of those reported",
        "for the fifty human respondents in the preceding section.",
    ]
    for i, line in enumerate(lines):
        page.insert_text((60, 120 + i * 22), line, fontsize=11)
    doc.save(str(path))
    doc.close()

    blurb = (
        "The chunk presents the validation of respondent proficiency distributions "
        "using fixed item parameter methods and introduces the Discussion section, "
        "which summarizes the study's findings on LLM proficiency as synthetic "
        "respondents for item calibration across several conditions."
    )
    got = p.locate_quote(str(path), f"{blurb}\n\n{' '.join(lines)}")
    assert got["page"] == 1, "the passage is on the page even though the blurb is not"
    assert got["rects"]
