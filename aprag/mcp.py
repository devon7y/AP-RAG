#!/usr/bin/env python3
"""
aprag.mcp — MCP server for the AP-RAG academic-papers knowledge base.

Thin stdio MCP server that forwards to the AP-RAG query server (LightRAG + Qdrant +
embeddings + an answer LLM). Holds no models and no data; it just shapes nine tools
over `aprag.client`:

    aprag_query     synthesized, APA-cited answer
    aprag_search    ranked papers for a topic
    aprag_retrieve  raw chunks/entities/relationships (multi-hop primitive)
    aprag_corpus    what the metadata filters actually accept (authors/journals/...)
    aprag_papers    browse the manifest / one paper's full record
    aprag_similar   papers nearest a given paper ("more like this")
    aprag_locate    which page of a PDF a quoted passage sits on
    aprag_graph     knowledge-graph entities and their connections
    aprag_trends    corpus-wide publication trends

Two conventions run through all of them:

* **A filter that matches nothing is an error, not an empty result.** A typo'd
  author used to come back as a bare "0 paper(s) found", indistinguishable from a
  genuine gap in the corpus, which invites the caller to report a false negative.
  Filters are now checked against the corpus first and a mismatch raises with
  "did you mean" suggestions. See `_validate_filters`.
* **Failures raise.** Every tool returns a `CallToolResult` carrying both readable
  text and `structuredContent`; errors raise `ToolError` so the protocol marks the
  result `isError` instead of handing back prose that reads like an answer.

Server selection: $APRAG_QUERY_URL (default http://localhost:8001). Point it at your
deployment, e.g. register with `--env APRAG_QUERY_URL=http://<host>:8001`.

Register (after `pip install .` puts `aprag-mcp` on PATH):
    claude mcp add --scope user aprag \\
        --env APRAG_QUERY_URL=http://<host>:8001 -- aprag-mcp
"""

from __future__ import annotations

import asyncio
import contextlib
import difflib
import logging
import sys
from typing import Annotated, Any, Literal

# All diagnostics go to stderr; stdout is reserved for JSON-RPC on a stdio server.
# basicConfig must run before importing mcp so any import-time logs land on stderr.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

from mcp.server.fastmcp import Context, FastMCP  # noqa: E402
from mcp.server.fastmcp.exceptions import ToolError  # noqa: E402
from mcp.types import CallToolResult, TextContent, ToolAnnotations  # noqa: E402
from pydantic import Field  # noqa: E402

from . import client, references  # noqa: E402
from .client import APRAGError  # noqa: E402

mcp = FastMCP("aprag")

# Every tool here only reads the corpus: safe to retry, safe to run without a
# confirmation prompt, and backed by a remote service rather than local state.
READ_ONLY = ToolAnnotations(readOnlyHint=True, idempotentHint=True, openWorldHint=True)


# ── Shared parameter types ────────────────────────────────────────────────────
#
# Declared once and reused across the tools so the eleven metadata filters cannot
# drift apart, and so each argument carries its own description in the JSON schema
# (the model reads these per-argument, rather than hunting through a prose docstring).

QueryMode = Annotated[
    Literal["hybrid", "local", "global", "mix", "naive"],
    Field(description="Retrieval strategy. 'hybrid' combines graph and vector search."),
]
RetrieveMode = Annotated[
    Literal["naive", "local", "global", "hybrid", "mix"],
    Field(description=(
        "Retrieval strategy. 'naive' = plain vector search, chunks only (no graph). "
        "'local' = entities plus their chunks (specific leads). 'global' = "
        "relationships plus connected entities (broad themes). 'hybrid'/'mix' = both."
    )),
]
Reasoning = Annotated[
    Literal["none", "low", "medium", "high", "xhigh"],
    Field(description=(
        "Answer-LLM effort. 'none' is fastest; raise it for hard questions at the "
        "cost of latency."
    )),
]

Papers = Annotated[list[str] | None, Field(description=(
    "Pin specific papers by filename (e.g. ['Westbury_2019.pdf']; '.pdf' optional). "
    "Draws ONLY on these papers."
))]
Authors = Annotated[list[str] | None, Field(description=(
    "Restrict to these authors. A surname ('Zhang') means every author with it; "
    "'Family, Given' ('Zhang, Kechen') means that one person. Use aprag_corpus to "
    "look up exact spellings."
))]
Year = Annotated[int | None, Field(description="Restrict to this exact publication year.")]
YearFrom = Annotated[int | None, Field(description="Earliest publication year (inclusive).")]
YearTo = Annotated[int | None, Field(description="Latest publication year (inclusive).")]
DateFrom = Annotated[str | None, Field(description="Earliest publication date, YYYY-MM-DD.")]
DateTo = Annotated[str | None, Field(description="Latest publication date, YYYY-MM-DD.")]
Journals = Annotated[list[str] | None, Field(description=(
    "Restrict to these journals/venues (substring match on the container title)."
))]
Subjects = Annotated[list[str] | None, Field(description=(
    "Restrict to these subject/field labels (substring match)."
))]
Keywords = Annotated[list[str] | None, Field(description=(
    "Restrict to papers carrying these keywords (substring match)."
))]
Affiliations = Annotated[list[str] | None, Field(description=(
    "Restrict to these institutions (substring match)."
))]
Types = Annotated[list[str] | None, Field(description=(
    "Restrict to these publication types (exact match, e.g. 'article', 'chapter')."
))]


