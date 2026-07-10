r"""
pc_fill_missing_chunks.py — fill chunk vectors missing from Qdrant, on the PC.

Why this exists: during the full-corpus ingest, chunk vectors were written to a
node-local Qdrant sidecar and synced back to scratch at walltime. Cycles whose
sync was starved (the 600s-grace era) lost their Qdrant delta, so the synced
`lightrag_vdb_chunks` collection holds only a subset of the chunks that exist in
`kv_store_text_chunks.json` (which is flushed separately and is complete).
This script re-embeds the missing chunks through the LOCAL embed server
(server.py :8000, `context="document"` = no instruction, matching ingest) and
upserts them with LightRAG's exact Qdrant point schema — no LightRAG patch.

It is idempotent/resumable: existing point IDs are skipped on every run.

Usage (on the PC, with Qdrant :6333 and the embed server :8000 up):
    venv\Scripts\python pc_fill_missing_chunks.py [--dry-run] [--limit N]

Env (defaults match the PC deployment):
    STORAGE_DIR = C:\rag_server\rag_storage_full
    QDRANT_URL  = http://localhost:6333
    EMBED_HOST  = http://localhost:8000/v1
    BATCH_EMBED = 16      texts per embed API call
    BATCH_UPSERT= 128     points per Qdrant upsert
"""

import argparse
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

import httpx
from qdrant_client import QdrantClient
from qdrant_client import models

STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", r"C:\rag_server\rag_storage_full"))
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
EMBED_HOST = os.environ.get("EMBED_HOST", "http://localhost:8000/v1")
BATCH_EMBED = int(os.environ.get("BATCH_EMBED", 16))
BATCH_UPSERT = int(os.environ.get("BATCH_UPSERT", 128))
COLLECTION = "lightrag_vdb_chunks"
META_FIELDS = ("full_doc_id", "content", "file_path")  # chunks_vdb meta_fields in lightrag.py


def qdrant_point_id(doc_id: str, workspace: str) -> str:
    """LightRAG's compute_mdhash_id_for_qdrant(..., style='simple')."""
    digest = hashlib.sha256((workspace + doc_id).encode("utf-8")).digest()
    return uuid.UUID(bytes=digest[:16], version=4).hex


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="stop after N missing chunks")
    args = ap.parse_args()

    client = QdrantClient(url=QDRANT_URL, timeout=120)

    # ── 1. sample an existing point; derive workspace and VALIDATE the id scheme ──
    points, _ = client.scroll(collection_name=COLLECTION, limit=1, with_payload=True)
    if not points:
        print("collection is empty — refusing to guess the payload schema", flush=True)
        return 1
    sample = points[0]
    workspace = sample.payload.get("workspace_id", "_")
    sample_kv_id = sample.payload.get("id")
    expect = qdrant_point_id(sample_kv_id, workspace)
    got = str(sample.id).replace("-", "")
    if expect != got:
        print(f"ID-scheme mismatch: computed {expect} vs actual {got} — aborting", flush=True)
        return 1
    print(f"id scheme validated (workspace={workspace!r})", flush=True)

    # ── 2. existing point ids ──
    existing: set[str] = set()
    offset = None
    while True:
        pts, offset = client.scroll(
            collection_name=COLLECTION, limit=4096,
            with_payload=["id"], with_vectors=False, offset=offset)
        existing.update(p.payload["id"] for p in pts if p.payload and p.payload.get("id"))
        if offset is None:
            break
    print(f"existing chunk points: {len(existing)}", flush=True)

    # ── 3. all chunks from the KV store ──
    t0 = time.time()
    kv_path = STORAGE_DIR / "kv_store_text_chunks.json"
    data = json.loads(kv_path.read_text(encoding="utf-8"))
    print(f"KV chunks: {len(data)} (loaded {kv_path.stat().st_size/1e9:.2f} GB "
          f"in {time.time()-t0:.0f}s)", flush=True)

    missing = [k for k in data if k not in existing]
    print(f"missing from Qdrant: {len(missing)}", flush=True)
    if args.limit:
        missing = missing[: args.limit]
    if args.dry_run or not missing:
        return 0

    # ── 4. embed via local server (context=document → NO instruction, like ingest) ──
    http = httpx.Client(timeout=300)
    created = int(time.time())
    done = 0
    t_start = time.time()
    for i in range(0, len(missing), BATCH_UPSERT):
        batch_ids = missing[i : i + BATCH_UPSERT]
        vectors: list[list[float]] = []
        for j in range(0, len(batch_ids), BATCH_EMBED):
            texts = [data[k]["content"] for k in batch_ids[j : j + BATCH_EMBED]]
            r = http.post(f"{EMBED_HOST}/embeddings",
                          json={"input": texts, "model": "qwen3-embedding-8b",
                                "context": "document"})
            r.raise_for_status()
            vectors.extend(item["embedding"] for item in r.json()["data"])
        pts = []
        for k, vec in zip(batch_ids, vectors):
            rec = data[k]
            payload = {"id": k, "workspace_id": workspace, "created_at": created}
            payload.update({f: rec[f] for f in META_FIELDS if f in rec})
            pts.append(models.PointStruct(
                id=qdrant_point_id(k, workspace), vector=vec, payload=payload))
        client.upsert(collection_name=COLLECTION, points=pts, wait=True)
        done += len(pts)
        rate = done / max(time.time() - t_start, 1e-9)
        eta_h = (len(missing) - done) / max(rate, 1e-9) / 3600
        print(f"[fill] {done}/{len(missing)} rate={rate:.1f} chunks/s eta={eta_h:.1f}h",
              flush=True)
    print("done", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
