"""
Tests for scripts/build_apa_manifest.py — the pure (no-I/O) record transforms.

Network/LLM/PDF paths aren't exercised here; only the mapping logic that turns a
Crossref message or an LLM result into the manifest record schema, plus the
filename-authoritative disambiguation stamping.

Run: python -m pytest tests/test_build_apa_manifest.py -v
"""

import sys
from pathlib import Path

# build_apa_manifest's top-level imports are stdlib-only (heavy helpers are imported
# lazily), so the transforms import cleanly without requests/poppler.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import build_apa_manifest as b  # noqa: E402


CR_MESSAGE = {
    "type": "journal-article",
    "author": [
        {"family": "Westbury", "given": "Chris",
         "affiliation": [{"name": "University of Alberta"}]},
        {"family": "Hollis", "given": "Geoff",
         "affiliation": [{"name": "University of Alberta"}]},
    ],
    "title": ["Wriggly, squiffy, lummox, and boobs"],
    "container-title": ["Journal of Experimental Psychology: General"],
    "volume": "148", "issue": "1", "page": "97-123",
    "DOI": "10.1037/XGE0000467",
    "published-print": {"date-parts": [[2019, 1]]},
    "subject": ["Cognitive Psychology", "Linguistics"],
    "abstract": "<jats:p>Abstract: We show that incongruity drives funniness.</jats:p>",
}


def test_crossref_to_record_full_mapping():
    rec = b.crossref_to_record(CR_MESSAGE)
    assert rec["type"] == "article"
    assert rec["year"] == "2019"
    assert rec["authors"] == [
        {"family": "Westbury", "given": "Chris"},
        {"family": "Hollis", "given": "Geoff"},
    ]
    assert rec["container_title"] == "Journal of Experimental Psychology: General"
    assert (rec["volume"], rec["issue"], rec["pages"]) == ("148", "1", "97-123")
    assert rec["doi"] == "10.1037/xge0000467"  # lowercased
    assert rec["source"] == "crossref"
    # search/filter fields
    assert rec["subjects"] == ["Cognitive Psychology", "Linguistics"]
    assert rec["affiliations"] == ["University of Alberta"]  # deduped across authors
    assert rec["abstract"] == "We show that incongruity drives funniness."  # JATS stripped
    assert rec["keywords"] == []  # Crossref has none; LLM fills


def test_type_mapping():
    assert b._map_type("book-chapter") == "chapter"
    assert b._map_type("book") == "book"
    assert b._map_type("posted-content") == "preprint"
    assert b._map_type("dissertation") == "thesis"
    assert b._map_type("dataset") == "other"
    assert b._map_type("") == "other"


def test_cr_year_falls_through_date_keys():
    assert b._cr_year({"issued": {"date-parts": [[2011]]}}) == "2011"
    assert b._cr_year({"created": {"date-parts": [[2008, 6, 1]]}}) == "2008"
    assert b._cr_year({}) == ""


def test_finalize_stamps_disambig_and_year_fallback():
    rec = b.finalize_record({"authors": [{"family": "Wrathall"}], "year": ""},
                            "Wrathall_2013a.pdf")
    assert rec["disambig"] == "a"
    assert rec["year"] == "2013"  # filled from the filename when missing

    rec2 = b.finalize_record({"authors": [{"family": "Smith"}], "year": "2020"},
                             "Smith_2020.pdf")
    assert rec2["disambig"] == "" and rec2["year"] == "2020"


def test_llm_result_to_record_and_rejection():
    res = {"is_citable_work": True, "type": "book", "title": "T",
           "authors": [{"family": "Martin", "given": "Rod A."}], "editors": [],
           "year": "2007", "container_title": "", "volume": "", "issue": "",
           "pages": "", "publisher": "Elsevier", "doi": "",
           "keywords": ["humor", "laughter"], "abstract": "An abstract.",
           "subjects": ["Psychology"], "affiliations": ["MIT"], "confidence": "high"}
    rec = b.llm_result_to_record(res)
    assert rec["type"] == "book" and rec["publisher"] == "Elsevier"
    assert rec["source"] == "llm"
    assert rec["keywords"] == ["humor", "laughter"]
    assert rec["subjects"] == ["Psychology"] and rec["affiliations"] == ["MIT"]
    assert rec["abstract"] == "An abstract."
    assert b.llm_result_to_record({"is_citable_work": False}) is None
    assert b.llm_result_to_record({"_error": "boom"}) is None


def test_has_minimum_fields():
    assert b.has_minimum_fields({"authors": [{"family": "A"}], "year": "2020"})
    assert b.has_minimum_fields({"editors": [{"family": "E"}], "year": "2020"})
    assert not b.has_minimum_fields({"authors": [], "year": "2020"})
    assert not b.has_minimum_fields({"authors": [{"family": "A"}], "year": ""})
    assert not b.has_minimum_fields(None)