# ── Result and error plumbing ─────────────────────────────────────────────────


def _ok(text: str, **structured: Any) -> CallToolResult:
    """A successful tool result: readable text for the model, structured data beside it.

    Returning `CallToolResult` directly (rather than a str or a model) is what lets
    both travel together — FastMCP passes it through untouched, so the caller gets
    the formatted APA prose *and* machine-readable fields instead of one or the other.
    """
    return CallToolResult(
        content=[TextContent(type="text", text=text)],
        structuredContent=structured,
    )


@contextlib.asynccontextmanager
async def _api(action: str):
    """Turn a client-layer failure into a real MCP error.

    These used to be returned as ordinary strings ("Query failed: ..."), which the
    protocol reports as a *successful* call — so an outage reached the model looking
    like content. Raising ToolError sets isError instead.
    """
    try:
        yield
    except APRAGError as exc:
        raise ToolError(f"{action} failed: {exc}") from exc


async def _progress(ctx: Context | None, done: float, total: float, msg: str) -> None:
    """Best-effort progress notification.

    Progress is cosmetic: the client may not have sent a progress token, and a
    non-MCP caller may have no request context at all. Neither is a reason to fail
    a query that otherwise succeeded, so every failure here is swallowed.
    """
    if ctx is None:
        return
    try:
        await ctx.report_progress(done, total, msg)
    except Exception:  # noqa: BLE001 — cosmetic only
        pass


# ── Filters ───────────────────────────────────────────────────────────────────

#: Filter dimensions that take a list of values (OR within the dimension) and the
#: /facets key that supplies "did you mean" suggestions for each.
_LIST_DIMS = ("authors", "journals", "subjects", "keywords", "affiliations", "types")
#: Single-valued dimensions; probed as a unit.
_SCALAR_DIMS = ("year", "year_from", "year_to", "date_from", "date_to")

#: Corpus-wide lookups, fetched at most once per process and only when needed —
#: /facets is ~1.5 MB and /papers_index ~1.3 MB on a 10k-paper corpus, so neither is
#: touched on the happy path (validation probes /papers instead, which is tiny).
_CACHE: dict[str, Any] = {"facets": None, "papers_index": None}


def _build_filters(authors=None, year=None, year_from=None, year_to=None, journals=None,
                   subjects=None, keywords=None, affiliations=None, date_from=None,
                   date_to=None, papers=None, types=None) -> dict:
    """Assemble the optional metadata filters into a dict (empty if none were given)."""
    candidate = {
        "papers": papers, "authors": authors, "journals": journals,
        "subjects": subjects, "keywords": keywords, "affiliations": affiliations,
        "types": types, "year": year, "year_from": year_from, "year_to": year_to,
        "date_from": date_from, "date_to": date_to,
    }
    return {k: v for k, v in candidate.items() if v not in (None, [], "")}


def _paper_stem(name: str) -> str:
    """Mirror the server's pin-matching key: basename, no .pdf, lowercased."""
    n = str(name or "").strip().lower().rsplit("/", 1)[-1]
    return n[:-4] if n.endswith(".pdf") else n


async def _facet_pool(dim: str) -> list[str]:
    """The distinct corpus values for one filter dimension (for suggestions)."""
    if _CACHE["facets"] is None:
        _CACHE["facets"] = await client.facets()
    pool = (_CACHE["facets"] or {}).get(dim) or []
    return [str(v) for v in pool]


def _suggest(value: Any, pool: list[str], n: int = 5) -> list[str]:
    """Closest corpus values to a rejected filter value: fuzzy first, substring second."""
    text = str(value)
    hits = difflib.get_close_matches(text, pool, n=n, cutoff=0.6)
    if not hits:
        low = text.lower()
        hits = [p for p in pool if low in p.lower()][:n]
    return hits


async def _count_matching(probe: dict) -> int:
    """How many papers match ``probe``, per the server's own filter semantics.

    Uses GET /papers, which is a pure manifest read applying the same
    ``record_matches`` as /query and /search — so this can never drift from what
    the real call will do, and it still answers when Qdrant is down.
    """
    payload = await client.list_papers(limit=1, filters=probe)
    return int(payload.get("total") or 0)


