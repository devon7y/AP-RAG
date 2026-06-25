"""
aprag_search.py — metadata-filtered semantic search (pure helpers, no I/O).

The query server lets a caller scope a semantic search by the bibliographic metadata
we already extract for citations — e.g. "papers about *meaning*, but only those authored
by *Westbury*". This module holds the pure logic:

  * ``resolve_filter`` — turn a filter dict into the set of matching PDF filenames
    (from the manifest that also powers APA7 citations).
  * ``assign_reference_ids`` — number a chunk set by file (for the filtered synthesis
    path, mirroring LightRAG's per-file reference scheme).
  * ``build_synthesis_context`` / ``SYNTH_SYSTEM_PROMPT`` — assemble the prompt for the
    filtered answer, whose ``[n]`` citations ``apa_citations.render_answer`` rewrites.
  * ``rank_papers`` — fold filtered chunks into ranked papers for ``/search``.

The async I/O (query embedding, the Qdrant filtered query, ``text_chunks`` page lookups,
the answer LLM) lives in ``query_server.py``. Pure stdlib here so it deploys next to
``query_server.py`` and is unit-testable without LightRAG/Qdrant/OpenAI installed.
"""
from __future__ import annotations

import re

import apa_citations as apa

#: Recognised filter dimensions (all optional; AND across dimensions, OR within a list).
FILTER_KEYS = ("authors", "year", "year_from", "year_to",
               "journals", "subjects", "keywords", "affiliations")


def has_filters(filters: dict | None) -> bool:
    if not filters:
        return False
    return any(filters.get(k) not in (None, "", [], ()) for k in FILTER_KEYS)


def _lc_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    return [str(v).strip().lower() for v in value if str(v).strip()]


def _any_substr(needles: list[str], haystacks: list[str]) -> bool:
    hay = [h for h in haystacks if h]
    return any(any(n in h for h in hay) for n in needles)


def _record_year(record: dict) -> int | None:
    m = re.search(r"\d{4}", str(record.get("year") or ""))
    return int(m.group()) if m else None


def record_matches(record: dict, filters: dict) -> bool:
    """True if a manifest record satisfies every specified filter dimension."""
    authors = _lc_list(filters.get("authors"))
    if authors:
        fams = [(a.get("family") or "").lower()
                for a in (record.get("authors") or []) + (record.get("editors") or [])]
        if not _any_substr(authors, fams):
            return False

    year = _record_year(record)
    if filters.get("year") is not None and year != int(filters["year"]):
        return False
    if filters.get("year_from") is not None and (year is None or year < int(filters["year_from"])):
        return False
    if filters.get("year_to") is not None and (year is None or year > int(filters["year_to"])):
        return False

    journals = _lc_list(filters.get("journals"))
    if journals and not _any_substr(journals, [(record.get("container_title") or "").lower()]):
        return False

    subjects = _lc_list(filters.get("subjects"))
    if subjects and not _any_substr(subjects, _lc_list(record.get("subjects"))):
        return False

    keywords = _lc_list(filters.get("keywords"))
    if keywords and not _any_substr(keywords, _lc_list(record.get("keywords"))):
        return False

    affiliations = _lc_list(filters.get("affiliations"))
    if affiliations and not _any_substr(affiliations, _lc_list(record.get("affiliations"))):
        return False

    return True


def resolve_filter(filters: dict | None, manifest: dict) -> set[str] | None:
    """Filenames whose metadata matches ``filters`` — or None when no filter is active.

    Returns an empty set when filters are active but nothing matches (the caller then
    retrieves nothing, which is correct). None means "unfiltered" (caller uses the normal
    retrieval path).
    """
    if not has_filters(filters):
        return None
    return {
        fn for fn, rec in (manifest or {}).items()
        if isinstance(rec, dict) and record_matches(rec, filters)
    }


def assign_reference_ids(chunks: list[dict]) -> list[dict]:
    """Assign a per-file ``reference_id`` (frequency-ranked) to each chunk and return the
    reference list — mirrors LightRAG's ``generate_reference_list_from_chunks`` so the
    filtered synthesis path produces the same ``[n]`` citation scheme.
    """
    counts: dict[str, int] = {}
    order: list[str] = []
    for c in chunks:
        fp = c.get("file_path") or ""
        if fp and fp != "unknown_source":
            if fp not in counts:
                order.append(fp)
            counts[fp] = counts.get(fp, 0) + 1
    ranked = sorted(order, key=lambda fp: (-counts[fp], order.index(fp)))
    fp_to_id = {fp: str(i + 1) for i, fp in enumerate(ranked)}
    for c in chunks:
        c["reference_id"] = fp_to_id.get(c.get("file_path", ""), "")
    return [{"reference_id": fp_to_id[fp], "file_path": fp} for fp in ranked]


SYNTH_SYSTEM_PROMPT = (
    "You are a research assistant answering from a filtered set of academic papers. "
    "Answer the user's question using ONLY the provided Document Chunks. Cite sources "
    "inline as [n], where n is the reference_id from the Reference Document List. End "
    "with a '### References' section listing each cited source as '* [n] <file_path>'. "
    "If the chunks do not address the question, say so plainly."
)


def build_synthesis_context(references: list[dict], chunks: list[dict]) -> str:
    """Context block for the filtered-answer LLM call (reference list + tagged chunks)."""
    ref_lines = "\n".join(f"[{r['reference_id']}] {r['file_path']}" for r in references)
    chunk_lines = "\n\n".join(
        f"[{c.get('reference_id', '')}] {c.get('content', '')}"
        for c in chunks if c.get("content")
    )
    return (f"-----Reference Document List-----\n{ref_lines}\n\n"
            f"-----Document Chunks-----\n{chunk_lines}")


def rank_papers(chunks: list[dict], manifest: dict, hades_base: str,
                pages_by_file: dict | None = None, drive_map: dict | None = None) -> list[dict]:
    """Fold filtered chunks into ranked papers (best score + snippet per file)."""
    pages_by_file = pages_by_file or {}
    best: dict[str, dict] = {}
    for c in chunks:
        fp = c.get("file_path") or ""
        if not fp:
            continue
        score = float(c.get("score") or 0.0)
        entry = best.setdefault(fp, {"score": score, "snippet": "", "n": 0})
        entry["n"] += 1
        if score >= entry["score"] or not entry["snippet"]:
            entry["score"] = max(score, entry["score"])
            entry["snippet"] = (c.get("content") or "").strip()[:300]

    papers = []
    for fp, info in best.items():
        rm = apa.build_ref_model("", fp, manifest, hades_base,
                                 pages=pages_by_file.get(fp), drive_map=drive_map)
        papers.append({
            "filename": rm["filename"],
            "apa": rm["apa"],
            "drive_url": rm["drive_url"],
            "hades_path": rm["hades_path"],
            "pages": rm["pages"],
            "score": round(info["score"], 4),
            "n_chunks": info["n"],
            "snippet": info["snippet"],
        })
    papers.sort(key=lambda p: -p["score"])
    return papers
