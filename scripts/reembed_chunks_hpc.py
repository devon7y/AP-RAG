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
    chunk_ids.json          — list of chunk ids, aligned with concatenated shard rows
    vectors_fp16_NNN.npy    — float16 shards [<=SHARD, 4096], NNN = shard index
    payloads.jsonl          — one JSON per chunk: full_doc_id, content, file_path
    REEMBED_DONE            — marker with counts + throughput

RESUMABLE: completed shards are skipped on rerun (chunk order is the source
file's key order, which is deterministic for an identical input file), so a
walltime kill costs at most one shard of work. Measured H100 throughput is
~20 chunks/s (tokenize + 8B forward + normalize), i.e. ~2.5 h for 178K chunks
— size walltimes accordingly, not from FLOPs optimism.

Env:
    STORAGE_DIR   — dir containing kv_store_text_chunks.json
    OUT_DIR       — output dir
    EMBED_MODEL_ID (default Qwen/Qwen3-Embedding-8B), EMBED_TORCH_DTYPE (bfloat16)
    EMBED_BATCH   (default 64), EMBED_MAX_SEQ (default 4096), SHARD (default 16000)
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
SHARD = int(os.environ.get("SHARD", 16000))


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    src = STORAGE_DIR / "kv_store_text_chunks.json"
    t0 = time.time()
    data = json.loads(src.read_text(encoding="utf-8"))
    ids = list(data.keys())
    n = len(ids)
    print(f"loaded {n} chunks in {time.time() - t0:.0f}s", flush=True)

    n_shards = (n + SHARD - 1) // SHARD
    todo = [s for s in range(n_shards)
            if not (OUT_DIR / f"vectors_fp16_{s:03d}.npy").exists()]
    print(f"shards: {n_shards} total, {len(todo)} to embed "
          f"({n_shards - len(todo)} already done)", flush=True)

    if todo:
        print(f"loading {MODEL_ID} ({DTYPE})…", flush=True)
        model = SentenceTransformer(
            MODEL_ID, device="cuda",
            model_kwargs={"torch_dtype": getattr(torch, DTYPE)},
        )
        if MAX_SEQ > 0 and (model.max_seq_length or 0) > MAX_SEQ:
            model.max_seq_length = MAX_SEQ
        print("model ready", flush=True)

    t0 = time.time()
    done_chunks = 0
    for s in todo:
        lo, hi = s * SHARD, min((s + 1) * SHARD, n)
        out = np.empty((hi - lo, 4096), dtype=np.float16)
        for i in range(lo, hi, BATCH):
            batch_ids = ids[i : min(i + BATCH, hi)]
            texts = [data[k]["content"] for k in batch_ids]
            # Documents get NO instruction — identical to pipeline/ingest.py.
            vecs = model.encode(
                texts, batch_size=BATCH, normalize_embeddings=True,
                convert_to_numpy=True, show_progress_bar=False,
            )
            out[i - lo : i - lo + len(batch_ids)] = vecs.astype(np.float16)
            done_chunks += len(batch_ids)
            if (i // BATCH) % 50 == 0:
                rate = done_chunks / max(time.time() - t0, 1e-9)
                remaining = sum(min((x + 1) * SHARD, n) - x * SHARD for x in todo) - done_chunks
                print(f"[embed] shard {s}: {i + len(batch_ids)}/{n} overall "
                      f"({rate:.0f} chunks/s, eta {remaining / max(rate, 1e-9) / 60:.0f} min)",
                      flush=True)
        # write-then-rename so a mid-write kill can't leave a corrupt shard that
        # would pass the exists() resume check (np.save on a file OBJECT does
        # not append .npy to the name)
        tmp = OUT_DIR / f"vectors_fp16_{s:03d}.npy.tmp"
        with tmp.open("wb") as fh:
            np.save(fh, out)
        tmp.rename(OUT_DIR / f"vectors_fp16_{s:03d}.npy")
        print(f"[embed] shard {s:03d} written ({hi - lo} rows)", flush=True)
    rate = done_chunks / max(time.time() - t0, 1e-9) if todo else 0.0
    print(f"[embed] DONE {done_chunks} new chunks in {time.time() - t0:.0f}s "
          f"({rate:.0f} chunks/s)", flush=True)

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
    # final integrity check: every shard present with the right row count
    total = 0
    for s in range(n_shards):
        arr = np.load(OUT_DIR / f"vectors_fp16_{s:03d}.npy", mmap_mode="r")
        total += arr.shape[0]
    assert total == n, f"shard rows {total} != {n} chunks"
    (OUT_DIR / "REEMBED_DONE").write_text(
        f"chunks={n} shards={n_shards} rate={rate:.0f}/s model={MODEL_ID} "
        f"dtype={DTYPE} max_seq={MAX_SEQ} normalized=true instruction=none\n")
    print("ALL OUTPUT WRITTEN", flush=True)


if __name__ == "__main__":
    main()
