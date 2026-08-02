"""
Tests for aprag_search.py — metadata-filter resolution + filtered-search helpers.

Run: python -m pytest tests/test_filtered_search.py -v
"""

import sys
from pathlib import Path

# aprag_search.py (and apa_citations.py it imports) live at the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import aprag_search as s  # noqa: E402


MANIFEST = {
    "Westbury_Hollis_2019.pdf": {
        "type": "article",
        "authors": [{"family": "Westbury", "given": "Chris"},
                    {"family": "Hollis", "given": "Geoff"}],
        "year": "2019",
        "title": "Wriggly, squiffy, lummox, and boobs",
        "container_title": "Journal of Experimental Psychology: General",
        "subjects": ["Cognitive Psychology"],
        "keywords": ["humor", "word meaning"],
        "affiliations": ["University of Alberta"],
    },
    "Martin_2007.pdf": {
        "type": "book",
        "authors": [{"family": "Martin", "given": "Rod A."}],
        "year": "2007",
        "title": "The psychology of humor",
        "container_title": "",
        "subjects": ["Psychology"],
        "keywords": ["humor", "laughter"],
        "affiliations": ["University of Western Ontario"],
    },
    "Smith_2021.pdf": {
        "type": "article",
        "authors": [{"family": "Smith", "given": "Jane"}],
        "year": "2021",
        "title": "Semantics of meaning",
        "container_title": "Cognition",
        "subjects": ["Linguistics"],
        "keywords": ["semantics", "meaning"],
        "affiliations": ["MIT"],
    },
}


# ── record_matches / resolve_filter ───────────────────────────────────────────


def test_resolve_none_when_no_filters():
    assert s.resolve_filter(None, MANIFEST) is None
    assert s.resolve_filter({}, MANIFEST) is None
    assert s.resolve_filter({"authors": []}, MANIFEST) is None  # empty list = inactive


def test_filter_by_author_surname():
    assert s.resolve_filter({"authors": ["Westbury"]}, MANIFEST) == {"Westbury_Hollis_2019.pdf"}
    # case-insensitive substring; matches a co-author too
    assert s.resolve_filter({"authors": ["hollis"]}, MANIFEST) == {"Westbury_Hollis_2019.pdf"}


def test_filter_by_year_range():
    assert s.resolve_filter({"year_from": 2019}, MANIFEST) == {
        "Westbury_Hollis_2019.pdf", "Smith_2021.pdf"}
    assert s.resolve_filter({"year_to": 2010}, MANIFEST) == {"Martin_2007.pdf"}
    assert s.resolve_filter({"year": 2021}, MANIFEST) == {"Smith_2021.pdf"}


def test_filter_by_journal_subject_keyword_affiliation():
    assert s.resolve_filter({"journals": ["Cognition"]}, MANIFEST) == {"Smith_2021.pdf"}
    assert s.resolve_filter({"subjects": ["Linguistics"]}, MANIFEST) == {"Smith_2021.pdf"}
    assert s.resolve_filter({"keywords": ["meaning"]}, MANIFEST) == {
        "Westbury_Hollis_2019.pdf", "Smith_2021.pdf"}
    assert s.resolve_filter({"affiliations": ["MIT"]}, MANIFEST) == {"Smith_2021.pdf"}


def test_filters_are_anded_across_dimensions():
    # humor keyword AND authored by Westbury → only the Westbury paper
    assert s.resolve_filter(
        {"keywords": ["humor"], "authors": ["Westbury"]}, MANIFEST
    ) == {"Westbury_Hollis_2019.pdf"}
    # contradictory → empty set (active filter, nothing matches)
    assert s.resolve_filter({"authors": ["Westbury"], "year": 2007}, MANIFEST) == set()


def test_resolve_empty_manifest():
    assert s.resolve_filter({"authors": ["Westbury"]}, {}) == set()


def test_filter_by_pinned_papers():
    # exact filename match, case-insensitive, ".pdf" optional
    assert s.resolve_filter({"papers": ["Martin_2007.pdf"]}, MANIFEST) == {"Martin_2007.pdf"}
    assert s.resolve_filter({"papers": ["martin_2007"]}, MANIFEST) == {"Martin_2007.pdf"}
    assert s.resolve_filter(
        {"papers": ["Martin_2007", "Smith_2021.pdf"]}, MANIFEST
    ) == {"Martin_2007.pdf", "Smith_2021.pdf"}
    # exact, not substring — a stem prefix must not match
    assert s.resolve_filter({"papers": ["Martin"]}, MANIFEST) == set()
    # ANDs with other dimensions like any filter
    assert s.resolve_filter(
        {"papers": ["Martin_2007", "Smith_2021"], "year_from": 2020}, MANIFEST
    ) == {"Smith_2021.pdf"}


# ── assign_reference_ids ──────────────────────────────────────────────────────


def test_assign_reference_ids_frequency_ranked():
    chunks = [
        {"file_path": "B.pdf", "content": "x"},
        {"file_path": "A.pdf", "content": "y"},
        {"file_path": "A.pdf", "content": "z"},  # A appears twice → rank 1
    ]
    refs = s.assign_reference_ids(chunks)
    assert refs == [{"reference_id": "1", "file_path": "A.pdf"},
                    {"reference_id": "2", "file_path": "B.pdf"}]
    assert [c["reference_id"] for c in chunks] == ["2", "1", "1"]


# ── build_synthesis_context ───────────────────────────────────────────────────


def test_build_synthesis_context_has_refs_and_chunks():
    refs = [{"reference_id": "1", "file_path": "A.pdf"}]
    chunks = [{"reference_id": "1", "content": "hello world"}]
    ctx = s.build_synthesis_context(refs, chunks)
    assert "[1] A.pdf" in ctx
    assert "[1] hello world" in ctx


# ── rank_papers ───────────────────────────────────────────────────────────────


def test_rank_papers_groups_and_sorts_by_score():
    chunks = [
        {"file_path": "Smith_2021.pdf", "content": "meaning is...", "score": 0.4},
        {"file_path": "Westbury_Hollis_2019.pdf", "content": "humor and meaning", "score": 0.9},
        {"file_path": "Westbury_Hollis_2019.pdf", "content": "more", "score": 0.7},
    ]
    papers = s.rank_papers(chunks, MANIFEST, "hades:/x",
                           pages_by_file={"Westbury_Hollis_2019.pdf": [3, 12]})
    assert [p["filename"] for p in papers] == ["Westbury_Hollis_2019.pdf", "Smith_2021.pdf"]
    top = papers[0]
    assert top["score"] == 0.9 and top["n_chunks"] == 2
    assert top["pages"] == [3, 12]
    assert "Westbury" in top["apa"]
    assert top["hades_path"].endswith("/Westbury_Hollis_2019.pdf")
