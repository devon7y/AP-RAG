"""
migrate_to_qdrant.py -- Migrate NanoVectorDB JSON files to Qdrant

Reads vectors directly from LightRAG's NanoVectorDB JSON files (no re-embedding)
and inserts them into Qdrant collections using streaming JSON parsing to avoid
loading large files into memory.

Usage (run on the PC):
    C:\\rag_server\\venv\\Scripts\\python migrate_to_qdrant.py

Env overrides:
    STORAGE_DIR=C:\\rag_server\\rag_storage_westbury_qwen3_32b
    QDRANT_URL=http://localhost:6333
"""

import argparse
import base64
import hashlib
import os
import uuid
import zlib
from pathlib import Path

import ijson
import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

# ── Config ────────────────────────────────────────────────────────────────────

STORAGE_DIR   = Path(os.environ.get("STORAGE_DIR", r"C:\rag_server\rag_storage_westbury_qwen3_32b"))
QDRANT_URL    = os.environ.get("QDRANT_URL", "http://localhost:6333")
EMBEDDING_DIM = 4096
BATCH_SIZE    = 256

VDB_FILES = {
    "vdb_entities.json":      "lightrag_vdb_entities",
    "vdb_relationships.json": "lightrag_vdb_relationships",
    "vdb_chunks.json":        "lightrag_vdb_chunks",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def decode_vector(encoded: str) -> list[float]:
    """Decode base64+zlib+float16 vector stored by NanoVectorDB."""
    buf = zlib.decompress(base64.b64decode(encoded))
    return np.frombuffer(buf, dtype=np.float16).astype(np.float32).tolist()


def make_uid(eid: str) -> str:
    return uuid.UUID(bytes=hashlib.sha256(eid.encode()).digest()[:16], version=4).hex


def migrate_collection(client: QdrantClient, json_path: Path, collection: str):
    print(f"\n{'-'*60}")
    print(f"Migrating: {json_path.name} -> {collection}")

    if not json_path.exists():
        print(f"  SKIP: file not found")
        return

    if client.collection_exists(collection):
        existing = client.count(collection_name=collection).count
        print(f"  Collection exists with {existing} points -- upserting (idempotent)")
    else:
        client.create_collection(
            collection_name=collection,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
        print(f"  Created collection '{collection}'")

    # Stream-parse JSON so we never load the full file into RAM
    print(f"  Streaming {json_path.name}...", flush=True)
    inserted = 0
    batch = []

    with open(json_path, "rb") as f:
        for entry in ijson.items(f, "data.item"):
            eid = entry["__id__"]
            payload = {k: v for k, v in entry.items() if k != "vector"}
            payload["workspace_id"] = "_"
            vector = decode_vector(entry["vector"])
            batch.append(PointStruct(id=make_uid(eid), vector=vector, payload=payload))

            if len(batch) >= BATCH_SIZE:
                client.upsert(collection_name=collection, points=batch, wait=True)
                inserted += len(batch)
                print(f"  {inserted} inserted...", end="\r", flush=True)
                batch = []

    if batch:
        client.upsert(collection_name=collection, points=batch, wait=True)
        inserted += len(batch)

    final_count = client.count(collection_name=collection).count
    print(f"  Done. {inserted} inserted, {final_count} total.        ")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="+", choices=["entities", "relationships", "chunks"],
                        help="Only migrate specified collections")
    args = parser.parse_args()

    key_map = {"entities": "vdb_entities.json", "relationships": "vdb_relationships.json", "chunks": "vdb_chunks.json"}

    print(f"Qdrant URL  : {QDRANT_URL}")
    print(f"Storage dir : {STORAGE_DIR}")

    client = QdrantClient(url=QDRANT_URL)
    collections = [c.name for c in client.get_collections().collections]
    print(f"Existing collections: {collections}\n")

    for filename, collection in VDB_FILES.items():
        if args.only and not any(key_map[k] == filename for k in args.only):
            print(f"\n  SKIP: {filename} (not in --only list)")
            continue
        migrate_collection(client, STORAGE_DIR / filename, collection)

    print("\n" + "="*60)
    print("Migration complete.")
    for collection in VDB_FILES.values():
        if client.collection_exists(collection):
            count = client.count(collection_name=collection).count
            print(f"  {collection}: {count} points")


if __name__ == "__main__":
    main()
