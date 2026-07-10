"""
reembed_chunks_hpc.py — re-embed ALL text chunks with full-precision (bf16)
Qwen3-Embedding-8B on an HPC GPU, writing fp16 vector shards for the PC.

Why: the per-cycle Qdrant sidecar sync lost most in-ingest chunk vectors
(SCALING_ISSUES.md §3.11), and a PC-side fill would have produced 4-bit-model
document vectors. This job rebuilds the complete, canonical chunk-vector set
with the same model/dtype/settings as ingest (bf16, NO instruction for
documents, normalize_embeddings=True, max_seq 4096) and stores the output as
IEEE fp16 — value-preserving for bf16-computed, L2-normalized embeddings
(fp16 has more mantissa bits than bf16; all values are in [-1, 1]) — so the PC
can bulk-load a Qdrant collection created with datatype float16.

Output (in $OUT_DIR):
    chunk_ids.json          — list of chunk ids, aligned with vector rows
    vectors_fp16.npy        — float16 array [n_chunks, 4096]
    payloads.jsonl          — one JSON per chunk: full_doc_id, content, file_path
    REEMBED_DONE            — marker with counts + throughput

Env:
    STORAGE_DIR   — dir containing kv_store_text_chunks.json
    OUT_DIR       — output dir
    EMBED_MODEL_ID (default Qwen/Qwen3-Embedding-8B), EMBED_TORCH_DTYPE (bfloat16)
    EMBED_BATCH   (default 64), EMBED_MAX_SEQ (default 4096)
"""

import json
import os
import time
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

STORAGE_DIR = Path(os.environ["STORAGE_DIR"])
OUT_DIR = Path(os.environ["OUT_DIR"])
MODEL_ID = os.environ.get("EMBED_MODEL_ID", "Qwen/Qwen3-Embedding-8B")
DTYPE = os.environ.get("EMBED_TORCH_DTYPE", "bfloat16")
BATCH = int(os.environ.get("EMBED_BATCH", 64))
MAX_SEQ = int(os.environ.get("EMBED_MAX_SEQ", 4096))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    src = STORAGE_DIR / "kv_store_text_chunks.json"
    t0 = time.time()
    data = json.loads(src.read_text(encoding="utf-8"))
    ids = list(data.keys())
    print(f"loaded {len(ids)} chunks in {time.time() - t0:.0f}s", flush=True)

    print(f"loading {MODEL_ID} ({DTYPE})…", flush=True)
    model = SentenceTransformer(
        MODEL_ID, device="cuda",
        model_kwargs={"torch_dtype": getattr(torch, DTYPE)},
    )
    if MAX_SEQ > 0 and (model.max_seq_length or 0) > MAX_SEQ:
        model.max_seq_length = MAX_SEQ
    print("model ready", flush=True)

    n = len(ids)
    out = np.empty((n, 4096), dtype=np.float16)
    t0 = time.time()
    for i in range(0, n, BATCH):
        batch_ids = ids[i : i + BATCH]
        texts = [data[k]["content"] for k in batch_ids]
        # Documents get NO instruction — identical to pipeline/ingest.py.
        vecs = model.encode(
            texts, batch_size=BATCH, normalize_embeddings=True,
            convert_to_numpy=True, show_progress_bar=False,
        )
        out[i : i + len(batch_ids)] = vecs.astype(np.float16)
        if (i // BATCH) % 50 == 0:
            rate = (i + len(batch_ids)) / max(time.time() - t0, 1e-9)
            print(f"[embed] {i + len(batch_ids)}/{n} ({rate:.0f} chunks/s, "
                  f"eta {(n - i) / max(rate, 1e-9) / 60:.0f} min)", flush=True)
    rate = n / max(time.time() - t0, 1e-9)
    print(f"[embed] DONE {n} in {time.time() - t0:.0f}s ({rate:.0f} chunks/s)", flush=True)

    np.save(OUT_DIR / "vectors_fp16.npy", out)
    (OUT_DIR / "chunk_ids.json").write_text(json.dumps(ids))
    with (OUT_DIR / "payloads.jsonl").open("w", encoding="utf-8") as f:
        for k in ids:
            v = data[k]
            f.write(json.dumps({
                "id": k,
                "full_doc_id": v.get("full_doc_id", ""),
                "content": v.get("content", ""),
                "file_path": v.get("file_path", ""),
            }) + "\n")
    (OUT_DIR / "REEMBED_DONE").write_text(
        f"chunks={n} rate={rate:.0f}/s model={MODEL_ID} dtype={DTYPE} "
        f"max_seq={MAX_SEQ} normalized=true instruction=none\n")
    print("ALL OUTPUT WRITTEN", flush=True)


if __name__ == "__main__":
    main()