async def _pin_exists(pin: str) -> bool:
    """Is this pinned filename actually in the corpus? (404 = no, anything else raises.)"""
    name = pin if str(pin).lower().endswith(".pdf") else f"{pin}.pdf"
    try:
        await client.paper_detail(name)
        return True
    except APRAGError as exc:
        if exc.status == 404:
            return False
        raise


async def _reject(dim: str, value: Any) -> None:
    """Raise a ToolError naming the bad filter value and the nearest real ones."""
    if dim == "papers":
        if _CACHE["papers_index"] is None:
            _CACHE["papers_index"] = await client.papers_index()
        pool = [str(row[0]) for row in (_CACHE["papers_index"] or []) if row]
        hint = "aprag_papers"
    else:
        pool = await _facet_pool(dim)
        hint = f"aprag_corpus(facet='{dim}')"
    suggestions = _suggest(value, pool)
    detail = ("Did you mean: " + ", ".join(repr(s) for s in suggestions)
              if suggestions else f"Browse the real values with {hint}.")
    raise ToolError(
        f"No paper in the corpus matches {dim}={value!r}, so this call would search "
        f"nothing and wrongly look like an empty corpus. {detail}"
    )


async def _validate_filters(filters: dict) -> int | None:
    """Check every filter value against the corpus before spending a real query.

    Returns the number of papers the filter set selects (None when unfiltered).
    Raises ToolError when some value matches nothing, or when the values are each
    fine but their combination is empty — both are caller mistakes that would
    otherwise surface as a silent, misleading "no results".
    """
    if not filters:
        return None

    # Pins are exact filenames and are not a /papers query param, so check them
    # one by one; everything else is probed by value, all concurrently.
    pins = list(filters.get("papers") or [])
    probes: list[tuple[str, Any, dict]] = []
    for dim in _LIST_DIMS:
        for value in filters.get(dim) or []:
            probes.append((dim, value, {dim: [value]}))
    scalars = {d: filters[d] for d in _SCALAR_DIMS if d in filters}
    if scalars:
        probes.append(("__scalars__", scalars, dict(scalars)))

    combined = {k: v for k, v in filters.items() if k != "papers"}
    results = await asyncio.gather(
        *(_pin_exists(p) for p in pins),
        *(_count_matching(probe) for _, _, probe in probes),
        _count_matching(combined) if combined else _noop_none(),
    )
    pin_results = results[:len(pins)]
    probe_counts = results[len(pins):len(pins) + len(probes)]
    combined_total = results[-1]

    for pin, exists in zip(pins, pin_results):
        if not exists:
            await _reject("papers", pin)

    for (dim, value, _), count in zip(probes, probe_counts):
        if count == 0:
            if dim == "__scalars__":
                raise ToolError(
                    f"No paper in the corpus matches {value} — the date/year window is "
                    "empty, so this call would search nothing. Widen or drop it."
                )
            await _reject(dim, value)

    if combined and combined_total == 0:
        parts = ", ".join(f"{d}={filters[d]!r}" for d in filters if d != "papers")
        raise ToolError(
            f"Each filter value exists, but together they match no paper ({parts}). "
            "The combination is over-constrained — relax one dimension."
        )

    if pins and not combined:
        return len(pins)
    return combined_total


async def _noop_none() -> None:
    """Placeholder coroutine so the gather above keeps a fixed result shape."""
    return None


def _scope_note(matched: int | None) -> str:
    """One line describing how much of the corpus a filtered call was allowed to see."""
    if matched is None:
        return ""
    return f"Filter scope: {matched} paper(s) matched.\n\n"


# ── Formatters ────────────────────────────────────────────────────────────────


def _format_papers(result: dict) -> str:
    """Render ranked search papers, with a clickable local link where the PDF exists."""
    papers = result.get("papers") or []
    index = references.build_local_index()
    lines = [f"{len(papers)} paper(s) found:"]
    for i, p in enumerate(papers, 1):
        ref = {"filename": p.get("filename", ""), "drive_url": p.get("drive_url", ""),
               "hades_path": p.get("hades_path", "")}
        locator = references.locator_for(ref, index)
        pages = p.get("pages")
        head = f"\n[{i}] {p.get('apa', '')}"
        if pages:
            head += f" (pp. {', '.join(str(n) for n in pages)})"
        lines.append(head)
        lines.append(f"    {locator}  (relevance {p.get('score')})")
        snippet = (p.get("snippet") or "").strip()
        if snippet:
            lines.append(f"    {snippet}")
    return "\n".join(lines)


