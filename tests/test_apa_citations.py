"""
Tests for apa_citations.py — APA7 formatting + LightRAG answer rewriting.

Run: python -m pytest tests/test_apa_citations.py -v
"""

import json
import sys
from pathlib import Path

# apa_citations.py lives at the repo root (it deploys next to query_server.py),
# not inside an installed package — put the root on the path explicitly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import apa_citations as apa  # noqa: E402


# ── Fixtures: representative bib records ──────────────────────────────────────

ARTICLE = {
    "type": "article",
    "authors": [
        {"family": "Westbury", "given": "Chris"},
        {"family": "Hollis", "given": "Geoff"},
    ],
    "year": "2019",
    "title": "Wriggly, squiffy, lummox, and boobs",
    "container_title": "Journal of Experimental Psychology: General",
    "volume": "148",
    "issue": "1",
    "pages": "97-123",
    "doi": "10.1037/xge0000467",
}

BOOK = {
    "type": "book",
    "authors": [{"family": "Martin", "given": "Rod A."}],
    "year": "2007",
    "title": "The psychology of humor: An integrative approach",
    "publisher": "Elsevier Academic Press",
}

CHAPTER = {
    "type": "chapter",
    "authors": [{"family": "Attardo", "given": "Salvatore"}],
    "year": "2017",
    "title": "The general theory of verbal humor",
    "container_title": "The Routledge handbook of language and humor",
    "editors": [{"family": "Attardo", "given": "Salvatore"}],
    "pages": "126-142",
    "publisher": "Routledge",
}


# ── format_apa7 ───────────────────────────────────────────────────────────────


def test_apa7_article():
    out = apa.format_apa7(ARTICLE)
    assert out == (
        "Westbury, C., & Hollis, G. (2019). Wriggly, squiffy, lummox, and boobs. "
        "*Journal of Experimental Psychology: General*, *148*(1), 97-123. "
        "https://doi.org/10.1037/xge0000467"
    )


def test_apa7_book():
    out = apa.format_apa7(BOOK)
    assert out == (
        "Martin, R. A. (2007). *The psychology of humor: An integrative approach*. "
        "Elsevier Academic Press."
    )


def test_apa7_chapter():
    out = apa.format_apa7(CHAPTER)
    assert out == (
        "Attardo, S. (2017). The general theory of verbal humor. "
        "In S. Attardo (Ed.), *The Routledge handbook of language and humor* "
        "(pp. 126-142). Routledge."
    )


def test_apa7_doi_normalised_from_url_form():
    rec = dict(ARTICLE, doi="https://doi.org/10.1037/xge0000467")
    assert apa.format_apa7(rec).endswith(" https://doi.org/10.1037/xge0000467")


def test_apa7_three_plus_authors_listed_in_full():
    rec = {
        "type": "article", "year": "2020", "title": "T", "container_title": "J",
        "authors": [
            {"family": "Alpha", "given": "A"},
            {"family": "Beta", "given": "B"},
            {"family": "Gamma", "given": "C"},
        ],
    }
    out = apa.format_apa7(rec)
    assert "Alpha, A., Beta, B., & Gamma, C." in out


def test_apa7_hyphenated_given_initials():
    rec = {"type": "article", "year": "2001", "title": "X", "container_title": "J",
           "authors": [{"family": "Sartre", "given": "Jean-Paul"}]}
    assert "Sartre, J.-P." in apa.format_apa7(rec)


# ── format_intext ─────────────────────────────────────────────────────────────


def test_intext_one_two_three_authors():
    assert apa.format_intext({"authors": [{"family": "Smith"}], "year": "2020"}) == "Smith, 2020"
    assert apa.format_intext(
        {"authors": [{"family": "Smith"}, {"family": "Jones"}], "year": "2020"}
    ) == "Smith & Jones, 2020"
    assert apa.format_intext(
        {"authors": [{"family": "A"}, {"family": "B"}, {"family": "C"}], "year": "2020"}
    ) == "A et al., 2020"


def test_intext_disambiguation_letter():
    rec = {"authors": [{"family": "Wrathall"}], "year": "2013", "disambig": "a"}
    assert apa.format_intext(rec) == "Wrathall, 2013a"


# ── filename fallback (no manifest entry) ─────────────────────────────────────


def test_fallback_one_author():
    rm = apa.build_ref_model("1", "/scratch/x/Westbury_2024.pdf", {})
    assert rm["intext"] == "Westbury, 2024"
    assert rm["filename"] == "Westbury_2024.pdf"
    assert rm["hades_path"].endswith("/Westbury_2024.pdf")


