#!/usr/bin/env python3
"""A/B repro for the ingest segfault (at::native::run_cudnn_SDP_fprop NULL-deref).

Core-dump evidence (Trillium jobs 667377/667466/670200/670469, identical IP
libtorch_cuda.so+0x74D2B8 on H100 AND H200):
  #0 at::native::run_cudnn_SDP_fprop        <- mov 0x228(%r14), %r14 == NULL
  #1 at::native::_cudnn_attention_forward
  ...
  #11 THPVariable_scaled_dot_product_attention   (the embedder forward)
i.e. torch's cuDNN SDPA backend dereferences a null cuDNN graph/handle for the
attention shapes produced by certain documents' chunk batches.

This script embeds the REAL chunks of the crashing docs exactly like
pipeline.ingest does (same extractor+chunker via the pdf_extract subprocess,
same SentenceTransformer config, same batching), under two modes:

  default  — torch SDPA backends as shipped   -> expected: SIGSEGV (repro)
  nocudnn  — torch.backends.cuda.enable_cudnn_sdp(False) -> expected: SUCCESS

Usage: repro_sdpa_crash.py <default|nocudnn> <pdf-name> [<pdf-name> ...]
Env:   WORKDIR (papers at $WORKDIR/papers_full), HF_HOME, EMBED_MODEL_ID,
       CHUNK_* (chunker settings), EMBED_BATCH (micro-batch, default 32).
"""
import faulthandler
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

faulthandler.enable()  # print all-thread Python stacks even on SIGSEGV

MODE = sys.argv[1]
PDFS = sys.argv[2:]
assert MODE in ("default", "nocudnn"), f"bad mode {MODE!r}"

WORKDIR = Path(os.environ["WORKDIR"])
PAPERS = WORKDIR / os.environ.get("PAPERS_SUBDIR", "papers_full")
EMBED_MODEL_ID = os.environ.get("EMBED_MODEL_ID", "Qwen/Qwen3-Embedding-8B")
EMBED_BATCH = int(os.environ.get("EMBED_BATCH", 32))
GROUP = int(os.environ.get("EMBEDDING_BATCH_NUM", 128))  # texts per encode() call, like LightRAG
MAX_SEQ = int(os.environ.get("EMBED_MAX_SEQ", 4096))


def extract_chunks(pdf: Path) -> list[str]:
    """Run the SAME extraction+chunking subprocess the ingest uses."""
    fd, out_name = tempfile.mkstemp(suffix=".pdftxt")
    os.close(fd)
    out_path, chunks_path = Path(out_name), Path(out_name + ".chunks")
    env = dict(os.environ, CHUNK_IN_EXTRACT="1")
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "pipeline.pdf_extract", str(pdf), out_name],
            capture_output=True, text=True, timeout=600, env=env,
        )
        print(f"[extract] {pdf.name}: rc={proc.returncode}", flush=True)
        if proc.returncode != 0:
            print((proc.stdout or "") + (proc.stderr or ""), flush=True)
            return []
        raw = json.loads(chunks_path.read_text(encoding="utf-8")) if chunks_path.exists() else []
        chunks: list[str] = []
        items = raw.get("chunks", raw) if isinstance(raw, dict) else raw
        for it in items:
            if isinstance(it, str):
                chunks.append(it)
            elif isinstance(it, dict):
                chunks.append(it.get("content") or it.get("text") or "")
        chunks = [c for c in chunks if c is not None]
        print(f"[extract] {pdf.name}: {len(chunks)} chunks "
              f"(chars min={min((len(c) for c in chunks), default=0)} "
              f"max={max((len(c) for c in chunks), default=0)}, "
              f"empty={sum(1 for c in chunks if not c.strip())})", flush=True)
        return chunks
    finally:
        out_path.unlink(missing_ok=True)
        chunks_path.unlink(missing_ok=True)


def main() -> None:
    all_chunks: list[str] = []
    for name in PDFS:
        pdf = PAPERS / name
        if not pdf.exists():
            print(f"[skip] {pdf} not found", flush=True)
            continue
        all_chunks.extend(extract_chunks(pdf))
    if not all_chunks:
        sys.exit("no chunks extracted — nothing to test")

    import torch
    from sentence_transformers import SentenceTransformer

    if MODE == "nocudnn":
        torch.backends.cuda.enable_cudnn_sdp(False)
    print(f"[mode {MODE}] SDPA backends: flash={torch.backends.cuda.flash_sdp_enabled()} "
          f"mem_efficient={torch.backends.cuda.mem_efficient_sdp_enabled()} "
          f"math={torch.backends.cuda.math_sdp_enabled()} "
          f"cudnn={torch.backends.cuda.cudnn_sdp_enabled()}", flush=True)

    hub = Path(os.environ["HF_HOME"]) / "hub" / f"models--{EMBED_MODEL_ID.replace('/', '--')}"
    commit = (hub / "refs" / "main").read_text().strip()
    model = SentenceTransformer(str(hub / "snapshots" / commit), device="cuda",
                                model_kwargs={"torch_dtype": torch.bfloat16})
    model.max_seq_length = MAX_SEQ

    tok = model.tokenizer
    lens = [len(tok(c, add_special_tokens=True)["input_ids"]) for c in all_chunks]
    print(f"[tokens] n={len(lens)} min={min(lens)} max={max(lens)} "
          f"@cap={sum(1 for L in lens if L >= MAX_SEQ)} <=2tok={sum(1 for L in lens if L <= 2)}",
          flush=True)

    for i in range(0, len(all_chunks), GROUP):
        grp = all_chunks[i:i + GROUP]
        glens = lens[i:i + GROUP]
        print(f"[encode] group {i//GROUP}: {len(grp)} texts, tok min={min(glens)} "
              f"max={max(glens)}, micro-batch={EMBED_BATCH}", flush=True)
        model.encode(grp, normalize_embeddings=True, batch_size=EMBED_BATCH,
                     show_progress_bar=False)
    print(f"[mode {MODE}] SUCCESS — all {len(all_chunks)} chunks embedded, no crash",
          flush=True)


if __name__ == "__main__":
    main()