def _format_retrieval(result: dict) -> str:
    """Render structured retrieval as readable text for the orchestrating agent."""
    data = result.get("data") or {}
    meta = result.get("metadata") or {}
    chunks = data.get("chunks") or []
    entities = data.get("entities") or []
    relationships = data.get("relationships") or []

    lines: list[str] = [f"Retrieved {len(chunks)} chunk(s) in mode={meta.get('query_mode', '?')}."]

    # The server enriches references with the APA citation; label each chunk with it.
    refs_by_id = {str(r.get("reference_id")): r for r in (data.get("references") or [])}
    for i, ch in enumerate(chunks, 1):
        rm = refs_by_id.get(str(ch.get("reference_id") or ""))
        source = (rm.get("apa") if rm and rm.get("apa") else ch.get("file_path", "unknown"))
        page = ch.get("page")
        page_str = f" (p. {page})" if page is not None else ""
        lines.append(f"\n[chunk {i}]{page_str} {source}")
        lines.append((ch.get("content") or "").strip())

    if entities:
        lines.append(f"\n--- Entities ({len(entities)}) — follow these for the next hop ---")
        for e in entities:
            lines.append(
                f"- {e.get('entity_name', '?')} [{e.get('entity_type', '?')}]: "
                f"{(e.get('description') or '').strip()}"
            )

    if relationships:
        lines.append(f"\n--- Relationships ({len(relationships)}) ---")
        for r in relationships:
            lines.append(
                f"- {r.get('src_id', '?')} -> {r.get('tgt_id', '?')}: "
                f"{(r.get('description') or '').strip()}"
            )

    return "\n".join(lines)


def _format_paper_rows(rows: list[dict], total: int, offset: int) -> str:
    """Render a page of the manifest as a numbered citation list."""
    lines = [f"{total} paper(s) match; showing {len(rows)} from offset {offset}:"]
    for i, r in enumerate(rows, offset + 1):
        lines.append(f"\n[{i}] {r.get('apa') or r.get('title') or r.get('filename')}")
        lines.append(f"    filename: {r.get('filename', '')}")
    return "\n".join(lines)


def _require_success(result: dict, action: str) -> dict:
    """Raise unless the server reported success (it signals failure in-band)."""
    if result.get("status") not in (None, "success"):
        raise ToolError(f"{action} failed: {result.get('message') or result.get('status')}")
    return result


# ── Tools: retrieval and synthesis ────────────────────────────────────────────


@mcp.tool(annotations=READ_ONLY)
async def aprag_query(
    question: Annotated[str, Field(description="The research question.")],
    ctx: Context,
    mode: QueryMode = "hybrid",
    reasoning: Reasoning = "none",
    papers: Papers = None,
    authors: Authors = None,
    year: Year = None,
    year_from: YearFrom = None,
    year_to: YearTo = None,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    journals: Journals = None,
    subjects: Subjects = None,
    keywords: Keywords = None,
    affiliations: Affiliations = None,
    types: Types = None,
) -> CallToolResult:
    """
    Answer a research question from the AP-RAG knowledge base (synthesized answer).

    Returns a written answer with APA7 in-text citations and an APA7 references list;
    each reference links to a clickable local file:// path when the cited PDF is found
    on this machine (set $APRAG_PAPERS_DIR), otherwise it shows the hades fallback path.
    Use this when you want a finished answer rather than raw evidence.

    Optionally scope the answer to a subset of the corpus with the metadata filters
    (e.g. authors=["Westbury"], year_from=2015). A filter value that matches no paper
    is rejected with suggestions rather than silently answering from nothing. For
    iterative retrieval of raw passages use `aprag_retrieve`; to just find/list
    matching papers use `aprag_search`; to discover valid filter values use
    `aprag_corpus`.
    """
    filters = _build_filters(authors, year, year_from, year_to, journals, subjects,
                             keywords, affiliations, date_from, date_to, papers, types)
    matched = await _validate_filters(filters)
    await _progress(ctx, 0, 2, "retrieving")

    async with _api("Query"):
        payload = await client.query_full(question, mode=mode, reasoning=reasoning,
                                          filters=filters or None)
    await _progress(ctx, 1, 2, "synthesizing")

    answer = payload.get("answer", "No relevant information found.")
    refs = payload.get("references") or []
    if refs:
        answer = references.localize_answer(answer, refs)
    await _progress(ctx, 2, 2, "done")

    return _ok(
        _scope_note(matched) + answer,
        answer=answer,
        mode=payload.get("mode", mode),
        references=refs,
        matched_papers=matched,
    )


