"""
rebuild_graph.py — Repair the LightRAG knowledge graph for docs whose chunk
source_ids are absent from graph_chunk_entity_relation.graphml.

Pipeline per missing doc (mirrors ingest_cml_octen_v2.py exactly):
    1. extract_entities(chunks)      — all LLM calls are cache hits
    2. merge_nodes_and_edges(...)    — updates graphml + KV stores only
                                       entity_vdb=None, relationships_vdb=None
                                       so Qdrant is NOT touched

Chunk embeddings (Qdrant) are already correct from the original ingest run.
Entity/relation Qdrant vectors are not updated here (they exist from earlier
docs, just missing the new merge contributions from the affected docs).

All LLM calls (entity extraction + summary merging) are expected to be cache hits
in kv_store_llm_response_cache.json. Any cache miss raises RuntimeError with the
prompt hash so you know which doc is affected.

Environment variables (same subset as job_westbury_ingest_v2_tril.slurm):
    WORKDIR          — HPC working directory (required)
    STORAGE_SUBDIR   — LightRAG storage subdirectory
                       (default: rag_storage_westbury_qwen3_32b)
    PARALLEL_DOCS    — concurrent doc merges (default: 8)
    LLM_MAX_ASYNC    — max concurrent LLM cache lookups (default: 16)
"""

import asyncio
import json
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path

import networkx as nx

# ── Configuration ──────────────────────────────────────────────────────────────

WORKDIR      = Path(os.environ["WORKDIR"])
STORAGE_DIR  = WORKDIR / os.environ.get("STORAGE_SUBDIR", "rag_storage_westbury_qwen3_32b")

PARALLEL_DOCS  = int(os.environ.get("PARALLEL_DOCS", 8))
LLM_MAX_ASYNC  = int(os.environ.get("LLM_MAX_ASYNC", 16))

GRAPH_FIELD_SEP = "<SEP>"   # must match lightrag.constants.GRAPH_FIELD_SEP


# ── Dummy stubs (no GPU required) ─────────────────────────────────────────────

async def _dummy_llm(*args, **kwargs):
    """
    Should never be called — every LLM prompt must already be in
    kv_store_llm_response_cache.json.  If it IS called, the cache lookup
    missed, which means this doc was not fully processed before the crash.
    Abort loudly so the operator knows which doc needs a real LLM run.
    """
    prompt = args[0] if args else kwargs.get("prompt", "<unknown>")
    raise RuntimeError(
        f"LLM cache miss during graph rebuild — no cached result for prompt "
        f"(len={len(str(prompt))}).  This doc's entity extraction or summary "
        f"merge is not in kv_store_llm_response_cache.json.  Re-run with a "
        f"live vLLM endpoint (N_VLLM≥1) to regenerate the missing cache entry."
    )


async def _dummy_embed(texts):
    """Never called — we pass entity_vdb=None and relationships_vdb=None."""
    raise RuntimeError("Embedding called unexpectedly during graph-only rebuild.")


# ── Identify missing docs ──────────────────────────────────────────────────────

