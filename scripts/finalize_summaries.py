#!/usr/bin/env python3
"""Finalize pass for defer-mode ingests: summarize every fat entity/relation card once.

Why this exists
---------------
During bulk ingest we defer ALL entity/relation description summarization by setting
FORCE_LLM_SUMMARY_ON_MERGE / SUMMARY_MAX_TOKENS / SUMMARY_CONTEXT_SIZE to effectively
infinite, so merges just concatenate fragments (zero in-line LLM rewrites — they were
~45% of ingest LLM work and grew with graph density). This script is the deferred
tidy-up: after the last document, walk the knowledge graph and, for every card whose
description accumulated enough fragments/tokens, produce ONE final LLM summary and
re-embed the affected VDB records.

It is wrapper-side only (CLAUDE.md: never patch LightRAG/): the summarization itself
is LightRAG's own `_handle_entity_relation_summary` — same prompts, same LLM response
cache, same built-in map-reduce for cards larger than the context window — driven with
finalize-time knobs instead of ingest-time ones. VDB payloads mirror the library's
merge-path composition exactly (see operate.py rebuild/merge upserts).

Serve the summary LLM with as long a max-model-len as the GPUs allow (the same
Qwen3.6 re-served at 128k+ makes ~99% of cards a single gulp; the map-reduce inside
the library handles the rest automatically).

Usage (inside a SLURM job on the cluster holding the storage; vLLM(s) up unless
--stats-only):
    WORKDIR=/scratch/.../westbury_rag STORAGE_SUBDIR=rag_storage_full \
    QDRANT_URL=http://127.0.0.1:6333 PYTHONPATH=$WORKDIR \
    python scripts/finalize_summaries.py [--stats-only]

Env knobs (finalize-time, independent of the ingest-time defer values):
    FINALIZE_FORCE_ON        (8)     summarize cards with >= this many fragments
    FINALIZE_MAX_TOKENS      (1200)  ... or more tokens than this
    FINALIZE_CONTEXT_SIZE    (30000) one-gulp budget; above it the library map-reduces
    FINALIZE_SUMMARY_LENGTH  (600)   recommended summary length (prompt hint)
    FINALIZE_MAX_ASYNC       (24)    concurrent cards in flight
    FINALIZE_BATCH           (256)   cards per write slice (graph+VDB upserts batched)
    FINALIZE_FLUSH_S         (600)   seconds between storage persistence flushes
    FINALIZE_SCOPE           (all)   nodes | edges | all
    FINALIZE_CHECKPOINT      ($STORAGE_DIR/finalize_checkpoint.jsonl)
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

# Reuse the ingest wrapper's building blocks (endpoint discovery, round-robin LLM,
# in-process embedder with the OOM guards, storage config). Importing it requires
# the same env the ingest jobs set (WORKDIR etc.).
from pipeline import ingest as ing  # noqa: E402

FORCE_ON       = int(os.environ.get("FINALIZE_FORCE_ON", 8))
MAX_TOKENS     = int(os.environ.get("FINALIZE_MAX_TOKENS", 1200))
CONTEXT_SIZE   = int(os.environ.get("FINALIZE_CONTEXT_SIZE", 30000))
SUMMARY_LENGTH = int(os.environ.get("FINALIZE_SUMMARY_LENGTH", 600))
MAX_ASYNC      = int(os.environ.get("FINALIZE_MAX_ASYNC", 24))
BATCH          = int(os.environ.get("FINALIZE_BATCH", 256))
FLUSH_S        = int(os.environ.get("FINALIZE_FLUSH_S", 600))
SCOPE          = os.environ.get("FINALIZE_SCOPE", "all")
CHECKPOINT     = Path(os.environ.get("FINALIZE_CHECKPOINT", str(ing.STORAGE_DIR / "finalize_checkpoint.jsonl")))

_stats = {"nodes_seen": 0, "edges_seen": 0, "candidates": 0, "summarized": 0,
          "llm_used": 0, "skipped_checkpoint": 0, "vdb_upserts": 0, "errors": 0}


def _node_key(name: str) -> str:
    return f"n|{name}"


def _edge_key(src: str, tgt: str) -> str:
    return f"e|{src}|{tgt}"


def _load_checkpoint() -> set:
    done = set()
    if CHECKPOINT.exists():
        with CHECKPOINT.open() as f:
            for line in f:
                try:
                    done.add(json.loads(line)["k"])
                except Exception:
                    continue
    return done


def _needs_summary(desc: str, tokenizer, sep: str) -> tuple[bool, int, int]:
    """Mirror the library's two-dimensional trigger with finalize-time values."""
    if not desc:
        return False, 0, 0
    frags = desc.split(sep)
    if len(frags) < 2:
        return False, len(frags), 0
    ntok = len(tokenizer.encode(desc))
    return (len(frags) >= FORCE_ON or ntok >= MAX_TOKENS), len(frags), ntok


