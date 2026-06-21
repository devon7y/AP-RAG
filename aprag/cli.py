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

from . import __version__, client
from .client import VALID_MODES, APRAGError


# ── Output formatting ────────────────────────────────────────────────────────


def _format_chunks(result: dict, show_entities: bool) -> str:
    data = result.get("data") or {}
    chunks = data.get("chunks") or []
    meta = result.get("metadata") or {}
    mode = meta.get("query_mode", "?")

    out: list[str] = []
    if result.get("status") != "success":
        msg = result.get("message", "no data returned")
        return f"No results (status={result.get('status')}, mode={mode}): {msg}"

    out.append(f"=== {len(chunks)} chunk(s)  (mode={mode}) ===")
    for i, ch in enumerate(chunks, 1):
        ref = ch.get("reference_id", "?")
        path = ch.get("file_path", "unknown source")
        cid = ch.get("chunk_id", "")
        header = f"\n[{i}] ref={ref}  {path}"
        if cid:
            header += f"  ({cid})"
        out.append(header)
        out.append((ch.get("content") or "").strip())

    if show_entities:
        entities = data.get("entities") or []
        relationships = data.get("relationships") or []
        out.append(f"\n=== {len(entities)} entity(ies) ===")
        for e in entities:
            out.append(
                f"- {e.get('entity_name', '?')} "
                f"[{e.get('entity_type', '?')}]: {(e.get('description') or '').strip()}"
            )
        out.append(f"\n=== {len(relationships)} relationship(s) ===")
        for r in relationships:
            out.append(
                f"- {r.get('src_id', '?')} -> {r.get('tgt_id', '?')}: "
                f"{(r.get('description') or '').strip()}"
            )

    return "\n".join(out)


# ── Command handlers ─────────────────────────────────────────────────────────


async def _cmd_ask(args: argparse.Namespace) -> int:
    base_url = client.resolve_base_url(args.server, args.local)
    answer = await client.query(
        args.question,
        mode=args.mode,
        base_url=base_url,
        top_k=args.top_k,
        chunk_top_k=args.chunk_top_k,
        user_prompt=args.user_prompt,
    )
    if args.json:
        print(json.dumps({"answer": answer, "mode": args.mode}, indent=2))
    else:
        print(answer)
    return 0


async def _cmd_chunks(args: argparse.Namespace) -> int:
    base_url = client.resolve_base_url(args.server, args.local)
    result = await client.retrieve(
        args.question,
        mode=args.mode,
        base_url=base_url,
        top_k=args.top_k,
        chunk_top_k=args.chunk_top_k,
    )
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(_format_chunks(result, show_entities=args.entities))
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

    parser = argparse.ArgumentParser(
        prog="aprag",
        description="Query the AP-RAG academic-papers knowledge base.",
        parents=[common],
    )
    parser.add_argument("--version", action="version", version=f"aprag {__version__}")

    sub = parser.add_subparsers(dest="command", required=True)

    p_ask = sub.add_parser("ask", parents=[common], help="Synthesized answer (LLM over context).")
    p_ask.add_argument("question")
    p_ask.add_argument("--mode", default="hybrid", choices=VALID_MODES)
    p_ask.add_argument("--top-k", type=int, default=None, dest="top_k")
    p_ask.add_argument("--chunk-top-k", type=int, default=None, dest="chunk_top_k")
    p_ask.add_argument("--user-prompt", default=None, help="Extra instructions for the answer LLM.")
    p_ask.set_defaults(func=_cmd_ask)

    p_chunks = sub.add_parser("chunks", parents=[common], help="Raw retrieved chunks (no LLM).")
    p_chunks.add_argument("question")
    p_chunks.add_argument("--mode", default="naive", choices=VALID_MODES)
    p_chunks.add_argument("--top-k", type=int, default=None, dest="top_k")
    p_chunks.add_argument("--chunk-top-k", type=int, default=None, dest="chunk_top_k")
    p_chunks.add_argument(
        "--entities", action="store_true", help="Also show retrieved entities/relationships."
    )
    p_chunks.set_defaults(func=_cmd_chunks)

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
