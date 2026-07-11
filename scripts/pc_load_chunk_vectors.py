r"""
pc_load_chunk_vectors.py — rebuild the Qdrant chunks collection from HPC-embedded
fp16 vectors, on the PC.

Input: the output dir of scripts/reembed_chunks_hpc.py (chunk_ids.json,
vectors_fp16.npy, payloads.jsonl) — the complete, canonical bf16-computed
chunk-vector set. This script DROPS and recreates `lightrag_vdb_chunks` with
Qdrant `datatype=float16` + `on_disk=true` (half the bytes of fp32, no
retrieval-quality change for normalized bf16-computed embeddings) using the
same layout LightRAG creates (Cosine, multitenant HNSW m=0/payload_m=16,
workspace_id keyword index) and the same point-id scheme
(uuid4-from-sha256(workspace + chunk_id)), so the running LightRAG needs no
patch and no config change.

Run with the query server STOPPED (the collection briefly disappears):
    venv\Scripts\python pc_load_chunk_vectors.py [--in-dir DIR] [--yes]

Env: QDRANT_URL (default http://localhost:6333)
"""

import argparse
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
from qdrant_client import QdrantClient, models

QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
COLLECTION = "lightrag_vdb_chunks"
WORKSPACE = "_"
BATCH = 256


def qdrant_point_id(doc_id: str, workspace: str) -> str:
    digest = hashlib.sha256((workspace + doc_id).encode("utf-8")).digest()
    return uuid.UUID(bytes=digest[:16], version=4).hex


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-dir", default=r"C:\rag_server\reembed_chunks_out")
    ap.add_argument("--yes", action="store_true", help="skip confirmation")
    args = ap.parse_args()
    in_dir = Path(args.in_dir)

    ids = json.loads((in_dir / "chunk_ids.json").read_text())
    shards = sorted(in_dir.glob("vectors_fp16_*.npy"))
    if shards:
        vecs = np.concatenate([np.load(p) for p in shards], axis=0)
    else:  # legacy single-file layout
        vecs = np.load(in_dir / "vectors_fp16.npy")
    assert len(ids) == vecs.shape[0] and vecs.shape[1] == 4096, (
        f"shape mismatch: {len(ids)} ids vs {vecs.shape}")
    payloads: dict[str, dict] = {}
    with (in_dir / "payloads.jsonl").open(encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            payloads[rec["id"]] = rec
    assert set(ids) == set(payloads), "ids/payloads mismatch"
    print(f"input OK: {len(ids)} chunks, vectors {vecs.shape} {vecs.dtype}", flush=True)

    client = QdrantClient(url=QDRANT_URL, timeout=120)
    if client.collection_exists(COLLECTION):
        old = client.count(COLLECTION, exact=True).count
        print(f"existing {COLLECTION}: {old} points — will be DROPPED", flush=True)
        if not args.yes:
            print("pass --yes to proceed", flush=True)
            return 1
        client.delete_collection(COLLECTION)

    client.create_collection(
        collection_name=COLLECTION,
        vectors_config=models.VectorParams(
            size=4096,
            distance=models.Distance.COSINE,
            datatype=models.Datatype.FLOAT16,
            on_disk=True,
        ),
        hnsw_config=models.HnswConfigDiff(m=0, payload_m=16, ef_construct=100),
        on_disk_payload=True,
    )
    client.create_payload_index(
        collection_name=COLLECTION, field_name="workspace_id",
        field_schema=models.PayloadSchemaType.KEYWORD)
    # LightRAG's metadata-filtered search path also filters on file_path.
    client.create_payload_index(
        collection_name=COLLECTION, field_name="file_path",
        field_schema=models.PayloadSchemaType.KEYWORD)
    print("collection recreated (float16, on_disk)", flush=True)

    created = int(time.time())
    t0 = time.time()
    for i in range(0, len(ids), BATCH):
        pts = []
        for j, k in enumerate(ids[i : i + BATCH]):
            rec = payloads[k]
            pts.append(models.PointStruct(
                id=qdrant_point_id(k, WORKSPACE),
                vector=vecs[i + j].astype(np.float32).tolist(),
                payload={"id": k, "workspace_id": WORKSPACE, "created_at": created,
                         "full_doc_id": rec["full_doc_id"], "content": rec["content"],
                         "file_path": rec["file_path"]},
            ))
        client.upsert(collection_name=COLLECTION, points=pts, wait=True)
        if (i // BATCH) % 50 == 0:
            rate = (i + len(pts)) / max(time.time() - t0, 1e-9)
            print(f"[load] {i + len(pts)}/{len(ids)} ({rate:.0f}/s)", flush=True)
    print(f"[load] DONE {len(ids)} in {time.time() - t0:.0f}s", flush=True)

    n = client.count(COLLECTION, exact=True).count
    assert n == len(ids), f"count mismatch after load: {n} != {len(ids)}"
    # self-retrieval sanity: the first chunk's own vector must return itself top-1
    hit = client.query_points(
        collection_name=COLLECTION, query=vecs[0].astype(np.float32).tolist(),
        limit=1, with_payload=["id"],
        query_filter=models.Filter(must=[models.FieldCondition(
            key="workspace_id", match=models.MatchValue(value=WORKSPACE))]),
    ).points[0]
    assert hit.payload["id"] == ids[0], f"self-retrieval failed: {hit.payload}"
    print(f"verify OK: count={n}, self-retrieval top-1 score={hit.score:.4f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
