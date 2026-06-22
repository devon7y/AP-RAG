"""
apa_citations.py — turn LightRAG's numeric source citations into APA7.

LightRAG's answer LLM emits in-text tokens like ``[1]`` and a trailing
``### References`` list of raw file paths (it is *handed* a "Reference Document
List" of ``[n] <file_path>`` and told to cite by number). This module rewrites
that output, server-side, into proper APA7:

  * in-text ``[1]`` / ``([1], [3])`` → ``(Author, Year)`` / ``(A et al., 2018; B, 2020)``
  * the references section → a real APA7 list, alphabetised by author, each entry
    followed by a usable PDF path (the hades fallback share).

Bibliographic facts come from a per-filename manifest (``papers_metadata.json``)
keyed by the canonical PDF basename — the same name stored in the RAG, on hades,
and on a user's machine. When a manifest entry is missing we fall back to whatever
the filename itself encodes (``Author_Year.pdf``) so the output never regresses to
a bare path.

Pure-Python, no third-party deps, so it deploys next to ``query_server.py`` on the
PC. ``LightRAG/`` is never touched — the entry point is ``aquery_llm`` (which
returns both the answer text and the ``reference_id → file_path`` map), and all
reshaping happens here.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache

__all__ = [
    "DEFAULT_HADES_BASE",
    "load_manifest",
    "format_apa7",
    "format_intext",
    "build_ref_model",
    "rewrite_intext",
    "strip_references_section",
    "build_references_block",
    "render_answer",
]

#: Fallback PDF location shown when a user has no local copy (scp-style host:path).
DEFAULT_HADES_BASE = "hades.psych.ualberta.ca:/Users/Shared/aprag_papers"


# ── Manifest loading ──────────────────────────────────────────────────────────


@lru_cache(maxsize=8)
def load_manifest(path: str | None) -> dict:
    """Load ``papers_metadata.json`` (filename → bib record). Missing/bad → {}.

    Cached by path; the manifest is read-mostly and reloaded only on restart.
    """
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


# ── Small helpers ─────────────────────────────────────────────────────────────


def _basename(path: str) -> str:
    """OS-agnostic basename (handles both / and \\ from any platform)."""
    return re.split(r"[\\/]", str(path or "").strip())[-1]


def _tidy(text: str) -> str:
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s+\.", ".", text)
    text = re.sub(r"\.{2,}", ".", text)
    return text.strip()


def format_pages(pages) -> str:
    """APA page locator for a list of PDF pages: 'p. 12' / 'pp. 3, 12, 19' (else '')."""
    nums = sorted({int(p) for p in (pages or []) if str(p).strip() not in ("", "None")})
    if not nums:
        return ""
    body = ", ".join(str(n) for n in nums)
    return f"p. {body}" if len(nums) == 1 else f"pp. {body}"


def _normalize_doi(doi: str | None) -> str:
    doi = (doi or "").strip()
    if not doi:
        return ""
    doi = re.sub(r"^\s*(?:https?://(?:dx\.)?doi\.org/|doi:)\s*", "", doi, flags=re.IGNORECASE)
    return doi.rstrip(" .,;)")


def _initials(given: str | None) -> str:
    """'Chris' → 'C.'; 'Geoff B' → 'G. B.'; 'Jean-Paul' → 'J.-P.'."""
    given = (given or "").strip()
    if not given:
        return ""
    out: list[str] = []
    for token in given.split():
        if "-" in token:
            subs = [p for p in token.split("-") if p and p[0].isalpha()]
            if subs:
                out.append("-".join(f"{p[0].upper()}." for p in subs))
        elif token[0].isalpha():
            out.append(f"{token[0].upper()}.")
    return " ".join(out)


def _author_ref(author: dict) -> str:
    """Reference-list form: 'Family, G. I.'."""
    family = (author.get("family") or "").strip()
    initials = _initials(author.get("given"))
    if family and initials:
        return f"{family}, {initials}"
    return family or initials


def _join_authors_ref(authors: list[dict]) -> str:
    parts = [s for s in (_author_ref(a) for a in authors) if s]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if len(parts) <= 20:
        return ", ".join(parts[:-1]) + ", & " + parts[-1]
    # APA7: 21+ authors → first 19, ellipsis, final author.
    return ", ".join(parts[:19]) + ", ... " + parts[-1]


def _editor_ref(editor: dict) -> str:
    """Editor form in 'In ... (Eds.),': initials first — 'F. M. Last'."""
    initials = _initials(editor.get("given"))
    family = (editor.get("family") or "").strip()
    return f"{initials} {family}".strip()


def _join_editors(editors: list[dict]) -> str:
    parts = [s for s in (_editor_ref(e) for e in editors) if s]
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return f"{parts[0]} & {parts[1]}"
    return ", ".join(parts[:-1]) + ", & " + parts[-1]


def _surnames(authors: list[dict]) -> list[str]:
    return [s for s in ((a.get("family") or "").strip() for a in authors) if s]


# ── APA7 formatting ───────────────────────────────────────────────────────────


def format_intext(record: dict) -> str:
    """In-text citation *core* (no surrounding parentheses): 'Smith et al., 2019'."""
    year = (record.get("year") or "n.d.").strip()
    yr = f"{year}{record.get('disambig') or ''}"

    fams = _surnames(record.get("authors") or [])
    etal = bool(record.get("_etal"))
    if not fams:
        fams = _surnames(record.get("editors") or [])
    if not fams:
        title = (record.get("title") or record.get("container_title") or "").strip()
        short = " ".join(title.split()[:4])
        return f"{short}, {yr}" if short else yr

    if etal or len(fams) >= 3:
        head = f"{fams[0]} et al."
    elif len(fams) == 2:
        head = f"{fams[0]} & {fams[1]}"
    else:
        head = fams[0]
    return f"{head}, {yr}"


def format_apa7(record: dict) -> str:
    """Full APA7 reference-list entry. Italics use markdown ``*...*``."""
    authors = record.get("authors") or []
    authors_str = _join_authors_ref(authors)
    if record.get("_etal") and authors_str:
        authors_str = f"{authors_str} et al."

    year = (record.get("year") or "n.d.").strip()
    yr = f"({year}{record.get('disambig') or ''})."
    prefix = f"{authors_str} {yr}".strip() if authors_str else yr

    title = (record.get("title") or "").strip().rstrip(".")
    typ = (record.get("type") or "").strip().lower()
    container = (record.get("container_title") or "").strip()
    publisher = (record.get("publisher") or "").strip()
    volume = (record.get("volume") or "").strip()
    issue = (record.get("issue") or "").strip()
    pages = (record.get("pages") or "").strip()
    doi = _normalize_doi(record.get("doi"))

    if typ == "book":
        ref = prefix
        if title:
            ref += f" *{title}*."
        if publisher:
            ref += f" {publisher}."
    elif typ in ("chapter", "book-chapter"):
        ref = prefix
        if title:
            ref += f" {title}."
        editors = record.get("editors") or []
        eds = _join_editors(editors)
        label = "Ed." if len(editors) == 1 else "Eds."
        ref += " In "
        if eds:
            ref += f"{eds} ({label}), "
        if container:
            ref += f"*{container}*"
        if pages:
            ref += f" (pp. {pages})"
        ref += "."
        if publisher:
            ref += f" {publisher}."
    else:  # article / preprint / report / thesis / other → journal-style
        ref = prefix
        if title:
            ref += f" {title}."
        if container:
            ref += f" *{container}*"
            if volume:
                ref += f", *{volume}*"
                if issue:
                    ref += f"({issue})"
            elif issue:
                ref += f"({issue})"
            if pages:
                ref += f", {pages}"
            ref += "."
        elif pages:
            ref += f" {pages}."

    if doi:
        ref = ref.rstrip() + f" https://doi.org/{doi}"
    return _tidy(ref)


# ── Filename fallback (no manifest entry) ─────────────────────────────────────

_FILENAME_RE = re.compile(
    r"^(?P<a1>[A-Za-z][A-Za-z'-]*)(?:_(?P<a2>[A-Za-z][A-Za-z'-]*))?"
    r"_(?P<year>\d{4})(?P<dis>[a-z])?\.pdf$",
    re.IGNORECASE,
)


def _fallback_record(filename: str) -> dict:
    """Best-effort bib record parsed from a canonical ``Author_Year.pdf`` name.

    The result is intentionally minimal: it yields a sensible in-text citation and
    a reference line that still identifies the work, with the path appended by the
    caller. Anything unparseable degrades to the bare filename as a pseudo-title.
    """
    m = _FILENAME_RE.match(filename)
    if not m:
        stem = filename[:-4] if filename.lower().endswith(".pdf") else filename
        return {"type": "other", "authors": [], "year": "",
                "title": stem.replace("_", " ").strip()}

    a1, a2, year, dis = m.group("a1"), m.group("a2"), m.group("year"), m.group("dis")
    rec: dict = {"type": "other", "year": year, "disambig": dis or "", "title": ""}
    if a2 and a2.lower() == "etal":
        rec["authors"] = [{"family": a1, "given": ""}]
        rec["_etal"] = True
    elif a2:
        rec["authors"] = [{"family": a1, "given": ""}, {"family": a2, "given": ""}]
    else:
        rec["authors"] = [{"family": a1, "given": ""}]
    return rec


# ── Reference models + answer rewriting ───────────────────────────────────────


def build_ref_model(reference_id, file_path: str, manifest: dict,
                    hades_base: str = DEFAULT_HADES_BASE,
                    pages=None) -> dict:
    """One structured reference: {n, filename, apa, intext, hades_path, pages}.

    ``pages`` is the list of PDF pages the cited passages came from (empty if
    unknown, e.g. a store ingested before page-tracking).
    """
    filename = _basename(file_path)
    record = manifest.get(filename)
    if not isinstance(record, dict):
        record = _fallback_record(filename)
    page_nums = sorted({int(p) for p in (pages or [])
                        if str(p).strip() not in ("", "None")})
    return {
        "n": str(reference_id),
        "filename": filename,
        "apa": format_apa7(record),
        "intext": format_intext(record),
        "hades_path": f"{hades_base.rstrip('/')}/{filename}",
        "pages": page_nums,
    }


# A bracket citation token: [1] or [1, 2]; a run is one-or-more adjacent tokens
# (space/comma/semicolon separated). The cluster regex tries the fully-parenthesised
# form first so we collapse "([1], [3])" → "(...)" without swallowing a stray paren.
_BRACKET = r"\[[ \t]*\d+(?:[ \t]*[,;][ \t]*\d+)*[ \t]*\]"
_RUN = rf"{_BRACKET}(?:[ \t]*[,;]?[ \t]*{_BRACKET})*"
_CLUSTER_RE = re.compile(rf"\([ \t]*({_RUN})[ \t]*\)|({_RUN})")
_NUM_RE = re.compile(r"\d+")


def rewrite_intext(text: str, id_to_intext: dict) -> str:
    """Replace numeric in-text citations with APA7 parentheticals.

    ``[1]`` → ``(Smith, 2020)``; ``([1], [3], [4])`` → ``(A, 2018; B et al., 2020;
    …)`` with ids de-duplicated and the group alphabetised by author. If any id in
    a cluster is unknown the cluster is left untouched (defensive; with the
    filename fallback every id normally resolves).
    """
    if not text or not id_to_intext:
        return text

    def repl(match: re.Match) -> str:
        body = match.group(1) if match.group(1) is not None else match.group(2)
        seen: set[str] = set()
        labels: list[str] = []
        for cid in _NUM_RE.findall(body):
            if cid in seen:
                continue
            seen.add(cid)
            label = id_to_intext.get(cid)
            if label is None:
                return match.group(0)  # unknown id → leave cluster as-is
            labels.append(label)
        if not labels:
            return match.group(0)
        labels.sort(key=str.lower)
        return "(" + "; ".join(labels) + ")"

    return _CLUSTER_RE.sub(repl, text)


_REFS_HEADING_RE = re.compile(
    r"(?im)^[ \t]{0,3}(?:#{1,6}[ \t]*|\*\*[ \t]*)?references[ \t]*:?[ \t]*\**[ \t]*$"
)


def strip_references_section(text: str) -> str:
    """Drop the LLM's trailing ``References`` heading and everything after it."""
    if not text:
        return text
    matches = list(_REFS_HEADING_RE.finditer(text))
    if not matches:
        return text.rstrip()
    return text[: matches[-1].start()].rstrip()