def find_missing_docs() -> dict[str, list[str]]:
    """
    Return {doc_id: [chunk_id, ...]} for every 'processed' doc in
    kv_store_doc_status.json whose chunks have NO entry in the graphml.

    A doc is considered 'missing' if NONE of its chunk_ids appear as a
    source_id fragment in any graphml node or edge.
    """
    # ── Load doc status ──
    status_path = STORAGE_DIR / "kv_store_doc_status.json"
    if not status_path.exists():
        print(f"ERROR: {status_path} not found.", flush=True)
        sys.exit(1)

    raw_status = json.loads(status_path.read_text())
    processed_docs: dict[str, list[str]] = {}
    for k, v in raw_status.items():
        if not k.startswith("doc-"):
            continue
        if v.get("status") == "processed":
            chunks_list = v.get("chunks_list", [])
            if chunks_list:
                processed_docs[k] = chunks_list

    print(f"Processed docs in status file: {len(processed_docs)}", flush=True)

    # ── Load graphml, collect all chunk_ids referenced as source_ids ──
    graph_path = STORAGE_DIR / "graph_chunk_entity_relation.graphml"
    if not graph_path.exists():
        print(f"ERROR: {graph_path} not found.", flush=True)
        sys.exit(1)

    # Fix-graph guard: this tool repairs the FILE-backed graph only. Once the
    # store is written by Neo4JStorage the GraphML here is a frozen snapshot —
    # "repairing" and rewriting it would fork the graph.
    marker = STORAGE_DIR / ".graph_backend"
    if marker.exists() and marker.read_text().strip() == "Neo4JStorage":
        print("ERROR: this store's graph is written by Neo4JStorage (see "
              ".graph_backend); rebuild_graph.py only repairs the NetworkX/GraphML "
              "backend. Adapt it (pass graph_storage=Neo4JStorage + live sidecar) "
              "before using it on a Neo4j-backed store.", flush=True)
        sys.exit(1)

    print(f"Loading graphml ({graph_path.stat().st_size / 1e6:.1f} MB)…", flush=True)
    G = nx.read_graphml(str(graph_path))

    graphml_chunk_ids: set[str] = set()
    for _node_id, node_data in G.nodes(data=True):
        source_id = node_data.get("source_id", "")
        if source_id:
            for cid in source_id.split(GRAPH_FIELD_SEP):
                cid = cid.strip()
                if cid:
                    graphml_chunk_ids.add(cid)

    for _src, _tgt, edge_data in G.edges(data=True):
        source_id = edge_data.get("source_id", "")
        if source_id:
            for cid in source_id.split(GRAPH_FIELD_SEP):
                cid = cid.strip()
                if cid:
                    graphml_chunk_ids.add(cid)

    n_nodes = G.number_of_nodes()
    n_edges = G.number_of_edges()
    print(
        f"Graphml: {n_nodes} nodes, {n_edges} edges, "
        f"{len(graphml_chunk_ids)} unique chunk source_ids",
        flush=True,
    )

    # ── Find docs where NONE of their chunks appear in graphml ──
    missing: dict[str, list[str]] = {}
    partial: dict[str, list[str]] = {}  # some chunks present, some not — log only

    for doc_id, chunk_ids in processed_docs.items():
        in_graph = [cid for cid in chunk_ids if cid in graphml_chunk_ids]
        if not in_graph:
            missing[doc_id] = chunk_ids
        elif len(in_graph) < len(chunk_ids):
            partial[doc_id] = [cid for cid in chunk_ids if cid not in graphml_chunk_ids]

    print(f"Docs fully missing from graphml: {len(missing)}", flush=True)
    if partial:
        print(
            f"Docs partially missing ({len(partial)} docs with some chunks absent) — "
            f"these are skipped (partial merges are complex; re-run full ingest if needed).",
            flush=True,
        )

    return missing


# ── Load text chunks for missing docs ─────────────────────────────────────────

def load_chunks_for_docs(
    doc_chunk_ids: dict[str, list[str]],
) -> dict[str, dict]:
    """
    Load the text chunk dicts from kv_store_text_chunks.json for all
    chunk_ids belonging to the missing docs.
    """
    chunks_path = STORAGE_DIR / "kv_store_text_chunks.json"
    if not chunks_path.exists():
        print(f"ERROR: {chunks_path} not found.", flush=True)
        sys.exit(1)

    all_chunks: dict[str, dict] = json.loads(chunks_path.read_text())

    needed: set[str] = set()
    for chunk_ids in doc_chunk_ids.values():
        needed.update(chunk_ids)

    found   = {cid: all_chunks[cid] for cid in needed if cid in all_chunks}
    missing = needed - set(found.keys())
    if missing:
        print(
            f"WARNING: {len(missing)} chunk_ids not found in kv_store_text_chunks.json "
            f"(may have been lost — those chunks will be skipped).",
            flush=True,
        )

    print(
        f"Loaded {len(found)} chunks for {len(doc_chunk_ids)} missing docs.",
        flush=True,
    )
    return found


# ── Main ───────────────────────────────────────────────────────────────────────

