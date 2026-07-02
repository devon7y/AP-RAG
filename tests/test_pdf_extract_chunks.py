"""Tests for chunk-in-extract (pipeline/pdf_extract.py + the ingest seeding side).

The extraction subprocess now optionally chunks the document it just extracted
(CHUNK_IN_EXTRACT=1) and writes a .chunks sidecar; the ingest parent seeds its
in-memory chunk cache from it. These tests exercise the real subprocess contract
end-to-end with a generated PDF (PyMuPDF), plus the parent-side salvage/seeding
helpers.
"""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

fitz = pytest.importorskip("fitz")
pytest.importorskip("tiktoken")

REPO_ROOT = Path(__file__).resolve().parent.parent

BODY = (
    "Abstract\n"
    "This paper examines humor comprehension in semantic memory. "
    "We measure word frequency effects across three experiments. "
    * 12
)


@pytest.fixture(scope="module")
def sample_pdf(tmp_path_factory):
    path = tmp_path_factory.mktemp("pdfs") / "sample_paper.pdf"
    doc = fitz.open()
    for _ in range(2):
        page = doc.new_page()
        # insert_textbox renders NOTHING and returns a negative leftover when the
        # text overflows the rect — assert it fit so the fixture can't go blank.
        leftover = page.insert_textbox(fitz.Rect(50, 50, 550, 780), BODY, fontsize=9)
        assert leftover >= 0, "fixture text overflowed the textbox (blank page)"
    doc.save(str(path))
    doc.close()
    return path


def run_child(pdf: Path, out: Path, chunk_in_extract: str) -> subprocess.CompletedProcess:
    env = dict(
        os.environ,
        CHUNK_IN_EXTRACT=chunk_in_extract,
        CHUNKER_TYPE="scientific",
        PYTHONPATH=str(REPO_ROOT),
    )
    return subprocess.run(
        [sys.executable, "-m", "pipeline.pdf_extract", str(pdf), str(out)],
        capture_output=True, text=True, timeout=120, env=env, cwd=str(REPO_ROOT),
    )


def test_child_writes_text_and_chunks_sidecar(sample_pdf, tmp_path):
    out = tmp_path / "out.pdftxt"
    proc = run_child(sample_pdf, out, chunk_in_extract="1")
    assert proc.returncode == 0, proc.stderr
    text = out.read_text(encoding="utf-8")
    assert "humor comprehension" in text

    sidecar = out.with_name(out.name + ".chunks")
    assert sidecar.exists(), "chunks sidecar missing with CHUNK_IN_EXTRACT=1"
    chunks = json.loads(sidecar.read_text(encoding="utf-8"))
    assert isinstance(chunks, list) and chunks
    assert all("content" in c for c in chunks)
    # No leftover tmp files from the atomic writes.
    assert not list(tmp_path.glob("*.tmp"))


def test_child_sidecar_matches_direct_chunking(sample_pdf, tmp_path):
    """The sidecar must equal what the ingest-side chunker would produce for the
    same text — that equality is what makes the md5-keyed cache seed valid."""
    import tiktoken

    from pipeline.scientific_chunker import ChunkerConfig, make_scientific_chunker

    out = tmp_path / "out.pdftxt"
    proc = run_child(sample_pdf, out, chunk_in_extract="1")
    assert proc.returncode == 0, proc.stderr
    text = out.read_text(encoding="utf-8")
    sidecar_chunks = json.loads(
        out.with_name(out.name + ".chunks").read_text(encoding="utf-8")
    )
    tokenizer = tiktoken.get_encoding("cl100k_base")
    direct = make_scientific_chunker(ChunkerConfig.from_env())(
        tokenizer, text, None, False, 51, 512
    )
    assert sidecar_chunks == json.loads(json.dumps(direct))  # sidecar is JSON-typed


def test_child_skips_sidecar_when_disabled(sample_pdf, tmp_path):
    out = tmp_path / "out.pdftxt"
    proc = run_child(sample_pdf, out, chunk_in_extract="0")
    assert proc.returncode == 0, proc.stderr
    assert out.read_text(encoding="utf-8")
    assert not out.with_name(out.name + ".chunks").exists()


def test_ingest_parent_seeds_chunk_cache(sample_pdf, tmp_path, monkeypatch):
    """Full loop: ingest's _extract_pdf_text runs the child and seeds _CHUNK_CACHE
    keyed by md5 of the exact enqueued text."""
    monkeypatch.setenv("WORKDIR", str(tmp_path))
    monkeypatch.setenv("CHUNK_IN_EXTRACT", "1")
    sys.path.insert(0, str(REPO_ROOT))
    import pipeline.ingest as ing

    before = dict(ing._CHUNK_CACHE)
    text = ing._extract_pdf_text(sample_pdf)
    assert "humor comprehension" in text
    key = hashlib.md5(text.encode("utf-8")).hexdigest()
    assert key in ing._CHUNK_CACHE, "chunk cache was not seeded from the sidecar"
    assert ing._CHUNK_CACHE[key], "seeded chunk list is empty"
    assert ing._extract_stats["chunks_seeded"] >= 1
    # The seeded entry is what the active chunker will return for this doc.
    ing._CHUNK_CACHE.clear()
    ing._CHUNK_CACHE.update(before)


def test_salvage_helpers(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKDIR", str(tmp_path))
    import pipeline.ingest as ing

    empty = tmp_path / "empty.pdftxt"
    empty.touch()
    assert ing._salvage_text(empty) == ""          # empty = never salvaged
    full = tmp_path / "full.pdftxt"
    full.write_text("complete extraction", encoding="utf-8")
    assert ing._salvage_text(full) == "complete extraction"
    assert ing._salvage_text(tmp_path / "missing.pdftxt") == ""