@mcp.tool(annotations=READ_ONLY)
async def aprag_search(
    question: Annotated[str, Field(description="The topic to rank papers by (semantic).")],
    papers: Papers = None,
    authors: Authors = None,
    year: Year = None,
    year_from: YearFrom = None,
    year_to: YearTo = None,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    journals: Journals = None,
    subjects: Subjects = None,
    keywords: Keywords = None,
    affiliations: Affiliations = None,
    types: Types = None,
    top_k: Annotated[int | None, Field(
        description="Chunks pulled before folding into papers (server default if omitted).",
    )] = None,
) -> CallToolResult:
    """
    Find papers by topic, filtered by metadata — a ranked list of papers (NOT an answer).

    Combines semantic relevance to `question` with hard metadata filters, e.g. "papers
    about meaning, only those authored by Westbury": question="meaning",
    authors=["Westbury"]. Each result is an APA7 citation with a clickable local PDF
    link (or the hades fallback path) and a short snippet. With no filters it ranks the
    whole corpus by relevance.

    A filter value that matches no paper is rejected with "did you mean" suggestions,
    so an empty result here means the corpus genuinely has nothing relevant. Use
    `aprag_corpus` to discover valid filter values.
    """
    filters = _build_filters(authors, year, year_from, year_to, journals, subjects,
                             keywords, affiliations, date_from, date_to, papers, types)
    matched = await _validate_filters(filters)

    async with _api("Search"):
        result = await client.search(question, filters=filters or None, top_k=top_k)
    _require_success(result, "Search")

    return _ok(
        _scope_note(matched) + _format_papers(result),
        papers=result.get("papers") or [],
        count=result.get("count") or 0,
        matched_papers=matched,
    )


@mcp.tool(annotations=READ_ONLY)
async def aprag_retrieve(
    question: Annotated[str, Field(description="The retrieval query for this hop.")],
    ctx: Context,
    mode: RetrieveMode = "naive",
    top_k: Annotated[int | None, Field(
        description="KG entities/relations to retrieve (server default if omitted).",
    )] = None,
    chunk_top_k: Annotated[int | None, Field(
        description="Text chunks to keep after reranking (server default if omitted).",
    )] = None,
    papers: Papers = None,
    authors: Authors = None,
    year: Year = None,
    year_from: YearFrom = None,
    year_to: YearTo = None,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    journals: Journals = None,
    subjects: Subjects = None,
    keywords: Keywords = None,
    affiliations: Affiliations = None,
    types: Types = None,
) -> CallToolResult:
    """
    Retrieve raw evidence from the AP-RAG knowledge base — NO answer synthesis.

    Returns the underlying text chunks (and, in graph modes, the entities and
    relationships) that retrieval surfaced. This is the primitive for agentic
    multi-hop retrieval: read the chunks, pick a lead from the chunks/entities, then
    call again with a refined question and/or a different mode. Follow an entity into
    its full card with `aprag_graph`.

    Calls are stateless — each call retrieves independently. YOU accumulate and
    deduplicate evidence across hops; the server does not remember prior calls.

    Pass any metadata filter to scope retrieval to a paper subset (filtered mode
    returns chunks only, ranked by semantic relevance).
    """
    filters = _build_filters(authors, year, year_from, year_to, journals, subjects,
                             keywords, affiliations, date_from, date_to, papers, types)
    matched = await _validate_filters(filters)
    await _progress(ctx, 0, 1, f"retrieving (mode={mode})")

    async with _api("Retrieval"):
        result = await client.retrieve(question, mode=mode, top_k=top_k,
                                       chunk_top_k=chunk_top_k, filters=filters or None)
    _require_success(result, "Retrieval")
    await _progress(ctx, 1, 1, "done")

    data = result.get("data") or {}
    return _ok(
        _scope_note(matched) + _format_retrieval(result),
        chunks=data.get("chunks") or [],
        entities=data.get("entities") or [],
        relationships=data.get("relationships") or [],
        references=data.get("references") or [],
        metadata=result.get("metadata") or {},
        matched_papers=matched,
    )


# ── Tools: discovery ──────────────────────────────────────────────────────────