async def main():
    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc
    from lightrag.operate import extract_entities, merge_nodes_and_edges

    t_start = time.time()

    print(f"\n{'='*60}", flush=True)
    print(f"rebuild_graph.py", flush=True)
    print(f"  WORKDIR       : {WORKDIR}", flush=True)
    print(f"  STORAGE_DIR   : {STORAGE_DIR}", flush=True)
    print(f"  PARALLEL_DOCS : {PARALLEL_DOCS}", flush=True)
    print(f"  LLM_MAX_ASYNC : {LLM_MAX_ASYNC}", flush=True)
    print(f"{'='*60}\n", flush=True)

    # ── Step 1: Identify missing docs ──────────────────────────────────────────
    print("=== Step 1: Identifying missing docs ===", flush=True)
    missing_docs = find_missing_docs()
    if not missing_docs:
        print("\nNo missing docs — graphml is already complete.", flush=True)
        return

    # ── Step 2: Load text chunks ───────────────────────────────────────────────
    print("\n=== Step 2: Loading text chunks ===", flush=True)
    all_chunks = load_chunks_for_docs(missing_docs)

    # ── Step 3: Initialize LightRAG ───────────────────────────────────────────
    print("\n=== Step 3: Initializing LightRAG ===", flush=True)

    # Dummy embedding func — never called since entity_vdb=None, relationships_vdb=None
    dummy_embed_func = EmbeddingFunc(
        embedding_dim=4096,
        max_token_size=8192,
        func=_dummy_embed,
    )

    rag_kwargs = dict(
        working_dir=str(STORAGE_DIR),
        llm_model_func=_dummy_llm,
        llm_model_max_async=LLM_MAX_ASYNC,
        embedding_func=dummy_embed_func,
        # No vector_storage override — NanoVectorDB by default.
        # entity_vdb / relationships_vdb instances will be created but
        # we pass None explicitly to merge_nodes_and_edges so they are
        # never written to.
        # chunks_vdb is also unused (we do not re-embed chunks).
    )

    # ── Temporarily hide vdb_*.json files so LightRAG inits fresh empty VDBs ──
    # LightRAG's NanoVectorDB loads these at construction time. They can be very
    # large (1+ GB) and may be partially corrupt. Since we never write to the
    # VDBs in this script, we move them aside and restore after finalize.
    vdb_files = list(STORAGE_DIR.glob("vdb_*.json"))
    vdb_hidden = {}
    for vdb in vdb_files:
        hidden = vdb.with_suffix(".json.rebuild_bak")
        vdb.rename(hidden)
        vdb_hidden[hidden] = vdb
        print(f"  Hid {vdb.name} → {hidden.name}", flush=True)

    try:
        rag = LightRAG(**rag_kwargs)
        await rag.initialize_storages()
    except Exception:
        # Restore VDB files before re-raising so we don't lose them
        for hidden, original in vdb_hidden.items():
            hidden.rename(original)
        raise

    global_config = asdict(rag)

    pipeline_status = {
        "latest_message": "",
        "history_messages": [],
        "cancellation_requested": False,
    }
    pipeline_status_lock = asyncio.Lock()

    # ── Steps 4-6 wrapped in try/finally to always restore vdb_*.json ────────
    try:
        # ── Step 4: Process each missing doc ──────────────────────────────────
        print(f"\n=== Step 4: Rebuilding graph for {len(missing_docs)} docs ===", flush=True)

        sem = asyncio.Semaphore(PARALLEL_DOCS)
        doc_list = list(missing_docs.items())
        total = len(doc_list)
        succeeded = 0
        failed = 0
        counter_lock = asyncio.Lock()

        async def process_one_doc(doc_id: str, chunk_ids: list[str], idx: int):
            nonlocal succeeded, failed

            async with sem:
                doc_chunks = {
                    cid: all_chunks[cid] for cid in chunk_ids if cid in all_chunks
                }
                if not doc_chunks:
                    print(
                        f"[{idx:04d}/{total}] {doc_id}: no chunks loaded — skipping",
                        flush=True,
                    )
                    return

                try:
                    # ── extract_entities: all calls are cache hits ──────────────
                    chunk_results = await extract_entities(
                        doc_chunks,
                        global_config=global_config,
                        pipeline_status=pipeline_status,
                        pipeline_status_lock=pipeline_status_lock,
                        llm_response_cache=rag.llm_response_cache,
                        text_chunks_storage=rag.text_chunks,
                    )

                    n_entities  = sum(len(nodes) for nodes, _     in chunk_results)
                    n_relations = sum(len(edges) for _,     edges  in chunk_results)
                    print(
                        f"[{idx:04d}/{total}] {doc_id}: "
                        f"{len(doc_chunks)} chunks → {n_entities} ent, {n_relations} rel → merging…",
                        flush=True,
                    )

                    # ── merge_nodes_and_edges: graph only, no vector DB writes ──
                    # entity_vdb=None and relationships_vdb=None skip all Qdrant
                    # upserts inside _merge_nodes_then_upsert and
                    # _merge_edges_then_upsert, exactly as those functions document.
                    await merge_nodes_and_edges(
                        chunk_results=chunk_results,
                        knowledge_graph_inst=rag.chunk_entity_relation_graph,
                        entity_vdb=None,
                        relationships_vdb=None,
                        global_config=global_config,
                        full_entities_storage=rag.full_entities,
                        full_relations_storage=rag.full_relations,
                        doc_id=doc_id,
                        pipeline_status=pipeline_status,
                        pipeline_status_lock=pipeline_status_lock,
                        llm_response_cache=rag.llm_response_cache,
                        entity_chunks_storage=rag.entity_chunks,
                        relation_chunks_storage=rag.relation_chunks,
                        current_file_number=idx,
                        total_files=total,
                    )

                    async with counter_lock:
                        succeeded += 1

                    elapsed = time.time() - t_start
                    rate = succeeded / (elapsed / 3600) if elapsed > 0 else 0
                    print(
                        f"[{idx:04d}/{total}] {doc_id}: done ✓  "
                        f"(rate={rate:.0f}/hr, elapsed={elapsed/60:.1f}min)",
                        flush=True,
                    )

                except Exception as e:
                    async with counter_lock:
                        failed += 1
                    print(
                        f"[{idx:04d}/{total}] {doc_id}: FAILED — {e}",
                        flush=True,
                    )

        tasks = [
            asyncio.create_task(process_one_doc(doc_id, chunk_ids, i + 1))
            for i, (doc_id, chunk_ids) in enumerate(doc_list)
        ]
        await asyncio.gather(*tasks)

        # ── Step 5: Flush — only storages we actually wrote to ────────────────
        # Deliberately excludes entities_vdb, relationships_vdb, chunks_vdb so
        # NanoVectorDB does not overwrite the existing vdb_*.json files.
        print("\n=== Step 5: Flushing storages ===", flush=True)
        flush_targets = [
            rag.chunk_entity_relation_graph,  # graphml
            rag.full_entities,                # kv_store_full_entities.json
            rag.full_relations,               # kv_store_full_relations.json
            rag.entity_chunks,                # kv_store_entity_chunks.json
            rag.relation_chunks,              # kv_store_relation_chunks.json
            rag.llm_response_cache,           # kv_store_llm_response_cache.json
        ]
        await asyncio.gather(*[s.index_done_callback() for s in flush_targets])
        await rag.finalize_storages()

    finally:
        # ── Step 6: Restore original vdb_*.json files (always) ───────────────
        # Delete the empty stubs LightRAG wrote, then restore the real originals.
        print("\n=== Step 6: Restoring original vdb_*.json files ===", flush=True)
        for hidden, original in vdb_hidden.items():
            if original.exists():
                original.unlink()
                print(f"  Removed stub {original.name}", flush=True)
            hidden.rename(original)
            print(f"  Restored {original.name}", flush=True)

    elapsed = time.time() - t_start
    print(f"\n{'='*60}", flush=True)
    print(f"Graph rebuild complete in {elapsed / 60:.1f} min", flush=True)
    print(f"  Docs processed successfully: {succeeded}", flush=True)
    print(f"  Docs failed:                 {failed}", flush=True)
    print(f"{'='*60}", flush=True)

    if failed:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
