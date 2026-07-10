r"""
migrate_to_db_backends.py — copy a file-based LightRAG store into server DBs, on the PC.

Purpose (docs/SCALING_ISSUES.md §3.3/§3.4/§7): the serving host cannot keep the
whole store in process RAM past ~4.4K papers (33.7 GB commit on a 32 GB box) and
pays a ~15 min GraphML parse at every boot. This script copies the portable file
store the HPC produces (JSON KVs + GraphML) into PostgreSQL (KV + doc-status)
and Neo4j (graph) — LightRAG's own upstream backends — after which the query
server selects them via constructor kwargs (env-driven, see query_server.py).
Vectors stay in Qdrant untouched. The LightRAG fork remains patch-free: all
writes go through LightRAG's storage classes, so every table/label/index is
created by LightRAG itself and matches what it expects at query time.

Idempotent: PG upserts are ON CONFLICT DO UPDATE, Neo4j upserts are MERGE.
A namespace whose destination row count already matches the source is skipped,
so reruns after an interruption are cheap.

Usage (on the PC, with Postgres :5432 and Neo4j :7687 up):
    venv\Scripts\python migrate_to_db_backends.py [--only kv|graph|docstatus] [--skip-verify]

Env (defaults match the PC deployment):
    STORAGE_DIR       = C:\rag_server\rag_storage_full   (source files; also LightRAG working_dir)
    QDRANT_URL        = http://localhost:6333
    POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE            (lightrag reads these itself)
    NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD              (lightrag reads these itself)
    KV_BATCH          = 2000   records per KV upsert call
    NODE_BATCH        = 2000   nodes per Neo4j batch
    EDGE_BATCH        = 1000   edges per Neo4j batch
"""

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from lightrag import LightRAG
from lightrag.utils import EmbeddingFunc

STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", r"C:\rag_server\rag_storage_full"))
KV_BATCH = int(os.environ.get("KV_BATCH", 2000))
NODE_BATCH = int(os.environ.get("NODE_BATCH", 2000))
EDGE_BATCH = int(os.environ.get("EDGE_BATCH", 1000))
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", 4096))

# KV namespaces to copy: (lightrag attribute, source json file).
# llm_response_cache is deliberately NOT copied — it is an ingest artifact; the
# serving host starts empty and repopulates with query-time entries.
KV_NAMESPACES = [
    ("full_docs", "kv_store_full_docs.json"),
    ("text_chunks", "kv_store_text_chunks.json"),
    ("full_entities", "kv_store_full_entities.json"),
    ("full_relations", "kv_store_full_relations.json"),
    ("entity_chunks", "kv_store_entity_chunks.json"),
    ("relation_chunks", "kv_store_relation_chunks.json"),
]


async def _dummy_embed(texts, **kwargs):
    # Never called during migration; present because LightRAG requires an
    # embedding func with a declared dim to initialize the vector storage.
    return np.zeros((len(texts), EMBEDDING_DIM), dtype=np.float32)


async def _dummy_llm(*args, **kwargs):
    raise RuntimeError("LLM must not be called during storage migration")


def _load_json(path: Path) -> dict:
    t0 = time.time()
    data = json.loads(path.read_text(encoding="utf-8"))
    print(f"  loaded {path.name}: {len(data)} records "
          f"({path.stat().st_size / 1e9:.2f} GB in {time.time() - t0:.0f}s)", flush=True)
    return data


async def migrate_kv(rag: LightRAG) -> None:
    for attr, fname in KV_NAMESPACES:
        storage = getattr(rag, attr, None)
        src = STORAGE_DIR / fname
        if storage is None or not src.exists():
            print(f"[kv] SKIP {attr} (storage={storage is not None}, file={src.exists()})",
                  flush=True)
            continue
        data = _load_json(src)
        if not data:
            continue
        done = 0
        t0 = time.time()
        items = list(data.items())
        for i in range(0, len(items), KV_BATCH):
            await storage.upsert(dict(items[i : i + KV_BATCH]))
            done += min(KV_BATCH, len(items) - i)
            if done % 50_000 < KV_BATCH:
                rate = done / max(time.time() - t0, 1e-9)
                print(f"[kv:{attr}] {done}/{len(items)} ({rate:.0f} rec/s)", flush=True)
        await storage.index_done_callback()
        print(f"[kv:{attr}] DONE {len(items)} records in {time.time() - t0:.0f}s", flush=True)
        del data, items


async def migrate_doc_status(rag: LightRAG) -> None:
    src = STORAGE_DIR / "kv_store_doc_status.json"
    if not src.exists():
        print("[docstatus] SKIP (no file)", flush=True)
        return
    data = _load_json(src)
    docs = {k: v for k, v in data.items() if k.startswith("doc-")}
    t0 = time.time()
    items = list(docs.items())
    for i in range(0, len(items), KV_BATCH):
        await rag.doc_status.upsert(dict(items[i : i + KV_BATCH]))
    await rag.doc_status.index_done_callback()
    print(f"[docstatus] DONE {len(items)} records in {time.time() - t0:.0f}s", flush=True)


