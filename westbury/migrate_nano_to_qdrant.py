#!/usr/bin/env python3
"""
migrate_nano_to_qdrant.py — Migrate NanoVectorDB JSON storage to Qdrant.

Reads vdb_chunks.json, vdb_entities.json, vdb_relationships.json from STORAGE_DIR,
and upserts all vectors into a running Qdrant instance.

Collection naming and payload format exactly match LightRAG's QdrantVectorDBStorage
(with no model_name on EmbeddingFunc and default workspace), so the ingest pipeline
can resume seamlessly after migration.

Collection names: lightrag_vdb_{chunks,entities,relationships}
Workspace:        "_" (DEFAULT_WORKSPACE in qdrant_impl.py, since workspace="" is falsy)
Point IDs:        SHA256("_" + __id__)[:16] as UUID hex (compute_mdhash_id_for_qdrant)
"""

import base64
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path

import numpy as np
from qdrant_client import QdrantClient, models

STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", "/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b"))
QDRANT_URL  = os.environ.get("QDRANT_URL", "http://localhost:6333")
WORKSPACE   = "_"       # DEFAULT_WORKSPACE in LightRAG qdrant_impl.py
EMBEDDING_DIM = 4096
BATCH_SIZE  = 500       # points per upsert call

# Meta fields stored per namespace — matches lightrag.py lines ~650-662
META_FIELDS = {
    "chunks":        {"full_doc_id", "content", "file_path"},
    "entities":      {"entity_name", "source_id", "content", "file_path"},
    "relationships": {"src_id", "tgt_id", "source_id", "content", "file_path"},
}


def compute_mdhash_id_for_qdrant(content: str, prefix: str = "") -> str:
    """Replica of LightRAG's compute_mdhash_id_for_qdrant (style='simple')."""
    hashed_content = hashlib.sha256((prefix + content).encode("utf-8")).digest()
    generated_uuid = uuid.UUID(bytes=hashed_content[:16], version=4)
    return generated_uuid.hex


def ensure_collection(client: QdrantClient, collection_name: str) -> bool:
    """Create collection if it doesn't exist. Returns True if created, False if existing."""
    if client.collection_exists(collection_name):
        info = client.get_collection(collection_name)
        print(f"  Collection '{collection_name}' already exists ({info.points_count} points).")
        return False

    print(f"  Creating collection '{collection_name}'...")
    client.create_collection(
        collection_name=collection_name,
        vectors_config=models.VectorParams(
            size=EMBEDDING_DIM,
            distance=models.Distance.COSINE,
        ),
        hnsw_config=models.HnswConfigDiff(
            payload_m=16,
            m=0,
        ),
    )
    client.create_payload_index(
        collection_name=collection_name,
        field_name="workspace_id",
        field_schema=models.PayloadSchemaType.KEYWORD,
    )
    print(f"  Collection '{collection_name}' created with workspace_id index.")
    return True


