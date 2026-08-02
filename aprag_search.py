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
  * ``list_papers`` / ``slim_paper_row`` — filtered/sorted/paginated manifest listing
    for ``/papers`` (the web Paper Database table).

The async I/O (query embedding, the Qdrant filtered query, ``text_chunks`` page lookups,
the answer LLM) lives in ``query_server.py``. Pure stdlib here so it deploys next to
``query_server.py`` and is unit-testable without LightRAG/Qdrant/OpenAI installed.
"""
from __future__ import annotations

import re

import apa_citations as apa

#: Recognised filter dimensions (all optional; AND across dimensions, OR within a list).
FILTER_KEYS = ("papers", "authors", "year", "years", "year_from", "year_to",
               "date_from", "date_to",
               "journals", "subjects", "keywords", "affiliations", "types")


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


def _date_endpoint(value, end: bool) -> tuple[int, int, int] | None:
    """A partial date string (``YYYY`` | ``YYYY-MM`` | ``YYYY-MM-DD``) as a comparable
    (y, m, d) tuple at the START (``end=False``) or END (``end=True``) of the interval it
    denotes: ``"2026-03"`` -> start (2026, 3, 1), end (2026, 3, 31)."""
    m = re.match(r"\s*(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?", str(value or ""))
    if not m:
        return None
    y = int(m.group(1))
    mo = int(m.group(2)) if m.group(2) else (12 if end else 1)
    d = int(m.group(3)) if m.group(3) else (31 if end else 1)
    return (y, mo, d)


def _record_date_bounds(record: dict) -> tuple[tuple, tuple] | None:
    """[start, end] (y, m, d) tuples for a record's stored ``date`` (expanded to the
    interval its precision denotes), falling back to the bare ``year`` (whole year).
    None when the record has neither — such records can't satisfy a date-window filter."""
    ds = record.get("date")
    if ds:
        return _date_endpoint(ds, False), _date_endpoint(ds, True)
    y = _record_year(record)
    if y is None:
        return None
    return (y, 1, 1), (y, 12, 31)


def _passes_date_window(record: dict, date_from, date_to) -> bool:
    """Precision-aware interval overlap: the record's date interval must intersect
    ``[date_from-start, date_to-end]``. A year-only record therefore still matches a
    month window inside its year (the digest marks it date-imprecise rather than dropping)."""
    bounds = _record_date_bounds(record)
    if bounds is None:
        return False
    r_start, r_end = bounds
    if date_from is not None:
        f_start = _date_endpoint(date_from, False)
        if f_start and r_end < f_start:
            return False
    if date_to is not None:
        t_end = _date_endpoint(date_to, True)
        if t_end and r_start > t_end:
            return False
    return True


def _paper_stem(name: str) -> str:
    n = str(name or "").strip().lower()
    return n[:-4] if n.endswith(".pdf") else n


def record_matches(record: dict, filters: dict, filename: str = "") -> bool:
    """True if a manifest record satisfies every specified filter dimension.

    ``filename`` is the record's manifest key — needed only by the ``papers`` filter
    (specific papers pinned by filename, ".pdf" optional, case-insensitive exact match).
    """
    papers = _lc_list(filters.get("papers"))
    if papers:
        if _paper_stem(filename) not in {_paper_stem(p) for p in papers}:
            return False

    authors = _lc_list(filters.get("authors"))
    if authors:
        fams = [(a.get("family") or "").lower()
                for a in (record.get("authors") or []) + (record.get("editors") or [])]
        if not _any_substr(authors, fams):
            return False

    year = _record_year(record)
    if filters.get("year") is not None and year != int(filters["year"]):
        return False
    years = filters.get("years")
    if years:
        if year is None or year not in {int(y) for y in years}:
            return False
    if filters.get("year_from") is not None and (year is None or year < int(filters["year_from"])):
        return False
    if filters.get("year_to") is not None and (year is None or year > int(filters["year_to"])):
        return False

    if filters.get("date_from") is not None or filters.get("date_to") is not None:
        if not _passes_date_window(record, filters.get("date_from"), filters.get("date_to")):
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

    types = _lc_list(filters.get("types"))
    if types and (record.get("type") or "").strip().lower() not in types:
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
        if isinstance(rec, dict) and record_matches(rec, filters, filename=fn)
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


