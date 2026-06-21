"""
reembed_missing.py — Re-embed chunks for docs missing from Qdrant.

Reads kv_store_doc_status to find processed docs, scrolls Qdrant to find
which are already covered, then re-embeds chunks for the missing ones using
the local Qwen3-Embedding-8B model and upserts into Qdrant.

Usage:
    python reembed_missing.py [--dry-run]

Env vars (with defaults):
    WORKDIR=/scratch/devon7y/westbury_rag
    STORAGE_SUBDIR=rag_storage_westbury_qwen3_32b
    QDRANT_URL=http://localhost:6333
    BATCH_SIZE=64
"""

import argparse
import hashlib
import json
import os
import uuid
from pathlib import Path

import numpy as np
import torch
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams
from sentence_transformers import SentenceTransformer

WORKDIR       = Path(os.environ.get("WORKDIR", "/scratch/devon7y/westbury_rag"))
STORAGE_SUBDIR = os.environ.get("STORAGE_SUBDIR", "rag_storage_westbury_qwen3_32b")
STORAGE       = WORKDIR / STORAGE_SUBDIR
QDRANT_URL    = os.environ.get("QDRANT_URL", "http://localhost:6333")
BATCH_SIZE    = int(os.environ.get("BATCH_SIZE", 64))
# Must match pipeline/ingest.py exactly (same model + dtype, documents embedded
# with NO instruction) so re-embedded vectors land in the same space.
MODEL_ID      = os.environ.get("EMBED_MODEL_ID", "Qwen/Qwen3-Embedding-8B")
EMBED_TORCH_DTYPE = os.environ.get("EMBED_TORCH_DTYPE", "bfloat16")
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", 4096))
CHUNKS_COL    = "lightrag_vdb_chunks"


def _resolve_model_path(model_id: str) -> str:
    """Prefer a local HF snapshot (offline compute nodes) else the hub id."""
    hub = WORKDIR / "hf_cache" / "hub" / f"models--{model_id.replace('/', '--')}"
    refs = hub / "refs" / "main"
    if refs.exists():
        snap = hub / "snapshots" / refs.read_text().strip()
        if snap.exists():
            return str(snap)
    return model_id


def make_uid(eid: str) -> str:
    return uuid.UUID(bytes=hashlib.sha256(eid.encode()).digest()[:16], version=4).hex


def main(dry_run: bool = False):
    # 1. Load processed doc IDs
    print("Loading kv_store_doc_status...", flush=True)
    status = json.loads((STORAGE / "kv_store_doc_status.json").read_text(encoding="utf-8"))
    processed_docs = {k for k, v in status.items() if isinstance(v, dict) and v.get("status") == "processed"}
    print(f"  Processed docs: {len(processed_docs)}", flush=True)

    # 2. Find docs already in Qdrant chunks collection
    client = QdrantClient(url=QDRANT_URL)
    if not client.collection_exists(CHUNKS_COL):
        print(f"  Collection {CHUNKS_COL} not found — will create it.", flush=True)
        qdrant_docs = set()
    else:
        info = client.get_collection(CHUNKS_COL)
        print(f"  Qdrant {CHUNKS_COL}: {info.points_count} points", flush=True)
        qdrant_docs = set()
        offset = None
        n = 0
        while True:
            results, offset = client.scroll(
                collection_name=CHUNKS_COL, limit=1000, offset=offset,
                with_payload=True, with_vectors=False
            )
            for pt in results:
                fid = pt.payload.get("full_doc_id")
                if fid:
                    qdrant_docs.add(fid)
            n += len(results)
            print(f"  Scrolled {n} chunks, {len(qdrant_docs)} unique docs...", end="\r", flush=True)
            if offset is None:
                break
        print(f"\n  Found {len(qdrant_docs)} docs already in Qdrant.", flush=True)

    missing_docs = processed_docs - qdrant_docs
    print(f"  Missing from Qdrant: {len(missing_docs)}", flush=True)

    if not missing_docs:
        print("Nothing to do!", flush=True)
        return

    if dry_run:
        print("Dry run — exiting without embedding.", flush=True)
        return

    # 3. Load text chunks for missing docs
    print("\nLoading kv_store_text_chunks...", flush=True)
    text_chunks = json.loads((STORAGE / "kv_store_text_chunks.json").read_text(encoding="utf-8"))
    print(f"  Total chunks: {len(text_chunks)}", flush=True)

    chunks_to_embed = [
        v for v in text_chunks.values()
        if isinstance(v, dict) and v.get("full_doc_id") in missing_docs and v.get("content")
    ]
    print(f"  Chunks to embed: {len(chunks_to_embed)}", flush=True)

    if not chunks_to_embed:
        print("No chunks found for missing docs — they may lack text in kv_store.", flush=True)
        return

    # 4. Load model — bf16 to match ingest's canonical document embeddings
    print(f"\nLoading {MODEL_ID} on cuda ({EMBED_TORCH_DTYPE})...", flush=True)
    model = SentenceTransformer(
        _resolve_model_path(MODEL_ID),
        device="cuda",
        model_kwargs={"torch_dtype": getattr(torch, EMBED_TORCH_DTYPE)},
    )
    vram = round(torch.cuda.memory_allocated() / 1e9, 2)
    print(f"  Model ready. VRAM: {vram} GB", flush=True)

    # 5. Ensure collection exists
    if not client.collection_exists(CHUNKS_COL):
        client.create_collection(
            collection_name=CHUNKS_COL,
            vectors_config=VectorParams(size=EMBEDDING_DIM, distance=Distance.COSINE),
        )
        print(f"  Created collection '{CHUNKS_COL}'", flush=True)

    # 6. Embed and upsert in batches
    print(f"\nEmbedding and upserting {len(chunks_to_embed)} chunks...", flush=True)
    total = 0
    for i in range(0, len(chunks_to_embed), BATCH_SIZE):
        batch = chunks_to_embed[i:i + BATCH_SIZE]
        texts = [c["content"] for c in batch]  # documents: no Qwen3 instruction

        vectors = model.encode(
            texts,
            normalize_embeddings=True,
            batch_size=BATCH_SIZE,
            show_progress_bar=False,
        )

        points = [
            PointStruct(
                id=make_uid(c["_id"]),
                vector=vectors[j].tolist(),
                payload={
                    "full_doc_id": c["full_doc_id"],
                    "content": c["content"],
                    "file_path": c.get("file_path", ""),
                    "__id__": c["_id"],
                },
            )
            for j, c in enumerate(batch)
        ]
        client.upsert(collection_name=CHUNKS_COL, points=points, wait=True)
        total += len(batch)
        print(f"  {total}/{len(chunks_to_embed)} upserted...", end="\r", flush=True)

    print(f"\n  Done. {total} chunks embedded and upserted.", flush=True)
    final = client.count(CHUNKS_COL).count
    print(f"  {CHUNKS_COL} now has {final} total points.", flush=True)

    # 7. Verify coverage
    qdrant_docs_after = set()
    offset = None
    while True:
        results, offset = client.scroll(
            collection_name=CHUNKS_COL, limit=1000, offset=offset,
            with_payload=True, with_vectors=False
        )
        for pt in results:
            fid = pt.payload.get("full_doc_id")
            if fid:
                qdrant_docs_after.add(fid)
        if offset is None:
            break

    still_missing = processed_docs - qdrant_docs_after
    print(f"\n=== Final coverage ===", flush=True)
    print(f"  Docs in Qdrant: {len(qdrant_docs_after)}", flush=True)
    print(f"  Still missing:  {len(still_missing)}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    main(dry_run=args.dry_run)
