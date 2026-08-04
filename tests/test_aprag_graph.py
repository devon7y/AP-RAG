"""
Tests for aprag_graph.py — knowledge-graph explorer shaping helpers.

Run: python -m pytest tests/test_aprag_graph.py -v
"""

import sys
from pathlib import Path

import networkx as nx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import aprag_graph as g  # noqa: E402

SEP = g.GRAPH_FIELD_SEP


def make_graph() -> nx.Graph:
    G = nx.Graph()
    G.add_node(
        "Humor",
        entity_type="Concept",
        description="Humor as studied across the corpus.",
        file_path=f"Martin_2007.pdf{SEP}Westbury_Hollis_2019.pdf",
    )
    G.add_node(
        "Word Frequency",
        entity_type="Concept",
        description="Frequency of word occurrence in language corpora.",
        file_path="Westbury_Hollis_2019.pdf",
    )
    G.add_node(
        "Lexical Decision",
        entity_type="Method",
        description="A word/nonword judgement task.",
        file_path=f"Westbury_Hollis_2019.pdf{SEP}unknown_source",
    )
    G.add_node("Chris Westbury", entity_type='"Author"', description="Researcher.",
               file_path="Westbury_Hollis_2019.pdf")
    G.add_node("Orphan", description="No type, no files.")
    G.add_edge("Humor", "Word Frequency",
               description="Funniness correlates with word frequency.",
               keywords="humor, frequency", weight=9.0)
    G.add_edge("Humor", "Lexical Decision",
               description="Humor rated after lexical decision.", weight=4.0)
    G.add_edge("Humor", "Chris Westbury",
               description="Studied humor.", weight=7.0)
    G.add_edge("Word Frequency", "Lexical Decision",
               description="Frequency predicts decision times.", weight=8.0)
    return G


def test_node_files_splits_and_drops_unknown():
    G = make_graph()
    assert g.node_files(G.nodes["Humor"]) == [
        "Martin_2007.pdf", "Westbury_Hollis_2019.pdf"]
    assert g.node_files(G.nodes["Lexical Decision"]) == ["Westbury_Hollis_2019.pdf"]
    assert g.node_files(G.nodes["Orphan"]) == []


def test_node_files_ignores_the_truncation_marker():
    """A capped entity carries a "...truncated..." placeholder where the papers it
    stopped recording would be. Counting it as a paper is what made every hub entity
    claim an identical 76 papers — one more than LightRAG's cap of 75."""
    attrs = {"file_path": g.GRAPH_FIELD_SEP.join(
        ["A_2001.pdf", "B_2002.pdf", "...truncated...(KEEP Old)"])}
    assert g.node_files(attrs) == ["A_2001.pdf", "B_2002.pdf"]
    assert g.files_truncated(attrs) is True
    assert g.files_truncated({"file_path": "A_2001.pdf"}) is False


def test_index_sorted_by_degree_then_name():
    G = make_graph()
    idx = g.build_entity_index(G)
    assert [r[1] for r in idx] == [
        "Humor",  # degree 3
        "Lexical Decision", "Word Frequency",  # degree 2, name order
        "Chris Westbury",  # degree 1
        "Orphan",  # degree 0
    ]
    humor = idx[0]
    assert humor[2] == "Concept" and humor[3] == 3 and humor[4] == 2


def test_canonical_name_case_insensitive():
    idx = g.build_entity_index(make_graph())
    assert g.canonical_name(idx, "humor") == "Humor"
    assert g.canonical_name(idx, "CHRIS WESTBURY") == "Chris Westbury"
    assert g.canonical_name(idx, "nope") is None


def test_overview_counts_types_and_tops():
    G = make_graph()
    ov = g.overview(G, g.build_entity_index(G))
    assert ov["entities"] == 5 and ov["relations"] == 4
    by_type = {t["type"]: t for t in ov["types"]}
    assert by_type["Concept"]["count"] == 2
    assert by_type["Concept"]["top"] == ["Humor", "Word Frequency"]
    assert by_type["Method"]["count"] == 1
    assert by_type["Author"]["count"] == 1  # quoted type is cleaned
    assert by_type["unknown"]["count"] == 1


def test_search_by_substring_type_and_allowlist():
    G = make_graph()
    idx = g.build_entity_index(G)
    total, page = g.search_entities(idx, q="word")
    assert total == 1 and page[0][1] == "Word Frequency"
    total, page = g.search_entities(idx, etype="concept")
    assert total == 2 and [r[1] for r in page] == ["Humor", "Word Frequency"]
    total, page = g.search_entities(idx, names={"Humor", "Orphan"})
    assert [r[1] for r in page] == ["Humor", "Orphan"]
    total, page = g.search_entities(idx, limit=2, offset=1)
    assert total == 5 and len(page) == 2 and page[0][1] == "Lexical Decision"


def test_file_map_reverse_lookup():
    G = make_graph()
    idx = g.build_entity_index(G)
    fm = g.build_file_map(idx, G)
    assert fm["westbury_hollis_2019.pdf"][0] == "Humor"  # degree order
    assert set(fm["westbury_hollis_2019.pdf"]) == {
        "Humor", "Word Frequency", "Lexical Decision", "Chris Westbury"}
    assert fm["martin_2007.pdf"] == ["Humor"]


def test_entity_detail_relations_sorted_by_weight():
    G = make_graph()
    d = g.entity_detail(G, "Humor")
    assert d["type"] == "Concept" and d["degree"] == 3
    assert d["n_papers"] == 2 and d["files"][0] == "Martin_2007.pdf"
    assert [r["entity"] for r in d["relations"]] == [
        "Word Frequency", "Chris Westbury", "Lexical Decision"]
    assert d["relations"][0]["entity_type"] == "Concept"
    assert d["relations"][0]["weight"] == 9.0
    assert g.entity_detail(G, "missing") is None


def test_snippet_truncates():
    assert g.snippet("a  b\n c") == "a b c"
    long = "x" * 500
    out = g.snippet(long)
    assert len(out) == g.SNIPPET_CHARS and out.endswith("…")