@mcp.tool(annotations=READ_ONLY)
async def aprag_corpus(
    facet: Annotated[
        Literal["authors", "journals", "subjects", "keywords", "affiliations",
                "types", "stats", "health"],
        Field(description=(
            "Which dimension to inspect. The first six list the values the matching "
            "metadata filter accepts; 'stats' gives the corpus size; 'health' reports "
            "server and dependency status."
        )),
    ],
    q: Annotated[str | None, Field(
        description="Substring/prefix to narrow the list. Strongly recommended.",
    )] = None,
    limit: Annotated[int, Field(ge=1, le=200, description="Maximum values to return.")] = 25,
) -> CallToolResult:
    """
    Discover what the metadata filters actually accept — the antidote to guessing.

    Every filter on `aprag_query`/`aprag_search`/`aprag_retrieve` matches against real
    corpus values, so a misspelled author or an invented journal name selects nothing.
    Call this first to get the exact strings to pass.

    `facet="authors"` resolves people rather than bare surnames: each row carries the
    `name` to send back ("Zhang, Kechen") plus the papers/years/venue that
    disambiguate it from other authors with the same surname.

    Also serves `facet="stats"` (how many papers are indexed) and `facet="health"`
    (whether retrieval is actually ready — check this when queries fail).
    """
    if facet == "stats":
        async with _api("Corpus stats"):
            payload = await client.stats()
        return _ok(f"Corpus: {payload.get('papers', 0)} paper(s) indexed.", **payload)

    if facet == "health":
        async with _api("Health check"):
            payload = await client.health()
        ready = payload.get("retrieval_ready")
        lines = [f"retrieval_ready: {ready}"]
        for key in ("status", "qdrant", "embedding", "llm", "page_aware",
                    "manifest_papers", "pdf_serving"):
            if key in payload:
                lines.append(f"{key}: {payload[key]}")
        return _ok("\n".join(lines), **payload)

    if facet == "authors":
        async with _api("Author lookup"):
            payload = await client.author_suggestions(q=q, limit=limit)
        rows = payload.get("authors") or []
        lines = [f"{len(rows)} author(s) (of {payload.get('total', len(rows))} matching):"]
        for r in rows:
            bits = [f"{r.get('n_papers', 0)} papers"]
            if r.get("years"):
                bits.append(str(r["years"]))
            if r.get("journal"):
                bits.append(str(r["journal"]))
            lines.append(f"  {r.get('name', '?')}  ({'; '.join(bits)})")
        lines.append("\nPass a `name` above as authors=[...] to filter by that person.")
        return _ok("\n".join(lines), authors=rows, total=payload.get("total", len(rows)))

    pool = await _facet_pool(facet)
    if q:
        low = q.lower()
        hits = [v for v in pool if low in v.lower()]
        hits.sort(key=lambda v: (not v.lower().startswith(low), len(v), v.lower()))
    else:
        hits = sorted(pool, key=str.lower)
    shown = hits[:limit]
    lines = [f"{len(hits)} {facet} value(s) match" + (f" {q!r}" if q else "")
             + f"; showing {len(shown)}:"]
    lines += [f"  {v}" for v in shown]
    if len(hits) > len(shown):
        lines.append(f"  … {len(hits) - len(shown)} more (narrow with `q` or raise `limit`)")
    return _ok("\n".join(lines), facet=facet, values=shown, total=len(hits))


@mcp.tool(annotations=READ_ONLY)
async def aprag_papers(
    filename: Annotated[str | None, Field(description=(
        "Return one paper's full record (abstract, affiliations, provenance) instead "
        "of a list. '.pdf' optional."
    ))] = None,
    q: Annotated[str | None, Field(
        description="Quick text match over title/filename.",
    )] = None,
    sort: Annotated[Literal["year", "title", "author", "journal", "filename"], Field(
        description="Sort key for the listing.",
    )] = "year",
    order: Annotated[Literal["desc", "asc"], Field(description="Sort direction.")] = "desc",
    offset: Annotated[int, Field(ge=0, description="Row offset for pagination.")] = 0,
    limit: Annotated[int, Field(ge=1, le=200, description="Rows per page.")] = 25,
    authors: Authors = None,
    year: Year = None,
    year_from: YearFrom = None,
    year_to: YearTo = None,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    journals: Journals = None,
    subjects: Subjects = None,
    keywords: Keywords = None,
    affiliations: Affiliations = None,
    types: Types = None,
) -> CallToolResult:
    """
    Browse the corpus as a table, or open one paper's full record.

    Unlike `aprag_search` this is a pure metadata read with no semantic ranking — use
    it to answer "what does the corpus hold?" questions ("every 2024 paper in this
    journal", "how many papers by this author"), to page through results, or to fetch
    a single paper's abstract and provenance by filename.

    It also keeps working when the vector store or embedding service is down, which
    makes it a useful fallback when the retrieval tools are failing.
    """
    if filename:
        name = filename if filename.lower().endswith(".pdf") else f"{filename}.pdf"
        try:
            async with _api("Paper lookup"):
                record = await client.paper_detail(name)
        except ToolError:
            if _CACHE["papers_index"] is None:
                _CACHE["papers_index"] = await client.papers_index()
            pool = [str(row[0]) for row in (_CACHE["papers_index"] or []) if row]
            suggestions = _suggest(name, pool)
            hint = (" Did you mean: " + ", ".join(repr(s) for s in suggestions)
                    if suggestions else "")
            raise ToolError(f"No paper named {name!r} in the corpus.{hint}") from None
        lines = [record.get("apa") or name, ""]
        for key in ("filename", "type", "container_title", "doi", "subjects",
                    "keywords", "affiliations"):
            if record.get(key):
                lines.append(f"{key}: {record[key]}")
        if record.get("abstract"):
            lines += ["", "Abstract:", str(record["abstract"]).strip()]
        return _ok("\n".join(lines), **{"paper": record})

    filters = _build_filters(authors, year, year_from, year_to, journals, subjects,
                             keywords, affiliations, date_from, date_to, None, types)
    await _validate_filters(filters)
    async with _api("Paper listing"):
        payload = await client.list_papers(q=q, sort=sort, order=order, offset=offset,
                                           limit=limit, filters=filters)
    rows = payload.get("papers") or []
    return _ok(
        _format_paper_rows(rows, int(payload.get("total") or 0), offset),
        papers=rows,
        total=payload.get("total") or 0,
        offset=offset,
        limit=limit,
    )


