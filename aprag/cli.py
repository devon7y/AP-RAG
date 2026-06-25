"""
aprag.cli — command-line client for the AP-RAG knowledge base.

    aprag ask    "<question>" [--mode hybrid]   # synthesized answer (LLM)
    aprag chunks "<question>" [--mode naive]    # raw retrieved chunks (no LLM)
    aprag health                                 # server liveness + capabilities

Server selection (precedence): --server URL > --local > $APRAG_QUERY_URL > localhost:8001.
Add --json to any command for machine-readable output (pipe to jq).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

from . import __version__, client, references
from .client import VALID_MODES, APRAGError


# ── Metadata filters ─────────────────────────────────────────────────────────


def _filters_from_args(args: argparse.Namespace) -> dict | None:
    """Collect the --author/--year/--journal/... flags into a filter dict (or None)."""
    f: dict = {}
    if getattr(args, "author", None):
        f["authors"] = args.author
    if getattr(args, "journal", None):
        f["journals"] = args.journal
    if getattr(args, "subject", None):
        f["subjects"] = args.subject
    if getattr(args, "keyword", None):
        f["keywords"] = args.keyword
    if getattr(args, "affiliation", None):
        f["affiliations"] = args.affiliation
    if getattr(args, "year", None) is not None:
        f["year"] = args.year
    if getattr(args, "year_from", None) is not None:
        f["year_from"] = args.year_from
    if getattr(args, "year_to", None) is not None:
        f["year_to"] = args.year_to
    return f or None


# ── Output formatting ────────────────────────────────────────────────────────


def _format_papers(result: dict, index: dict | None) -> str:
    if result.get("status") != "success":
        return f"Search failed: {result.get('message', 'no data returned')}"
    papers = result.get("papers") or []
    matched = result.get("matched_files")
    header = f"=== {len(papers)} paper(s)"
    if matched is not None:
        header += f"  (from {matched} filter-matched file(s))"
    header += " ==="
    out = [header]
    for i, p in enumerate(papers, 1):
        out.append(f"\n[{i}] {p.get('apa', '')}  (score {p.get('score')})")
        ref = {"filename": p.get("filename", ""), "drive_url": p.get("drive_url", ""),
               "hades_path": p.get("hades_path", "")}
        locator = (references.locator_for(ref, index) if index is not None
                   else (p.get("drive_url") or p.get("hades_path", "")))
        pages = p.get("pages")
        line = f"    {locator}"
        if pages:
            line += f"  (pp. {', '.join(str(n) for n in pages)})"
        out.append(line)
        snippet = (p.get("snippet") or "").strip()
        if snippet:
            out.append(f"    {snippet}")
    return "\n".join(out)


def _format_chunks(result: dict, show_entities: bool, index: dict | None = None) -> str:
    """Render retrieved chunks as readable markdown: a bold header per chunk with the
    full APA citation + an 'open PDF' link (the server enriches /retrieve references),
    then the chunk text. ``index`` is the local-PDF index for file:// links."""
    data = result.get("data") or {}
    chunks = data.get("chunks") or []
    meta = result.get("metadata") or {}
    mode = meta.get("query_mode", "?")

    if result.get("status") != "success":
        msg = result.get("message", "no data returned")
        return f"No results (status={result.get('status')}, mode={mode}): {msg}"

    refs_by_id = {str(r.get("reference_id")): r for r in (data.get("references") or [])}
    out: list[str] = [f"## {len(chunks)} chunk(s) — mode `{mode}`", ""]
    for i, ch in enumerate(chunks, 1):
        rm = refs_by_id.get(str(ch.get("reference_id") or ""))
        if rm and rm.get("apa"):
            label = rm["apa"]
            locator = references.locator_for(rm, index or {})
        else:  # older server / no manifest entry → fall back to the filename
            label = ch.get("file_path", "unknown source")
            locator = ""
        header = f"**Chunk {i}: {label}" + (f" — {locator}" if locator else "") + "**"
        out.extend([header, "", (ch.get("content") or "").strip(), ""])

    if show_entities:
        entities = data.get("entities") or []
        relationships = data.get("relationships") or []
        out.append(f"## Entities ({len(entities)})")
        out.append("")
        for e in entities:
            out.append(
                f"- **{e.get('entity_name', '?')}** "
                f"[{e.get('entity_type', '?')}]: {(e.get('description') or '').strip()}"
            )
        out.append("")
        out.append(f"## Relationships ({len(relationships)})")
        out.append("")
        for r in relationships:
            out.append(
                f"- **{r.get('src_id', '?')} → {r.get('tgt_id', '?')}**: "
                f"{(r.get('description') or '').strip()}"
            )

    return "\n".join(out)


# ── Command handlers ─────────────────────────────────────────────────────────


