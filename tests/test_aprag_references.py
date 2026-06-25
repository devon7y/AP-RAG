"""
Tests for aprag.references — client-side local PDF resolution + link rewriting.

Run: python -m pytest tests/test_aprag_references.py -v
"""

import os
import sys
from pathlib import Path

# Import the aprag package from the repo root without requiring an editable install
# (references.py is stdlib-only; the package __init__ pulls no heavy deps).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aprag import references as refs  # noqa: E402


def _pdf(path: Path) -> None:
    path.write_bytes(b"%PDF-1.4\n%stub\n")


# ── local index ───────────────────────────────────────────────────────────────


def test_build_index_finds_pdfs_recursively_case_insensitively(tmp_path):
    d = tmp_path / "papers"
    (d / "sub").mkdir(parents=True)
    _pdf(d / "Smith_2020.pdf")
    _pdf(d / "sub" / "Jones_Lee_2019.pdf")
    _pdf(d / "notes.txt")  # ignored (not a pdf)

    index = refs.build_local_index([str(d)])
    assert refs.find_local("Smith_2020.pdf", index).endswith("Smith_2020.pdf")
    assert refs.find_local("jones_lee_2019.pdf", index) is not None  # case-insensitive
    assert refs.find_local("Missing_2000.pdf", index) is None


def test_paper_dirs_respects_env_and_extra(monkeypatch, tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    monkeypatch.setenv("APRAG_PAPERS_DIR", os.pathsep.join([str(a), str(b)]))
    dirs = [str(p) for p in refs.paper_dirs()]
    assert str(a) in dirs and str(b) in dirs
    # explicit extra dir comes first (highest priority)
    c = tmp_path / "c"
    c.mkdir()
    assert str(refs.paper_dirs([str(c)])[0]) == str(c)


def test_paper_dirs_drops_nonexistent(monkeypatch, tmp_path):
    monkeypatch.setenv("APRAG_PAPERS_DIR", str(tmp_path / "does-not-exist"))
    assert refs.paper_dirs() == []


# ── localize_answer ───────────────────────────────────────────────────────────


def _refs():
    return [
        {"apa": "Martin, R. A. (2007). *Book*.", "filename": "Martin_2007.pdf",
         "hades_path": "hades.psych.ualberta.ca:/Users/Shared/aprag_papers/Martin_2007.pdf"},
        {"apa": "Smith, J. (2020). Title.", "filename": "Smith_2020.pdf",
         "hades_path": "hades.psych.ualberta.ca:/Users/Shared/aprag_papers/Smith_2020.pdf"},
    ]


def test_localize_links_local_and_falls_back_to_hades(tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    _pdf(d / "Martin_2007.pdf")  # present locally; Smith is not
    index = refs.build_local_index([str(d)])

    answer = "Humor is fun (Martin, 2007).\n\n### References\n\n- stale line\n"
    out = refs.localize_answer(answer, _refs(), index)

    assert "Humor is fun (Martin, 2007)." in out          # body preserved
    assert "[open PDF](file://" in out and "Martin_2007.pdf" in out  # local → link
    assert "aprag_papers/Smith_2020.pdf" in out           # miss → hades path
    assert "stale line" not in out                        # server's block replaced
    assert out.count("### References") == 1


def test_locator_precedence_local_drive_hades_filename(tmp_path):
    # local copy present → file:// link wins over everything
    d = tmp_path / "p"
    d.mkdir()
    _pdf(d / "A_2020.pdf")
    idx = refs.build_local_index([str(d)])
    ref = {"filename": "A_2020.pdf", "drive_url": "https://drive/x", "hades_path": "h:/A_2020.pdf"}
    assert "[open PDF](file://" in refs.locator_for(ref, idx)
    # no local → Drive link wins over hades
    empty = {}
    assert refs.locator_for(ref, empty) == "[open in Drive](https://drive/x)"
    # no local, no drive → hades
    assert refs.locator_for({"filename": "A_2020.pdf", "hades_path": "h:/A_2020.pdf"}, empty) == "h:/A_2020.pdf"
    # nothing → bare filename
    assert refs.locator_for({"filename": "A_2020.pdf"}, empty) == "A_2020.pdf"


def test_localize_uses_drive_link_when_not_local(tmp_path):
    rlist = [{"apa": "Smith, J. (2020). T.", "filename": "Smith_2020.pdf",
              "drive_url": "https://drive.google.com/file/d/Q/view", "hades_path": "h", "pages": []}]
    out = refs.localize_answer("ans\n\n### References\n- z", rlist, {})  # empty index = no local
    assert "[open in Drive](https://drive.google.com/file/d/Q/view)" in out


def test_localize_shows_pdf_pages(tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    _pdf(d / "Martin_2007.pdf")
    rlist = [{"apa": "Martin, R. A. (2007). *Book*.", "filename": "Martin_2007.pdf",
              "hades_path": "h", "pages": [3, 12, 19]}]
    out = refs.localize_answer("ans\n\n### References\n- z", rlist,
                               refs.build_local_index([str(d)]))
    assert "(pp. 3, 12, 19)" in out
    assert "[open PDF](file://" in out  # page locator coexists with the local link


def test_localize_url_encodes_spaces(tmp_path):
    d = tmp_path / "p"
    d.mkdir()
    _pdf(d / "A B_2020.pdf")
    rlist = [{"apa": "X", "filename": "A B_2020.pdf", "hades_path": "h"}]
    out = refs.localize_answer("ans\n\n### References\n- z", rlist,
                               refs.build_local_index([str(d)]))
    assert "%20" in out


def test_localize_no_references_is_passthrough():
    # returns early (no filesystem scan) when there are no structured references
    assert refs.localize_answer("just an answer", []) == "just an answer"
