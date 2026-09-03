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
    # case-insensitive; matches a co-author too
    assert s.resolve_filter({"authors": ["hollis"]}, MANIFEST) == {"Westbury_Hollis_2019.pdf"}


SAME_SURNAME = {
    "Zhang_Kechen_1999.pdf": {
        "authors": [{"family": "Zhang", "given": "Kechen"}], "year": "1999",
    },
    "Zhang_Kai_2020.pdf": {
        "authors": [{"family": "Zhang", "given": "Kai"}], "year": "2020",
    },
    "Zhang_K_2001.pdf": {          # same person as Kechen, recorded as an initial
        "authors": [{"family": "Zhang", "given": "K."}], "year": "2001",
    },
    "Zhang_ChrisF_2005.pdf": {     # multi-initial form of a spelled-out given name
        "authors": [{"family": "Zhang", "given": "C. F."}], "year": "2005",
    },
    "Zhang_bare_2010.pdf": {       # no given name recorded at all
        "authors": [{"family": "Zhang", "given": ""}], "year": "2010",
    },
}


def test_filter_by_specific_person():
    """"Family, Given" picks one person out of a shared surname; the bare surname keeps
    meaning every author with it."""
    assert s.resolve_filter({"authors": ["Zhang"]}, SAME_SURNAME) == set(SAME_SURNAME)
    # an initial-only record is compatible with the full given name it abbreviates…
    assert s.resolve_filter({"authors": ["Zhang, Kechen"]}, SAME_SURNAME) == {
        "Zhang_Kechen_1999.pdf", "Zhang_K_2001.pdf"}
    # …which cuts both ways: "K." could equally be Kai, so it stays in that result too
    # (the record is genuinely ambiguous — better to include it than to drop the paper)
    assert s.resolve_filter({"authors": ["Zhang, Kai"]}, SAME_SURNAME) == {
        "Zhang_Kai_2020.pdf", "Zhang_K_2001.pdf"}
    # multi-initial forms match on initials
    assert s.resolve_filter({"authors": ["Zhang, Chris F."]}, SAME_SURNAME) == {
        "Zhang_ChrisF_2005.pdf"}
    # two spelled-out names sharing a first letter are different people
    assert "Zhang_Kechen_1999.pdf" not in s.resolve_filter(
        {"authors": ["Zhang, Kai"]}, SAME_SURNAME)
    # a record with no given name recorded is not claimed by any specific person
    assert "Zhang_bare_2010.pdf" not in s.resolve_filter(
        {"authors": ["Zhang, Kechen"]}, SAME_SURNAME)
    # several people OR together
    assert s.resolve_filter({"authors": ["Zhang, Kai", "Zhang, Chris F."]},
                            SAME_SURNAME) == {"Zhang_Kai_2020.pdf", "Zhang_K_2001.pdf",
                                              "Zhang_ChrisF_2005.pdf"}


def test_specific_person_needs_a_matching_surname():
    assert s.resolve_filter({"authors": ["Westbury, Chris"]}, MANIFEST) == {
        "Westbury_Hollis_2019.pdf"}
    assert s.resolve_filter({"authors": ["Westbury, Jane"]}, MANIFEST) == set()
    # a surname substring is only good enough for the bare-surname form
    assert s.resolve_filter({"authors": ["estbury"]}, MANIFEST) == {
        "Westbury_Hollis_2019.pdf"}
    assert s.resolve_filter({"authors": ["estbury, Chris"]}, MANIFEST) == set()


SURNAME_NEIGHBOURS = {
    "Chen_Etal_2014b.pdf": {
        "authors": [{"family": "Chen", "given": "Y. Y."},
                    {"family": "Caplan", "given": "J. B."}], "year": "2014",
    },
    "Hesse_Schenk_2014.pdf": {
        "authors": [{"family": "Hesse", "given": "C."},
                    {"family": "Schenk", "given": "T."}], "year": "2014",
    },
    "Han_Etal_2014.pdf": {
        "authors": [{"family": "Han", "given": "C."},
                    {"family": "Cheng", "given": "S."}], "year": "2014",
    },
}


def test_bare_surname_is_exact_not_substring():
    """A known surname must not drag in the surnames that merely contain it — "Chen"
    claiming S-chen-k and Chen-g is what made a question about one paper retrieve a
    pool of unrelated same-year ones."""
    assert s.resolve_filter({"authors": ["Chen"]}, SURNAME_NEIGHBOURS) == {
        "Chen_Etal_2014b.pdf"}
    assert s.resolve_filter({"authors": ["Chen"], "years": [2014]},
                            SURNAME_NEIGHBOURS) == {"Chen_Etal_2014b.pdf"}
    # the surnames that used to be swept up are still reachable on their own
    assert s.resolve_filter({"authors": ["Schenk"]}, SURNAME_NEIGHBOURS) == {
        "Hesse_Schenk_2014.pdf"}
    assert s.resolve_filter({"authors": ["Cheng"]}, SURNAME_NEIGHBOURS) == {
        "Han_Etal_2014.pdf"}


def test_substring_fallback_is_per_term():
    """An unknown spelling still broadens to substring, but only that term — a known
    surname alongside it stays exact."""
    # "hen" matches nothing exactly, so it falls back and claims all three
    assert s.resolve_filter({"authors": ["hen"]}, SURNAME_NEIGHBOURS) == set(
        SURNAME_NEIGHBOURS)
    # "Chen" is known so it stays exact; "esse" is not so it broadens — union of both
    assert s.resolve_filter({"authors": ["Chen", "esse"]}, SURNAME_NEIGHBOURS) == {
        "Chen_Etal_2014b.pdf", "Hesse_Schenk_2014.pdf"}


def test_loose_author_terms():
    assert s.loose_author_terms({"authors": ["Chen"]}, SURNAME_NEIGHBOURS) == frozenset()
    assert s.loose_author_terms({"authors": ["hen"]}, SURNAME_NEIGHBOURS) == {"hen"}
    assert s.loose_author_terms({"authors": ["Chen", "hen"]},
                                SURNAME_NEIGHBOURS) == {"hen"}
    # "Family, Given" never uses substring matching, so it is never a loose term
    assert s.loose_author_terms({"authors": ["hen, Y."]}, SURNAME_NEIGHBOURS) == frozenset()
    assert s.loose_author_terms({}, SURNAME_NEIGHBOURS) == frozenset()


def test_given_name_helpers():
    assert s.parse_author_filter("Zhang, Kechen") == ("zhang", "kechen")
    assert s.parse_author_filter(" Zhang ") == ("zhang", "")
    assert s.is_initials("K.") and s.is_initials("S. W.")
    assert not (s.is_initials("Li") or s.is_initials("Li I.") or s.is_initials("Wei-Hua"))
    assert s.given_matches("Kechen", "K.") and s.given_matches("K.", "Kechen")
    assert s.given_matches("Chris F.", "C. F.")
    assert not s.given_matches("Kechen", "Kai")
    assert not s.given_matches("Kechen", "")


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