# ── Tools: exploration ────────────────────────────────────────────────────────


@mcp.tool(annotations=READ_ONLY)
async def aprag_similar(
    filename: Annotated[str, Field(description=(
        "The paper to find neighbours for, by filename ('.pdf' optional)."
    ))],
    ctx: Context,
    top_k: Annotated[int, Field(ge=1, le=50, description="Papers to return.")] = 12,
) -> CallToolResult:
    """
    Find the papers most similar to one paper — "more like this".

    Ranks the corpus against the paper's mean chunk vector (its own chunks excluded),
    so it surfaces neighbours by overall content rather than by a query you have to
    phrase. Use it to expand a reading list from a known-good starting paper, or to
    find the prior work a paper sits closest to.
    """
    name = filename if filename.lower().endswith(".pdf") else f"{filename}.pdf"
    if not await _pin_exists(name):
        await _reject("papers", name)
    await _progress(ctx, 0, 1, "scanning corpus")

    async with _api("Similarity search"):
        result = await client.similar(name, top_k=top_k)
    _require_success(result, "Similarity search")
    await _progress(ctx, 1, 1, "done")

    return _ok(
        f"Papers most similar to {name}:\n" + _format_papers(result),
        papers=result.get("papers") or [],
        count=result.get("count") or 0,
        source=result.get("filename", name),
    )


@mcp.tool(annotations=READ_ONLY)
async def aprag_locate(
    filename: Annotated[str, Field(description="The paper to search, by filename.")],
    quote: Annotated[str, Field(description=(
        "The passage to locate. Use the exact wording from the source; a short "
        "distinctive phrase works better than a long paragraph."
    ))],
    ctx: Context,
    hint_page: Annotated[int | None, Field(
        ge=1, description="Page to try first, when you already have a guess.",
    )] = None,
) -> CallToolResult:
    """
    Find which page of a paper a quoted passage actually appears on.

    This is the verification primitive for citation checking: given a quote you are
    about to attribute to a paper, it confirms the passage is really in that PDF and
    tells you the page to cite. A miss returns page=null — which is evidence the
    quote may be paraphrased, altered, or from a different paper, not a tool error.

    Scanned or image-only pages can also defeat text extraction, so treat a miss as
    "unconfirmed" rather than "fabricated".
    """
    name = filename if filename.lower().endswith(".pdf") else f"{filename}.pdf"
    await _progress(ctx, 0, 1, "scanning PDF")
    async with _api("Quote location"):
        found = await client.pdf_locate(name, quote, hint_page)
    await _progress(ctx, 1, 1, "done")

    page = found.get("page")
    if page is None:
        text = (f"NOT FOUND in {name}. The passage could not be located — it may be "
                "paraphrased rather than quoted, may come from a different paper, or "
                "the page may be scanned image-only.")
    else:
        text = f"Found on page {page} of {name}."
    return _ok(text, filename=name, page=page,
               rects=found.get("rects") or [], cached=found.get("cached", False))