async def _get_nx_graph(g):
    """NetworkXStorage keeps the graph in g._graph after initialization; force a
    load through a public call first so we never race the lazy loader."""
    try:
        await g.get_all_labels()
    except Exception:
        pass
    nxg = getattr(g, "_graph", None)
    if nxg is None:
        raise RuntimeError("Graph storage did not expose a loaded graph (_graph is None)")
    return nxg


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stats-only", action="store_true",
                        help="no writes, no LLM: report card-size distribution + call estimate")
    args = parser.parse_args()

    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc, compute_mdhash_id
    from lightrag.constants import GRAPH_FIELD_SEP
    from lightrag.operate import _handle_entity_relation_summary, _truncate_vdb_content

    # ── LLM: real round-robin over discovered vLLM endpoints (skip for stats) ──
    if args.stats_only:
        async def llm_func(*a, **k):  # noqa: ANN001
            raise RuntimeError("LLM must not be called in --stats-only mode")
    else:
        endpoints = ing.discover_endpoints()
        if not endpoints:
            print("ERROR: no live vLLM endpoints found; start vLLM job(s) first.")
            sys.exit(1)
        llm_func = ing.build_round_robin_llm(endpoints)
        if not ing.EMBED_ENDPOINT:
            ing.get_embed_model()  # pre-load embedder (carries the OOM guards)

    rag_kwargs = dict(
        working_dir=str(ing.STORAGE_DIR),
        llm_model_func=llm_func,
        embedding_func=EmbeddingFunc(
            embedding_dim=ing.EMBEDDING_DIM,
            max_token_size=8192,
            func=ing.local_embed,
            supports_asymmetric=True,
        ),
        embedding_func_max_async=ing.EMBED_FUNC_MAX_ASYNC,
        embedding_batch_num=ing.EMBEDDING_BATCH_NUM,
        default_embedding_timeout=int(os.environ.get("EMBED_TIMEOUT", 1800)),
    )
    if ing.USE_QDRANT:
        rag_kwargs["vector_storage"] = "QdrantVectorDBStorage"
    # Fix-graph: this pass REWRITES entity/relation descriptions in the graph, so
    # it must use the same backend that ingest writes (and abort on a mismatch —
    # summarizing a stale GraphML while the live graph is in Neo4j forks the store).
    if ing.GRAPH_STORAGE:
        rag_kwargs["graph_storage"] = ing.GRAPH_STORAGE
        print(f"[Fix-graph] Using graph_storage={ing.GRAPH_STORAGE}")
    ing.check_graph_backend(ing.STORAGE_DIR, ing.GRAPH_STORAGE)
    rag = LightRAG(**rag_kwargs)
    await rag.initialize_storages()

    # The library's own assembled config (asdict + addon_params + role_llm_funcs),
    # with the summary knobs overridden to finalize-time values. Using the real
    # builder keeps us correct across LightRAG upgrades.
    gc = rag._build_global_config()
    gc["force_llm_summary_on_merge"] = FORCE_ON
    gc["summary_max_tokens"] = MAX_TOKENS
    gc["summary_context_size"] = CONTEXT_SIZE
    gc["summary_length_recommended"] = SUMMARY_LENGTH
    tokenizer = gc["tokenizer"]

    g = rag.chunk_entity_relation_graph
    nxg = await _get_nx_graph(g)
    print(f"Graph loaded: {nxg.number_of_nodes()} nodes, {nxg.number_of_edges()} edges")
    print(f"Trigger: >={FORCE_ON} fragments or >={MAX_TOKENS} tokens | "
          f"one-gulp window: {CONTEXT_SIZE} tokens | scope: {SCOPE}")

    # ── Collect candidates ──
    cards = []  # (kind, key, name_or_pair, data, frags, ntok)
    if SCOPE in ("nodes", "all"):
        for name, data in nxg.nodes(data=True):
            _stats["nodes_seen"] += 1
            need, nfrag, ntok = _needs_summary(data.get("description", ""), tokenizer, GRAPH_FIELD_SEP)
            if need:
                cards.append(("node", _node_key(name), name, dict(data), nfrag, ntok))
    if SCOPE in ("edges", "all"):
        for src, tgt, data in nxg.edges(data=True):
            _stats["edges_seen"] += 1
            need, nfrag, ntok = _needs_summary(data.get("description", ""), tokenizer, GRAPH_FIELD_SEP)
            if need:
                cards.append(("edge", _edge_key(src, tgt), (src, tgt), dict(data), nfrag, ntok))
    _stats["candidates"] = len(cards)

    # ── Stats mode: size distribution + call estimate, then exit ──
    if args.stats_only:
        frag_counts = sorted(c[4] for c in cards)
        tok_counts = sorted(c[5] for c in cards)

        def pct(xs, p):
            return xs[min(len(xs) - 1, int(p / 100 * len(xs)))] if xs else 0

        one_gulp = sum(1 for t in tok_counts if t <= CONTEXT_SIZE)
        mapreduce = len(tok_counts) - one_gulp
        extra = sum((t // CONTEXT_SIZE) + 1 for t in tok_counts if t > CONTEXT_SIZE)
        print(f"\nCandidates needing summary: {len(cards)} "
              f"({sum(1 for c in cards if c[0] == 'node')} entities, "
              f"{sum(1 for c in cards if c[0] == 'edge')} relations)")
        print(f"Fragments p50/p90/p99/max: {pct(frag_counts, 50)}/{pct(frag_counts, 90)}/"
              f"{pct(frag_counts, 99)}/{frag_counts[-1] if frag_counts else 0}")
        print(f"Tokens    p50/p90/p99/max: {pct(tok_counts, 50)}/{pct(tok_counts, 90)}/"
              f"{pct(tok_counts, 99)}/{tok_counts[-1] if tok_counts else 0}")
        print(f"One-gulp cards (<= {CONTEXT_SIZE} tok): {one_gulp} | map-reduce cards: {mapreduce} "
              f"(≈{extra} extra chunk-summary calls)")
        print(f"Estimated LLM calls: ~{one_gulp + extra + mapreduce}")
        return

    done = _load_checkpoint()
    todo = [c for c in cards if c[1] not in done]
    _stats["skipped_checkpoint"] = len(cards) - len(todo)
    print(f"Cards to summarize: {len(todo)} (checkpoint skips {_stats['skipped_checkpoint']})")

    sem = asyncio.Semaphore(MAX_ASYNC)
    last_flush = time.time()
    t0 = time.time()

    async def summarize(card):
        kind, key, ref, data, nfrag, ntok = card
        desc = data.get("description", "")
        frags = desc.split(GRAPH_FIELD_SEP)
        label = ref if kind == "node" else f"{ref[0]}-{ref[1]}"
        async with sem:
            try:
                summary, used = await _handle_entity_relation_summary(
                    "Entity" if kind == "node" else "Relation",
                    label if kind == "node" else f"{ref[0]}-{ref[1]}",
                    frags,
                    GRAPH_FIELD_SEP,
                    gc,
                    llm_response_cache=rag.llm_response_cache,
                )
            except Exception as e:
                _stats["errors"] += 1
                print(f"[FINALIZE] ERROR summarizing {kind} {label}: {e}", flush=True)
                return None
        if used:
            _stats["llm_used"] += 1
        if not summary or summary == desc:
            return (card, None)  # nothing to write, still checkpoint it
        return (card, summary)

    async def flush_storages():
        for st in (g, rag.entities_vdb, rag.relationships_vdb, rag.llm_response_cache):
            try:
                await st.index_done_callback()
            except Exception as e:
                print(f"[FINALIZE] flush warning ({type(st).__name__}): {e}", flush=True)

    ckpt = CHECKPOINT.open("a")
    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        results = await asyncio.gather(*(summarize(c) for c in chunk))
        ent_vdb, rel_vdb = {}, {}
        rel_del = []
        for res in results:
            if res is None:
                continue
            card, summary = res
            kind, key, ref, data, _, _ = card
            if summary is not None:
                data["description"] = summary
                if kind == "node":
                    name = ref
                    await g.upsert_node(name, data)
                    content = _truncate_vdb_content(f"{name}\n{summary}", gc, f"entity:{name}")
                    ent_vdb[compute_mdhash_id(name, prefix="ent-")] = {
                        "content": content,
                        "entity_name": name,
                        "source_id": data.get("source_id", ""),
                        "description": summary,
                        "entity_type": data.get("entity_type", "UNKNOWN"),
                        "file_path": data.get("file_path", "unknown_source"),
                    }
                else:
                    src, tgt = ref
                    await g.upsert_edge(src, tgt, data)
                    s, t = (src, tgt) if src <= tgt else (tgt, src)
                    keywords = data.get("keywords", "")
                    content = _truncate_vdb_content(
                        f"{keywords}\t{s}\n{t}\n{summary}", gc, f"relationship:{s}-{t}"
                    )
                    rel_del.append(compute_mdhash_id(t + s, prefix="rel-"))
                    rel_vdb[compute_mdhash_id(s + t, prefix="rel-")] = {
                        "src_id": s,
                        "tgt_id": t,
                        "source_id": data.get("source_id", ""),
                        "content": content,
                        "keywords": keywords,
                        "description": summary,
                        "weight": float(data.get("weight", 1.0)),
                        "file_path": data.get("file_path", "unknown_source"),
                    }
                _stats["summarized"] += 1
            ckpt.write(json.dumps({"k": key}) + "\n")
        if rel_del:
            try:
                await rag.relationships_vdb.delete(rel_del)
            except Exception:
                pass
        if ent_vdb:
            await rag.entities_vdb.upsert(ent_vdb)
            _stats["vdb_upserts"] += len(ent_vdb)
        if rel_vdb:
            await rag.relationships_vdb.upsert(rel_vdb)
            _stats["vdb_upserts"] += len(rel_vdb)
        ckpt.flush()

        done_n = min(i + BATCH, len(todo))
        rate = done_n / max(time.time() - t0, 1) * 3600
        print(f"[FINALIZE] {done_n}/{len(todo)} cards | summarized={_stats['summarized']} "
              f"llm={_stats['llm_used']} errors={_stats['errors']} | {rate:.0f} cards/hr", flush=True)
        if time.time() - last_flush > FLUSH_S:
            await flush_storages()
            last_flush = time.time()

    ckpt.close()
    await flush_storages()
    await rag.finalize_storages()
    dt = time.time() - t0
    print(f"\nDone in {dt / 3600:.2f}h — {json.dumps(_stats)}")
    print("Reminder: re-sync the PC serving copy (rag storage + Qdrant) after this pass.")


if __name__ == "__main__":
    asyncio.run(main())