def migrate_namespace(client: QdrantClient, namespace: str, vdb_file: Path) -> tuple[int, int]:
    collection_name = f"lightrag_vdb_{namespace}"
    print(f"\n{'='*60}")
    print(f"Migrating namespace: {namespace}")
    print(f"  Source file : {vdb_file}")
    print(f"  File size   : {vdb_file.stat().st_size / 1e6:.1f} MB")
    print(f"  Collection  : {collection_name}")

    # Load JSON
    print(f"  Loading JSON...", flush=True)
    t0 = time.time()
    with open(vdb_file) as f:
        db = json.load(f)
    print(f"  Loaded in {time.time() - t0:.1f}s")

    data = db["data"]
    embedding_dim = db["embedding_dim"]
    assert embedding_dim == EMBEDDING_DIM, \
        f"Expected dim={EMBEDDING_DIM}, got {embedding_dim} in {vdb_file.name}"

    # Decode base64 matrix → float32 array [N, D]
    print(f"  Decoding matrix ({len(data)} vectors × {embedding_dim}d)...", flush=True)
    matrix_bytes = base64.b64decode(db["matrix"])
    matrix = np.frombuffer(matrix_bytes, dtype=np.float32).reshape(len(data), embedding_dim)
    print(f"  Matrix shape: {matrix.shape}")

    ensure_collection(client, collection_name)

    # Upsert in batches
    meta_fields = META_FIELDS[namespace]
    total = len(data)
    n_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    inserted = 0
    t_start = time.time()

    print(f"  Upserting {total} points in batches of {BATCH_SIZE}...", flush=True)
    for b in range(n_batches):
        start = b * BATCH_SIZE
        end   = min(start + BATCH_SIZE, total)
        batch_data = data[start:end]
        batch_vecs = matrix[start:end]

        points = []
        for i, record in enumerate(batch_data):
            raw_id   = record["__id__"]
            point_id = compute_mdhash_id_for_qdrant(raw_id, prefix=WORKSPACE)
            payload  = {
                "id":           raw_id,
                "workspace_id": WORKSPACE,
                "created_at":   record.get("__created_at__", int(time.time())),
            }
            for field in meta_fields:
                if field in record:
                    payload[field] = record[field]
            points.append(models.PointStruct(
                id=point_id,
                vector=batch_vecs[i].tolist(),
                payload=payload,
            ))

        client.upsert(collection_name=collection_name, points=points, wait=True)
        inserted += len(points)

        if (b + 1) % 10 == 0 or b == n_batches - 1:
            elapsed = time.time() - t_start
            rate = inserted / elapsed if elapsed > 0 else 0
            print(f"  [{b+1}/{n_batches}] {inserted}/{total} points  ({rate:.0f} pts/s)", flush=True)

    # Verify count
    info = client.get_collection(collection_name)
    qdrant_count = info.points_count
    status = "OK" if qdrant_count == total else f"MISMATCH"
    print(f"  Result: NanoVDB={total}  Qdrant={qdrant_count}  [{status}]")
    return total, qdrant_count


def main():
    print(f"NanoVectorDB → Qdrant migration")
    print(f"  Storage dir : {STORAGE_DIR}")
    print(f"  Qdrant URL  : {QDRANT_URL}")
    print(f"  Workspace   : {WORKSPACE!r}")

    client = QdrantClient(url=QDRANT_URL)

    # Wait for Qdrant
    for attempt in range(30):
        try:
            client.get_collections()
            print(f"Qdrant is ready.\n")
            break
        except Exception as e:
            print(f"Waiting for Qdrant ({attempt+1}/30): {e}", flush=True)
            time.sleep(2)
    else:
        print("ERROR: Qdrant not reachable after 60s", file=sys.stderr)
        sys.exit(1)

    namespaces = [
        ("chunks",        STORAGE_DIR / "vdb_chunks.json"),
        ("entities",      STORAGE_DIR / "vdb_entities.json"),
        ("relationships", STORAGE_DIR / "vdb_relationships.json"),
    ]

    results = {}
    for namespace, vdb_file in namespaces:
        if not vdb_file.exists():
            print(f"WARNING: {vdb_file.name} not found — skipping {namespace}", file=sys.stderr)
            continue
        nano_count, qdrant_count = migrate_namespace(client, namespace, vdb_file)
        results[namespace] = (nano_count, qdrant_count)

    print(f"\n{'='*60}")
    print("Migration summary:")
    all_ok = True
    for ns, (n, q) in results.items():
        status = "OK" if n == q else f"MISMATCH (NanoVDB={n} Qdrant={q})"
        print(f"  {ns:15s}: {n:6d} → {q:6d}  [{status}]")
        if n != q:
            all_ok = False

    if all_ok:
        print("\nAll counts match. Migration successful!")
        sys.exit(0)
    else:
        print("\nERROR: Count mismatches — check the output above.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