@mcp.tool(annotations=READ_ONLY)
async def aprag_graph(
    action: Annotated[Literal["overview", "search", "entity"], Field(description=(
        "'overview' = graph size and top entity types; 'search' = find entities by "
        "name/type/paper; 'entity' = one entity's full card."
    ))] = "search",
    q: Annotated[str | None, Field(
        description="For 'search': entity-name substring.",
    )] = None,
    name: Annotated[str | None, Field(
        description="For 'entity': the exact entity name (from a 'search' result).",
    )] = None,
    entity_type: Annotated[str | None, Field(
        description="For 'search': restrict to this exact entity type.",
    )] = None,
    file: Annotated[str | None, Field(
        description="For 'search': only entities extracted from this paper.",
    )] = None,
    limit: Annotated[int, Field(ge=1, le=200, description="Maximum entities.")] = 25,
) -> CallToolResult:
    """
    Explore the knowledge graph built over the corpus.

    `aprag_retrieve` surfaces entities and tells you to follow them for the next hop;
    this is how you follow them. `action="entity"` returns an entity's consolidated
    description, its strongest connections, and the papers it was extracted from —
    turning a name that appeared in a chunk into a set of papers to read.

    `action="search"` with `file=` answers "what concepts does this paper cover?".
    """
    if action == "overview":
        async with _api("Graph overview"):
            payload = await client.graph_overview()
        lines = [f"{k}: {v}" for k, v in payload.items() if not isinstance(v, (list, dict))]
        for key in ("types", "entity_types", "top_types"):
            if isinstance(payload.get(key), list):
                lines.append(f"\n{key}:")
                lines += [f"  {t}" for t in payload[key][:limit]]
        return _ok("\n".join(lines) or "No graph data.", **payload)

    if action == "entity":
        if not name:
            raise ToolError("aprag_graph(action='entity') requires `name` — get one "
                            "from action='search' or from an aprag_retrieve result.")
        async with _api("Entity lookup"):
            payload = await client.graph_entity(name)
        lines = [f"{payload.get('id') or name} [{payload.get('type', '?')}]", ""]
        if payload.get("description"):
            lines.append(str(payload["description"]).strip())
        for key, label in (("connections", "Connections"), ("papers", "Papers")):
            items = payload.get(key) or []
            if items:
                lines.append(f"\n--- {label} ({len(items)}) ---")
                for it in items[:limit]:
                    if isinstance(it, dict):
                        lines.append(f"  {it.get('apa') or it.get('name') or it.get('id') or it}")
                    else:
                        lines.append(f"  {it}")
        return _ok("\n".join(lines), **payload)

    async with _api("Entity search"):
        payload = await client.graph_entities(q=q, entity_type=entity_type, file=file,
                                              limit=limit)
    entities = payload.get("entities") or []
    lines = [f"{len(entities)} entit(ies) (of {payload.get('total', len(entities))}):"]
    for e in entities:
        lines.append(f"  {e.get('name') or e.get('entity_id') or '?'} "
                     f"[{e.get('type') or e.get('entity_type') or '?'}]")
    lines.append("\nOpen one with aprag_graph(action='entity', name=...).")
    return _ok("\n".join(lines), entities=entities,
               total=payload.get("total", len(entities)))


@mcp.tool(annotations=READ_ONLY)
async def aprag_trends(
    dim: Annotated[str | None, Field(description=(
        "With `term`: the facet dimension to detail (e.g. 'keywords', 'subjects', "
        "'journals', 'authors'). Omit both for the corpus-wide overview."
    ))] = None,
    term: Annotated[str | None, Field(
        description="With `dim`: the specific term to explain.",
    )] = None,
    limit: Annotated[int, Field(ge=1, le=100, description="Rows per section.")] = 15,
) -> CallToolResult:
    """
    Corpus-wide publication trends: what is rising, fading, new, or bursting.

    With no arguments, returns the overview — papers per year plus the ranked
    movers across the facet dimensions. With `dim` and `term`, explains one term:
    what it co-occurs with, who published it in each period, and where.

    Note this describes *this corpus*, which reflects what has been collected, not
    the literature as a whole — treat it as a map of the library, not of the field.
    """
    if bool(dim) != bool(term):
        raise ToolError("aprag_trends needs both `dim` and `term` for a detail view, "
                        "or neither for the overview.")

    if dim and term:
        async with _api("Trend detail"):
            payload = await client.trend_detail(dim, term)
        lines = [f"Trend detail for {dim}={term!r}", ""]
        for key, value in payload.items():
            if isinstance(value, list):
                lines.append(f"--- {key} ({len(value)}) ---")
                for item in value[:limit]:
                    lines.append(f"  {item}")
                lines.append("")
            elif not isinstance(value, dict):
                lines.append(f"{key}: {value}")
        return _ok("\n".join(lines), **payload)

    async with _api("Trends"):
        payload = await client.trends()
    lines = ["Corpus publication trends:", ""]
    for key, value in payload.items():
        if isinstance(value, list) and value:
            lines.append(f"--- {key} ({len(value)}) ---")
            for item in value[:limit]:
                lines.append(f"  {item}")
            lines.append("")
        elif isinstance(value, dict) and value:
            lines.append(f"--- {key} ---")
            for k, v in list(value.items())[:limit]:
                lines.append(f"  {k}: {v}")
            lines.append("")
    lines.append("Explain one term with aprag_trends(dim=..., term=...).")
    return _ok("\n".join(lines), **payload)


def main() -> None:
    """Console-script entry point (`aprag-mcp`)."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