def test_fallback_two_authors_and_etal():
    rm2 = apa.build_ref_model("1", "Aaronson_Watts_1987.pdf", {})
    assert rm2["intext"] == "Aaronson & Watts, 1987"
    rme = apa.build_ref_model("1", "Agarwal_Etal_2008.pdf", {})
    assert rme["intext"] == "Agarwal et al., 2008"
    assert rme["apa"].startswith("Agarwal et al. (2008).")


def test_basename_handles_windows_and_posix_paths():
    assert apa.build_ref_model("1", r"C:\\papers\\Smith_2020.pdf", {})["filename"] == "Smith_2020.pdf"
    assert apa.build_ref_model("1", "/a/b/Smith_2020.pdf", {})["filename"] == "Smith_2020.pdf"


# ── in-text rewriting ─────────────────────────────────────────────────────────


def test_rewrite_single_token():
    m = {"1": "Smith, 2020"}
    assert apa.rewrite_intext("As shown [1].", m) == "As shown (Smith, 2020)."


def test_rewrite_parenthesised_group_collapses_and_sorts():
    m = {"1": "Zed, 2015", "3": "Adams, 2018", "4": "Brown et al., 2019"}
    out = apa.rewrite_intext("Findings agree ([1], [3], [4]).", m)
    assert out == "Findings agree (Adams, 2018; Brown et al., 2019; Zed, 2015)."


def test_rewrite_dedupes_ids_within_group():
    m = {"1": "Smith, 2020"}
    assert apa.rewrite_intext("([1], [1])", m) == "(Smith, 2020)"


def test_rewrite_unknown_id_left_untouched():
    m = {"1": "Smith, 2020"}
    assert apa.rewrite_intext("see [7]", m) == "see [7]"


def test_rewrite_bare_adjacent_tokens():
    m = {"1": "Smith, 2020", "2": "Jones, 2018"}
    # bare (unparenthesised) run, space separated
    assert apa.rewrite_intext("evidence [1] [2] here", m) == "evidence (Jones, 2018; Smith, 2020) here"


# ── references-section stripping ──────────────────────────────────────────────


def test_strip_references_section_variants():
    body = "Answer text.\n\n### References\n\n* [1] /x/Foo.pdf\n"
    assert apa.strip_references_section(body) == "Answer text."
    assert apa.strip_references_section("No refs here.") == "No refs here."
    bold = "Body.\n\n**References**\n- [1] a"
    assert apa.strip_references_section(bold) == "Body."


# ── end-to-end render_answer ──────────────────────────────────────────────────


def test_render_answer_end_to_end():
    manifest = {"Westbury_Hollis_2019.pdf": ARTICLE, "Martin_2007.pdf": BOOK}
    content = (
        "Humor relies on incongruity [1], and resolution matters too [2].\n\n"
        "### References\n\n"
        "* [1] /scratch/devon7y/papers/Westbury_Hollis_2019.pdf\n"
        "* [2] /scratch/devon7y/papers/Martin_2007.pdf\n"
    )
    references = [
        {"reference_id": "1", "file_path": "/scratch/devon7y/papers/Westbury_Hollis_2019.pdf"},
        {"reference_id": "2", "file_path": "/scratch/devon7y/papers/Martin_2007.pdf"},
    ]
    answer, models = apa.render_answer(content, references, manifest)

    # in-text rewritten to APA7
    assert "incongruity (Westbury & Hollis, 2019)" in answer
    assert "resolution matters too (Martin, 2007)" in answer
    assert "[1]" not in answer and "[2]" not in answer

    # references block rebuilt, alphabetised (Martin before Westbury), with hades paths
    assert "### References" in answer
    assert answer.index("Martin, R. A.") < answer.index("Westbury, C.")
    assert "hades.psych.ualberta.ca:/Users/Shared/aprag_papers/Martin_2007.pdf" in answer

    # structured models returned for client localisation
    assert {m["filename"] for m in models} == {"Westbury_Hollis_2019.pdf", "Martin_2007.pdf"}
    assert all("apa" in m and "hades_path" in m for m in models)


def test_format_pages():
    assert apa.format_pages([12]) == "p. 12"
    assert apa.format_pages([12, 3, 19]) == "pp. 3, 12, 19"   # sorted
    assert apa.format_pages([5, 5, 5]) == "p. 5"               # deduped
    assert apa.format_pages([]) == ""
    assert apa.format_pages(None) == ""