def _allow_file_links() -> None:
    """markdown-it (rich's markdown parser) rejects ``file://`` URLs by default for
    safety, so the reference "open PDF" links render as raw ``[open PDF](file://…)``
    text. Relax ``validateLink`` to also accept ``file://`` (still blocking
    javascript:/data:) — the CLI only renders our own trusted server output, and
    clickable local PDFs are the whole point."""
    from markdown_it import MarkdownIt
    if getattr(MarkdownIt, "_aprag_file_links", False):
        return
    _orig = MarkdownIt.validateLink
    MarkdownIt.validateLink = lambda self, url: url.lower().lstrip().startswith("file:") or _orig(self, url)
    MarkdownIt._aprag_file_links = True


def _print_answer(text: str, plain: bool = False) -> None:
    """Render the markdown answer for the terminal with ``rich`` when interactive;
    otherwise print it raw (piped output, ``--plain``, or ``rich`` not installed).
    ``rich`` emits OSC-8 hyperlinks, so the reference ``file://`` links stay clickable
    in iTerm2."""
    if not plain and sys.stdout.isatty():
        try:
            from rich.console import Console
            from rich.markdown import Markdown
            from rich.theme import Theme

            _allow_file_links()
            # rich's default link style is a dim "underline blue" (markdown.link_url),
            # hard to read on dark backgrounds. Use a brighter default and let the user
            # retune it without editing code via APRAG_LINK_STYLE — any rich style
            # string, e.g. "bold magenta", "green underline", "#ffaa00 underline".
            link_style = os.environ.get("APRAG_LINK_STYLE", "bold bright_cyan underline")
            theme = Theme({"markdown.link": link_style, "markdown.link_url": link_style})
            Console(theme=theme).print(Markdown(text))
            return
        except Exception:
            pass
    print(text)


async def _cmd_ask(args: argparse.Namespace) -> int:
    base_url = client.resolve_base_url(args.server, args.local)
    payload = await client.query_full(
        args.question,
        mode=args.mode,
        base_url=base_url,
        top_k=args.top_k,
        chunk_top_k=args.chunk_top_k,
        user_prompt=args.user_prompt,
        reasoning=args.reasoning,
        filters=_filters_from_args(args),
    )
    answer = payload.get("answer", "No relevant information found.")
    refs = payload.get("references") or []
    # Rewrite the references to clickable local file:// links where the PDF is on
    # this machine (the server only knows the hades fallback path).
    if refs and not args.no_local:
        extra = [args.papers_dir] if args.papers_dir else None
        answer = references.localize_answer(answer, refs, references.build_local_index(extra))
    if args.json:
        print(json.dumps({"answer": answer, "references": refs, "mode": args.mode}, indent=2))
    else:
        _print_answer(answer, getattr(args, "plain", False))
    return 0


async def _cmd_chunks(args: argparse.Namespace) -> int:
    base_url = client.resolve_base_url(args.server, args.local)
    result = await client.retrieve(
        args.question,
        mode=args.mode,
        base_url=base_url,
        top_k=args.top_k,
        chunk_top_k=args.chunk_top_k,
        filters=_filters_from_args(args),
    )
    index = {}
    if not getattr(args, "no_local", False):
        extra = [args.papers_dir] if getattr(args, "papers_dir", None) else None
        index = references.build_local_index(extra)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        _print_answer(_format_chunks(result, args.entities, index), getattr(args, "plain", False))
    return 0


async def _cmd_search(args: argparse.Namespace) -> int:
    base_url = client.resolve_base_url(args.server, args.local)
    result = await client.search(
        args.question,
        base_url=base_url,
        top_k=args.top_k,
        filters=_filters_from_args(args),
    )
    index = None
    if not args.no_local:
        extra = [args.papers_dir] if args.papers_dir else None
        index = references.build_local_index(extra)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(_format_papers(result, index))
    return 0


async def _cmd_health(args: argparse.Namespace) -> int:
    base_url = client.resolve_base_url(args.server, args.local)
    result = await client.health(base_url=base_url)
    print(json.dumps(result, indent=2))
    return 0


async def _cmd_config(args: argparse.Namespace) -> int:
    if args.config_cmd == "set-server":
        path = client.write_config_url(args.url)
        print(f"Saved default server {args.url.rstrip('/')} -> {path}")
        return 0
    # show: resolved value + every source so the precedence is obvious
    env = os.environ.get("APRAG_QUERY_URL")
    cfg = client.read_config_url()
    print(f"resolved server   : {client.resolve_base_url(args.server, args.local)}")
    print(f"  --server        : {args.server or '(unset)'}")
    print(f"  $APRAG_QUERY_URL : {env or '(unset)'}")
    print(f"  config file      : {cfg or '(unset)'}  [{client.CONFIG_PATH}]")
    print(f"  default          : {client.DEFAULT_BASE_URL}")
    return 0