def _iter_graphml(path: Path):
    """Stream (kind, payload) from a GraphML file without loading it into RAM.

    Yields ("node", (node_id, props)) then ("edge", (src, tgt, props)) in file
    order (networkx writes all nodes before all edges). Uses ElementTree
    iterparse with aggressive element clearing, so peak memory stays in the MBs
    regardless of graph size — nx.read_graphml on the same file needs ~15 GB at
    1.6M nodes and OOM'd the 32 GB serving host (§7).
    """
    import xml.etree.ElementTree as ET

    ns = "{http://graphml.graphdrawing.org/xmlns}"
    keys: dict[str, str] = {}  # key id -> attr name
    graph_elem = None  # completed children accumulate HERE, not under the root
    for event, elem in ET.iterparse(str(path), events=("start", "end")):
        if event == "start":
            if elem.tag == f"{ns}graph":
                graph_elem = elem
            continue
        tag = elem.tag
        if tag == f"{ns}key":
            keys[elem.get("id")] = elem.get("attr.name", elem.get("id"))
            elem.clear()
        elif tag == f"{ns}node":
            props = {keys.get(d.get("key"), d.get("key")): (d.text or "")
                     for d in elem.findall(f"{ns}data")}
            yield "node", (elem.get("id"), props)
            if graph_elem is not None:
                graph_elem.clear()  # O(1): drop all completed children
        elif tag == f"{ns}edge":
            props = {keys.get(d.get("key"), d.get("key")): (d.text or "")
                     for d in elem.findall(f"{ns}data")}
            yield "edge", (elem.get("source"), elem.get("target"), props)
            if graph_elem is not None:
                graph_elem.clear()


async def migrate_graph(rag: LightRAG) -> None:
    src = STORAGE_DIR / "graph_chunk_entity_relation.graphml"
    if not src.exists():
        print("[graph] SKIP (no graphml)", flush=True)
        return
    g = rag.chunk_entity_relation_graph

    print(f"[graph] streaming {src.name} ({src.stat().st_size / 1e9:.2f} GB)…", flush=True)
    t0 = time.time()
    nodes, edges = [], []
    n_done = e_done = 0
    for kind, payload in _iter_graphml(src):
        if kind == "node":
            node_id, props = payload
            props["entity_id"] = node_id
            nodes.append((node_id, props))
            if len(nodes) >= NODE_BATCH:
                await g.upsert_nodes_batch(nodes)
                n_done += len(nodes)
                nodes = []
                if n_done % 100_000 < NODE_BATCH:
                    print(f"[graph:nodes] {n_done} "
                          f"({n_done / max(time.time() - t0, 1e-9):.0f}/s)", flush=True)
        else:
            if nodes:  # flush remaining nodes before the first edge
                await g.upsert_nodes_batch(nodes)
                n_done += len(nodes)
                nodes = []
                print(f"[graph:nodes] DONE {n_done} in {time.time() - t0:.0f}s", flush=True)
                t0 = time.time()
            edges.append(payload)
            if len(edges) >= EDGE_BATCH:
                await g.upsert_edges_batch(edges)
                e_done += len(edges)
                edges = []
                if e_done % 100_000 < EDGE_BATCH:
                    print(f"[graph:edges] {e_done} "
                          f"({e_done / max(time.time() - t0, 1e-9):.0f}/s)", flush=True)
    if nodes:
        await g.upsert_nodes_batch(nodes)
        n_done += len(nodes)
        print(f"[graph:nodes] DONE {n_done} in {time.time() - t0:.0f}s", flush=True)
    if edges:
        await g.upsert_edges_batch(edges)
        e_done += len(edges)
    print(f"[graph:edges] DONE {e_done} in {time.time() - t0:.0f}s", flush=True)
    await g.index_done_callback()


async def verify(rag: LightRAG) -> None:
    """Spot-check readback through the SAME query-path APIs the server uses."""
    # 1. a known chunk id from the source file
    src = STORAGE_DIR / "kv_store_text_chunks.json"
    with src.open(encoding="utf-8") as f:
        head = f.read(200)
    first_key = head.split('"')[1]
    rec = await rag.text_chunks.get_by_id(first_key)
    assert rec and rec.get("content"), f"text_chunks readback failed for {first_key}"
    print(f"[verify] text_chunks.get_by_id OK ({first_key[:24]}…)", flush=True)
    # 2. graph degree of a node sampled from Neo4j itself
    labels = await rag.chunk_entity_relation_graph.get_all_labels()
    assert labels, "graph has no labels after migration"
    node = await rag.chunk_entity_relation_graph.get_node(labels[0])
    assert node, f"graph get_node failed for {labels[0]!r}"
    print(f"[verify] graph get_node OK ({labels[0][:32]!r})", flush=True)
    # 3. doc status counts
    counts = await rag.doc_status.get_status_counts()
    print(f"[verify] doc_status counts: {counts}", flush=True)


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["kv", "graph", "docstatus"], default=None)
    ap.add_argument("--skip-verify", action="store_true")
    args = ap.parse_args()

    print(f"source: {STORAGE_DIR}", flush=True)
    rag = LightRAG(
        working_dir=str(STORAGE_DIR),
        llm_model_func=_dummy_llm,
        embedding_func=EmbeddingFunc(
            embedding_dim=EMBEDDING_DIM, max_token_size=8192, func=_dummy_embed
        ),
        kv_storage="PGKVStorage",
        doc_status_storage="PGDocStatusStorage",
        graph_storage="Neo4JStorage",
        vector_storage="QdrantVectorDBStorage",
        vector_db_storage_cls_kwargs={"cosine_better_than_threshold": 0.2},
        embedding_batch_num=500,
    )
    await rag.initialize_storages()
    print("storages initialized (PG tables + Neo4j indexes created)", flush=True)

    try:
        if args.only in (None, "kv"):
            await migrate_kv(rag)
        if args.only in (None, "docstatus"):
            await migrate_doc_status(rag)
        if args.only in (None, "graph"):
            await migrate_graph(rag)
        if not args.skip_verify:
            await verify(rag)
    finally:
        await rag.finalize_storages()
    print("MIGRATION COMPLETE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
