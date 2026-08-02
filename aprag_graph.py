"""
aprag_graph.py — knowledge-graph explorer helpers (pure logic, no I/O).

The web app's Knowledge Graph explorer (/graph) browses the entities and relations
LightRAG extracted at ingest time. The graph lives in memory on the query server
(``_rag.chunk_entity_relation_graph._graph`` — a ``networkx.Graph`` whose nodes carry
``entity_type`` / ``description`` / ``file_path`` and whose edges carry ``description``
/ ``keywords`` / ``weight``; multi-valued fields are ``<SEP>``-joined). This module
holds the pure shaping logic — index building, search, overview, entity detail — so it
deploys next to ``query_server.py`` and is unit-testable without LightRAG. The async
FastAPI endpoints (and their caches) live in ``query_server.py``.
"""
from __future__ import annotations

GRAPH_FIELD_SEP = "<SEP>"

#: Truncation for list-row description snippets (full text stays in the detail view).
SNIPPET_CHARS = 240


def _split_field(value) -> list[str]:
    """A ``<SEP>``-joined graph field as a clean list."""
    if not value:
        return []
    return [v.strip() for v in str(value).split(GRAPH_FIELD_SEP) if v.strip()]


def node_files(attrs: dict) -> list[str]:
    """The paper filenames a node was extracted from (order-preserving, deduped)."""
    seen: set[str] = set()
    out: list[str] = []
    for f in _split_field((attrs or {}).get("file_path")):
        if f and f != "unknown_source" and f not in seen:
            seen.add(f)
            out.append(f)
    return out


def clean_type(value) -> str:
    """Normalize an ``entity_type`` attr for display ('' when absent)."""
    return str(value or "").strip().strip('"').strip()


def snippet(text, limit: int = SNIPPET_CHARS) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


# ── Entity index ─────────────────────────────────────────────────────────────
# One compact row per node, sorted by degree (the graph's own importance signal).
# Descriptions are NOT stored here (they dominate memory on a large graph); list
# endpoints re-read them from the graph for just the returned page.

#: Index row: (name_lower, name, type, degree, n_papers)
IndexRow = tuple


def build_entity_index(graph) -> list[IndexRow]:
    rows: list[IndexRow] = []
    for name, attrs in graph.nodes(data=True):
        n = str(name)
        rows.append((
            n.lower(),
            n,
            clean_type((attrs or {}).get("entity_type")),
            int(graph.degree(name)),
            len(node_files(attrs or {})),
        ))
    rows.sort(key=lambda r: (-r[3], r[0]))
    return rows


def canonical_name(index: list[IndexRow], name: str) -> str | None:
    """Resolve a caller-supplied entity name case-insensitively (None if unknown)."""
    target = str(name or "").strip().lower()
    if not target:
        return None
    for r in index:
        if r[0] == target:
            return r[1]
    return None


def overview(graph, index: list[IndexRow], top_per_type: int = 5) -> dict:
    """Corpus-level graph stats: sizes + per-type counts with the top entities."""
    types: dict[str, dict] = {}
    for _, name, etype, _degree, _n in index:  # index is degree-sorted
        key = etype.lower() or "unknown"
        entry = types.get(key)
        if entry is None:
            entry = {"type": etype or "unknown", "count": 0, "top": []}
            types[key] = entry
        entry["count"] += 1
        if len(entry["top"]) < top_per_type:
            entry["top"].append(name)
    return {
        "entities": len(index),
        "relations": int(graph.number_of_edges()),
        "types": sorted(types.values(), key=lambda t: -t["count"]),
    }


def search_entities(
    index: list[IndexRow],
    q: str | None = None,
    etype: str | None = None,
    names: set[str] | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[int, list[IndexRow]]:
    """Filter the degree-sorted index (substring name match + exact type match +
    optional canonical-name allowlist) and return ``(total, page)``."""
    needle = (q or "").strip().lower()
    type_needle = (etype or "").strip().lower()
    hits: list[IndexRow] = []
    for r in index:
        if needle and needle not in r[0]:
            continue
        if type_needle and (r[2].lower() or "unknown") != type_needle:
            continue
        if names is not None and r[1] not in names:
            continue
        hits.append(r)
    offset = max(0, int(offset))
    limit = max(1, int(limit))
    return len(hits), hits[offset:offset + limit]


def entity_summary(graph, row: IndexRow) -> dict:
    """One list-row payload (re-reads the description for just this row)."""
    _lower, name, etype, degree, n_papers = row
    attrs = graph.nodes[name] if graph.has_node(name) else {}
    return {
        "name": name,
        "type": etype or "unknown",
        "degree": degree,
        "papers": n_papers,
        "description": snippet((attrs or {}).get("description")),
    }


def build_file_map(index: list[IndexRow], graph) -> dict[str, list[str]]:
    """filename (lowercased, '.pdf' kept) → entity names, in degree order — the
    reverse lookup behind 'concepts in this paper'."""
    out: dict[str, list[str]] = {}
    for _lower, name, _etype, _degree, _n in index:
        attrs = graph.nodes[name] if graph.has_node(name) else {}
        for f in node_files(attrs or {}):
            out.setdefault(f.lower(), []).append(name)
    return out


# ── Entity detail ────────────────────────────────────────────────────────────


def entity_detail(
    graph,
    name: str,
    max_relations: int = 60,
    max_files: int = 60,
) -> dict | None:
    """Everything the entity page shows: the consolidated description, the
    neighbours (strongest edges first, each with the connecting description),
    and the papers the entity was extracted from."""
    if not graph.has_node(name):
        return None
    attrs = graph.nodes[name] or {}

    relations = []
    for _src, other, edge in graph.edges(name, data=True):
        edge = edge or {}
        other_attrs = graph.nodes[other] or {}
        relations.append({
            "entity": str(other),
            "entity_type": clean_type(other_attrs.get("entity_type")) or "unknown",
            "degree": int(graph.degree(other)),
            "description": snippet(edge.get("description"), 320),
            "keywords": snippet(edge.get("keywords"), 120),
            "weight": float(edge.get("weight") or 0.0),
        })
    relations.sort(key=lambda r: (-r["weight"], -r["degree"], r["entity"].lower()))

    files = node_files(attrs)
    return {
        "name": str(name),
        "type": clean_type(attrs.get("entity_type")) or "unknown",
        "description": " ".join(str(attrs.get("description") or "").split()),
        "degree": int(graph.degree(name)),
        "n_relations": len(relations),
        "relations": relations[:max_relations],
        "n_papers": len(files),
        "files": files[:max_files],
    }