def _default_path_for(ref: dict) -> str:
    return ref.get("hades_path", "")


def build_references_block(ref_models: list[dict], path_for=None) -> str:
    """Render the ``### References`` markdown block.

    ``path_for(ref) -> str`` controls the trailing locator per entry (server passes
    the plain hades path; the client swaps in a clickable local ``file://`` link).
    """
    path_for = path_for or _default_path_for
    lines = ["### References", ""]
    for ref in ref_models:
        # PDF pages where the cited passages appear (distinct from a journal article's
        # printed page range, which is inside the APA text itself).
        pages = format_pages(ref.get("pages"))
        entry = f"- {ref['apa']}"
        if pages:
            entry += f" ({pages})"
        locator = path_for(ref)
        if locator:
            entry += f" — {locator}"
        lines.append(entry)
    return "\n".join(lines)


def render_answer(content: str, references: list[dict], manifest: dict,
                  hades_base: str = DEFAULT_HADES_BASE,
                  id_to_pages: dict | None = None) -> tuple[str, list[dict]]:
    """Rewrite a LightRAG answer into APA7 and return (answer, ref_models).

    ``references`` is the ``data.references`` list from ``aquery_llm`` (each
    ``{reference_id, file_path}``). ``id_to_pages`` optionally maps a reference_id to
    the PDF pages its retrieved chunks came from (the server builds it from
    ``text_chunks``); those pages are shown in the reference list (never in-text). The
    returned answer is self-contained (APA in-text + an APA references block with hades
    paths); ``ref_models`` lets the aprag clients re-render the block with local links.
    """
    if not content:
        return content or "", []

    id_to_pages = id_to_pages or {}
    ref_models: list[dict] = []
    id_to_intext: dict[str, str] = {}
    for ref in references or []:
        rid = str(ref.get("reference_id") or "").strip()
        if not rid:
            continue
        model = build_ref_model(rid, ref.get("file_path") or "", manifest,
                                hades_base, pages=id_to_pages.get(rid))
        ref_models.append(model)
        id_to_intext[rid] = model["intext"]

    body = rewrite_intext(strip_references_section(content), id_to_intext)

    # APA references are alphabetised by author; the numeric ids are now gone.
    ref_models.sort(key=lambda r: r["intext"].lower())
    if ref_models:
        body = body.rstrip() + "\n\n" + build_references_block(ref_models)
    return body, ref_models