# ── Argument parsing ─────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    # Shared flags, accepted either before OR after the subcommand. SUPPRESS keeps an
    # unset flag out of the namespace so the subparser copy never clobbers a value
    # already set at the top level (the classic argparse parent/subparser footgun).
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--server", metavar="URL", default=argparse.SUPPRESS,
        help="Query server base URL (overrides env/--local).",
    )
    common.add_argument(
        "--local", action="store_true", default=argparse.SUPPRESS,
        help="Talk to a server on localhost:8001.",
    )
    common.add_argument(
        "--json", action="store_true", default=argparse.SUPPRESS,
        help="Emit machine-readable JSON.",
    )

    # Metadata filters — shared by ask/chunks/search (scope retrieval to a paper set).
    filt = argparse.ArgumentParser(add_help=False)
    filt.add_argument("--author", action="append", metavar="SURNAME",
                      help="Only papers by this author surname (repeatable).")
    filt.add_argument("--journal", action="append", metavar="NAME",
                      help="Only papers in this journal/venue (substring; repeatable).")
    filt.add_argument("--subject", action="append", metavar="FIELD",
                      help="Only papers in this subject/field (repeatable).")
    filt.add_argument("--keyword", action="append", metavar="KW",
                      help="Only papers with this keyword (repeatable).")
    filt.add_argument("--affiliation", action="append", metavar="ORG",
                      help="Only papers from this institution (substring; repeatable).")
    filt.add_argument("--year", type=int, default=None, help="Only papers from this year.")
    filt.add_argument("--year-from", type=int, default=None, dest="year_from",
                      help="Only papers from this year onward.")
    filt.add_argument("--year-to", type=int, default=None, dest="year_to",
                      help="Only papers up to this year.")

    # Local-PDF resolution flags — shared by ask/search.
    localopt = argparse.ArgumentParser(add_help=False)
    localopt.add_argument(
        "--papers-dir", default=None,
        help="Local directory to search for cited PDFs (adds to $APRAG_PAPERS_DIR).",
    )
    localopt.add_argument(
        "--no-local", action="store_true",
        help="Don't resolve cited PDFs to local file links; show hades paths only.",
    )

    parser = argparse.ArgumentParser(
        prog="aprag",
        description="Query the AP-RAG academic-papers knowledge base.",
        parents=[common],
    )
    parser.add_argument("--version", action="version", version=f"aprag {__version__}")

    sub = parser.add_subparsers(dest="command", required=True)

    p_ask = sub.add_parser("ask", parents=[common, filt, localopt],
                           help="Synthesized answer (LLM over context).")
    p_ask.add_argument("question")
    p_ask.add_argument("--mode", default="hybrid", choices=VALID_MODES)
    p_ask.add_argument("--top-k", type=int, default=None, dest="top_k")
    p_ask.add_argument("--chunk-top-k", type=int, default=None, dest="chunk_top_k")
    p_ask.add_argument("--user-prompt", default=None, help="Extra instructions for the answer LLM.")
    p_ask.add_argument("--reasoning", choices=["minimal", "low", "medium", "high"], default="minimal",
                       help="Answer LLM reasoning effort (default minimal; higher = slower, more careful).")
    p_ask.add_argument("--plain", action="store_true",
                       help="Print raw markdown instead of rendering it in the terminal.")
    p_ask.set_defaults(func=_cmd_ask)

    p_chunks = sub.add_parser("chunks", parents=[common, filt, localopt],
                              help="Retrieved chunks (no LLM), as cited markdown.")
    p_chunks.add_argument("question")
    p_chunks.add_argument("--mode", default="naive", choices=VALID_MODES)
    p_chunks.add_argument("--top-k", type=int, default=None, dest="top_k")
    p_chunks.add_argument("--chunk-top-k", type=int, default=None, dest="chunk_top_k")
    p_chunks.add_argument(
        "--entities", action="store_true", help="Also show retrieved entities/relationships."
    )
    p_chunks.add_argument("--plain", action="store_true", help="Raw markdown (no rich rendering).")
    p_chunks.set_defaults(func=_cmd_chunks)

    p_search = sub.add_parser(
        "search", parents=[common, filt, localopt],
        help="Metadata-filtered semantic search → ranked papers.",
    )
    p_search.add_argument("question")
    p_search.add_argument("--top-k", type=int, default=None, dest="top_k",
                          help="Chunks pulled before folding into papers (default 40).")
    p_search.set_defaults(func=_cmd_search)

    p_health = sub.add_parser("health", parents=[common], help="Server liveness + capabilities.")
    p_health.set_defaults(func=_cmd_health)

    p_config = sub.add_parser(
        "config", parents=[common],
        help="Show or set the persisted default server (shell-independent).",
    )
    csub = p_config.add_subparsers(dest="config_cmd", required=True)
    csub.add_parser("show", help="Show the resolved server and where it comes from.")
    c_set = csub.add_parser("set-server", help="Persist the default query server URL to the config file.")
    c_set.add_argument("url")
    p_config.set_defaults(func=_cmd_config)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    # Normalize SUPPRESS'd shared flags so handlers can read them unconditionally.
    args.server = getattr(args, "server", None)
    args.local = getattr(args, "local", False)
    args.json = getattr(args, "json", False)
    try:
        return asyncio.run(args.func(args))
    except APRAGError as exc:
        print(f"aprag: error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
