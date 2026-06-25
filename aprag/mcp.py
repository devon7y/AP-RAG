#!/usr/bin/env python3
"""
aprag.mcp — MCP server for the AP-RAG academic-papers knowledge base.

Thin stdio MCP server that forwards to the AP-RAG query server (LightRAG + Qdrant +
embeddings + an answer LLM). Holds no models and no data; it just shapes two tools
over `aprag.client`.

Server selection: $APRAG_QUERY_URL (default http://localhost:8001). Point it at your
deployment, e.g. register with `--env APRAG_QUERY_URL=http://<host>:8001`.

Register (after `pip install .` puts `aprag-mcp` on PATH):
    claude mcp add --scope user aprag \\
        --env APRAG_QUERY_URL=http://<host>:8001 -- aprag-mcp
"""

from __future__ import annotations

import logging
import sys

# All diagnostics go to stderr; stdout is reserved for JSON-RPC on a stdio server.
# basicConfig must run before importing mcp so any import-time logs land on stderr.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

from mcp.server.fastmcp import FastMCP  # noqa: E402

from . import client, references  # noqa: E402
from .client import APRAGError  # noqa: E402

mcp = FastMCP("aprag")


def _build_filters(authors, year, year_from, year_to, journals, subjects,
                   keywords, affiliations) -> dict | None:
    """Assemble the optional metadata filters into a dict (None if all empty)."""
    f: dict = {}
    if authors:
        f["authors"] = authors
    if journals:
        f["journals"] = journals
    if subjects:
        f["subjects"] = subjects
    if keywords:
        f["keywords"] = keywords
    if affiliations:
        f["affiliations"] = affiliations
    if year is not None:
        f["year"] = year
    if year_from is not None:
        f["year_from"] = year_from
    if year_to is not None:
        f["year_to"] = year_to
    return f or None


def _format_papers(result: dict) -> str:
    """Render ranked search papers, with a clickable local link where the PDF exists."""
    if result.get("status") != "success":
        return f"Search failed: {result.get('message', 'no data returned')}"
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
    if result.get("status") != "success":
        return (
            f"No results (status={result.get('status')}): "
            f"{result.get('message', 'no data returned')}"
        )

    data = result.get("data") or {}
    meta = result.get("metadata") or {}
    chunks = data.get("chunks") or []
    entities = data.get("entities") or []
    relationships = data.get("relationships") or []

    lines: list[str] = [f"Retrieved {len(chunks)} chunk(s) in mode={meta.get('query_mode', '?')}."]

    for i, ch in enumerate(chunks, 1):
        lines.append(
            f"\n[chunk {i}] ref={ch.get('reference_id', '?')} "
            f"source={ch.get('file_path', 'unknown')}"
        )
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


@mcp.tool()
async def aprag_query(
    question: str,
    mode: str = "hybrid",
    reasoning: str = "minimal",
    authors: list[str] | None = None,
    year: int | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    journals: list[str] | None = None,
    subjects: list[str] | None = None,
    keywords: list[str] | None = None,
    affiliations: list[str] | None = None,
) -> str:
    """
    Answer a research question from the AP-RAG knowledge base (synthesized answer).

    Returns a written answer with APA7 in-text citations and an APA7 references list;
    each reference links to a clickable local file:// path when the cited PDF is found
    on this machine (set $APRAG_PAPERS_DIR), otherwise it shows the hades fallback path.
    Use this when you want a finished answer rather than raw evidence.

    Optionally scope the answer to a subset of the corpus with the metadata filters
    (e.g. authors=["Westbury"], year_from=2015) — useful for "answer X using only papers
    by Y". For iterative retrieval of raw passages use `aprag_retrieve`; to just find/list
    matching papers use `aprag_search`.

    Args:
        question: The research question.
        mode: Retrieval strategy — "hybrid" (default), "local", "global", "mix", "naive".
        reasoning: answer LLM effort — "minimal" (default, fastest), "low", "medium", or
            "high". Higher is slower but more careful; raise it only for hard questions.
        authors: restrict to these author surnames.
        year / year_from / year_to: restrict by publication year (exact or range).
        journals: restrict to these journals/venues (substring).
        subjects: restrict to these subject/field labels.
        keywords: restrict to papers carrying these keywords.
        affiliations: restrict to these institutions (substring).
    """
    filters = _build_filters(authors, year, year_from, year_to, journals,
                             subjects, keywords, affiliations)
    try:
        payload = await client.query_full(question, mode=mode, reasoning=reasoning, filters=filters)
    except APRAGError as exc:
        return f"Query failed: {exc}"
    answer = payload.get("answer", "No relevant information found.")
    refs = payload.get("references") or []
    if refs:
        answer = references.localize_answer(answer, refs)
    return answer