def test_render_answer_with_pages_in_references_not_intext():
    manifest = {"Westbury_Hollis_2019.pdf": ARTICLE}
    content = ("Claim [1].\n\n### References\n* [1] /x/Westbury_Hollis_2019.pdf")
    references = [{"reference_id": "1", "file_path": "/x/Westbury_Hollis_2019.pdf"}]
    id_to_pages = {"1": [12, 3, 12]}  # unsorted + dup on purpose
    answer, models = apa.render_answer(content, references, manifest,
                                       id_to_pages=id_to_pages)
    # in-text has NO page locator
    assert "Claim (Westbury & Hollis, 2019)." in answer
    assert "p. 3" not in answer.split("### References")[0]
    # reference list shows the PDF pages
    assert "(pp. 3, 12)" in answer
    assert models[0]["pages"] == [3, 12]


def test_build_ref_model_drive_url_and_empty_hades():
    dmap = {"Westbury_Hollis_2019.pdf": "https://drive.google.com/file/d/ABC/view"}
    rm = apa.build_ref_model("1", "/x/Westbury_Hollis_2019.pdf", {}, drive_map=dmap)
    assert rm["drive_url"] == "https://drive.google.com/file/d/ABC/view"
    assert rm["hades_path"].endswith("/Westbury_Hollis_2019.pdf")
    # empty hades_base drops the hades path entirely
    rm2 = apa.build_ref_model("1", "Smith_2020.pdf", {}, hades_base="", drive_map=dmap)
    assert rm2["hades_path"] == "" and rm2["drive_url"] == ""  # not in map


def test_default_path_for_precedence():
    # drive preferred over hades over filename
    assert apa._default_path_for({"drive_url": "D", "hades_path": "H", "filename": "F"}) == "D"
    assert apa._default_path_for({"drive_url": "", "hades_path": "H", "filename": "F"}) == "H"
    assert apa._default_path_for({"drive_url": "", "hades_path": "", "filename": "F"}) == "F"


def test_render_answer_uses_drive_link_in_references():
    manifest = {"Martin_2007.pdf": BOOK}
    content = "Claim [1].\n\n### References\n* [1] /x/Martin_2007.pdf"
    references = [{"reference_id": "1", "file_path": "/x/Martin_2007.pdf"}]
    dmap = {"Martin_2007.pdf": "https://drive.google.com/file/d/XYZ/view"}
    answer, models = apa.render_answer(content, references, manifest, drive_map=dmap)
    assert "https://drive.google.com/file/d/XYZ/view" in answer  # drive link shown
    assert models[0]["drive_url"] == "https://drive.google.com/file/d/XYZ/view"


def test_render_answer_no_references_passthrough():
    answer, models = apa.render_answer("Just an answer, no citations.", [], {})
    assert answer == "Just an answer, no citations."
    assert models == []


def test_server_contract_from_aquery_llm_shape():
    # Mirror exactly what query_server.py extracts from an aquery_llm() result dict.
    result = {
        "status": "success",
        "llm_response": {"content": "Claim [1].\n\n### References\n* [1] /x/Martin_2007.pdf",
                         "is_streaming": False},
        "data": {"references": [{"reference_id": "1", "file_path": "/x/Martin_2007.pdf"}]},
    }
    content = (result.get("llm_response") or {}).get("content") or ""
    references = (result.get("data") or {}).get("references") or []
    answer, models = apa.render_answer(content, references, {"Martin_2007.pdf": BOOK})
    assert "Claim (Martin, 2007)." in answer
    assert models and models[0]["filename"] == "Martin_2007.pdf"


def test_manifest_loader_missing_file_returns_empty(tmp_path):
    assert apa.load_manifest(str(tmp_path / "nope.json")) == {}
    p = tmp_path / "m.json"
    p.write_text(json.dumps({"A_2020.pdf": {"authors": [{"family": "A"}], "year": "2020"}}))
    assert "A_2020.pdf" in apa.load_manifest(str(p))


def test_int_year_does_not_crash_formatting():
    """A filename-derived record (corpus-scoped manifest) carries an int year; APA
    formatting must coerce rather than raise — an AttributeError here 500s /papers."""
    record = {"type": "article", "year": 2026, "title": "A synthesized record",
              "authors": [{"family": "Song", "given": ""}]}
    assert "2026" in apa.format_apa7(record)
    assert "2026" in apa.format_intext(record)