# ── Paper Database listing (/papers) ────────────────────────────────────────────

#: Sort dimensions accepted by ``list_papers`` (anything else falls back to "year").
LIST_SORT_KEYS = ("title", "first_author", "year", "date", "journal")

#: Manifest fields carried on a slim table row (abstract/affiliations/editors/flags
#: stay in the detail view — the abstract alone would triple the page payload).
_SLIM_FIELDS = ("title", "authors", "year", "date", "date_precision",
                "container_title", "volume", "issue", "pages", "doi",
                "type", "publisher", "keywords", "subjects", "source")


def slim_paper_row(filename: str, record: dict) -> dict:
    """One table row for ``/papers`` (the caller adds apa/intext/drive_url)."""
    row = {"filename": filename}
    for f in _SLIM_FIELDS:
        row[f] = record.get(f) or ("" if f not in ("authors", "keywords", "subjects") else [])
    return row


def quick_match(filename: str, record: dict, q: str) -> bool:
    """Case-insensitive token match over the fields a user is likely to half-remember:
    title, author names, journal, DOI, and the filename itself. Every whitespace token
    must match somewhere (each in any field), so "westbury humor" finds Westbury's
    humor papers rather than requiring the literal phrase."""
    hay = [filename, record.get("title") or "", record.get("container_title") or "",
           record.get("doi") or ""]
    for a in (record.get("authors") or []) + (record.get("editors") or []):
        hay.append(f"{a.get('given') or ''} {a.get('family') or ''}")
    hay = [h.lower() for h in hay if h]
    tokens = q.strip().lower().split()
    return all(any(tok in h for h in hay) for tok in tokens)


def _sort_value(record: dict, sort: str):
    """The comparable sort key for one record, or None when the field is missing
    (missing values always sort last, regardless of direction)."""
    if sort == "title":
        t = (record.get("title") or "").strip().lower()
        return t or None
    if sort == "first_author":
        authors = record.get("authors") or []
        fam = (authors[0].get("family") or "").strip().lower() if authors else ""
        return fam or None
    if sort == "date":
        bounds = _record_date_bounds(record)
        return bounds[0] if bounds else None
    if sort == "journal":
        j = (record.get("container_title") or "").strip().lower()
        return j or None
    return _record_year(record)  # "year" and any unrecognized key


def list_papers(manifest: dict, filters: dict | None = None, q: str | None = None,
                sort: str = "year", order: str = "desc",
                offset: int = 0, limit: int = 50) -> tuple[int, list[tuple[str, dict]]]:
    """Filter + quick-match + sort + paginate the manifest for ``/papers``.

    Returns ``(total_after_filtering, page)`` where ``page`` is the requested slice as
    ``(filename, record)`` pairs — the caller formats rows (APA strings are built only
    for the page, not the whole corpus).
    """
    if sort not in LIST_SORT_KEYS:
        sort = "year"
    active_filters = filters if has_filters(filters) else None
    needle = (q or "").strip()

    present: list[tuple] = []   # (sort_value, filename, record)
    absent: list[tuple] = []    # missing sort field — appended after, filename-ordered
    for fn, rec in (manifest or {}).items():
        if not isinstance(rec, dict):
            continue
        if active_filters and not record_matches(rec, active_filters, filename=fn):
            continue
        if needle and not quick_match(fn, rec, needle):
            continue
        sv = _sort_value(rec, sort)
        (present if sv is not None else absent).append((sv, fn, rec))

    present.sort(key=lambda t: (t[0], t[1]), reverse=(order == "desc"))
    absent.sort(key=lambda t: t[1])
    ranked = present + absent

    total = len(ranked)
    offset = max(0, int(offset))
    limit = max(1, int(limit))
    page = [(fn, rec) for _, fn, rec in ranked[offset:offset + limit]]
    return total, page