@mcp.tool()
async def aprag_search(
    question: str,
    authors: list[str] | None = None,
    year: int | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    journals: list[str] | None = None,
    subjects: list[str] | None = None,
    keywords: list[str] | None = None,
    affiliations: list[str] | None = None,
    top_k: int | None = None,
) -> str:
    """
    Find papers by topic, filtered by metadata — a ranked list of papers (NOT an answer).

    Combines semantic relevance to `question` with hard metadata filters, e.g. "papers
    about meaning, only those authored by Westbury": question="meaning",
    authors=["Westbury"]. Each result is an APA7 citation with a clickable local PDF
    link (or the hades fallback path) and a short snippet. With no filters it ranks the
    whole corpus by relevance.

    Args:
        question: The topic to rank papers by (semantic).
        authors: restrict to these author surnames.
        year / year_from / year_to: restrict by publication year (exact or range).
        journals: restrict to these journals/venues (substring).
        subjects: restrict to these subject/field labels.
        keywords: restrict to papers carrying these keywords.
        affiliations: restrict to these institutions (substring).
        top_k: chunks pulled before folding into papers (server default if omitted).
    """
    filters = _build_filters(authors, year, year_from, year_to, journals,
                             subjects, keywords, affiliations)
    try:
        result = await client.search(question, filters=filters, top_k=top_k)
    except APRAGError as exc:
        return f"Search failed: {exc}"
    return _format_papers(result)


@mcp.tool()
async def aprag_retrieve(
    question: str,
    mode: str = "naive",
    top_k: int | None = None,
    chunk_top_k: int | None = None,
    authors: list[str] | None = None,
    year: int | None = None,
    year_from: int | None = None,
    year_to: int | None = None,
    journals: list[str] | None = None,
    subjects: list[str] | None = None,
    keywords: list[str] | None = None,
    affiliations: list[str] | None = None,
) -> str:
    """
    Retrieve raw evidence from the AP-RAG knowledge base — NO answer synthesis.

    Returns the underlying text chunks (and, in graph modes, the entities and
    relationships) that retrieval surfaced. This is the primitive for agentic
    multi-hop retrieval: read the chunks, pick a lead from the chunks/entities, then
    call again with a refined question and/or a different mode.

    Calls are stateless — each call retrieves independently. YOU accumulate and
    deduplicate evidence across hops; the server does not remember prior calls.

    Pass any metadata filter (authors/year/journals/...) to scope retrieval to a paper
    subset (filtered mode returns chunks only, ranked by semantic relevance).

    Args:
        question: The retrieval query for this hop.
        mode: Retrieval strategy —
            "naive" (default): plain vector search; returns chunks only (no graph).
            "local": entities + their chunks (specific entity/paper leads).
            "global": relationships + connected entities (broad themes).
            "hybrid"/"mix": combined graph + vector retrieval.
        top_k: KG entities/relations to retrieve (server default if omitted).
        chunk_top_k: text chunks to keep after reranking (server default if omitted).
        authors, year, year_from, year_to, journals, subjects, keywords, affiliations:
            optional metadata filters (see aprag_search).
    """
    filters = _build_filters(authors, year, year_from, year_to, journals,
                             subjects, keywords, affiliations)
    try:
        result = await client.retrieve(
            question, mode=mode, top_k=top_k, chunk_top_k=chunk_top_k, filters=filters
        )
        return _format_retrieval(result)
    except APRAGError as exc:
        return f"Retrieval failed: {exc}"


def main() -> None:
    """Console-script entry point (`aprag-mcp`)."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
