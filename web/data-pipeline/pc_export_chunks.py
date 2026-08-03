"""Export the full chunk corpus from the PC's Qdrant, PCA-reduced for transfer.

Runs ON the PC (read-only against Qdrant; it never touches query_server). The
full corpus is ~445k chunks x 4096 dims = 7.3 GB of float32, which is both a
painful transfer and more than the atlas pipeline needs: UMAP and HDBSCAN work
just as well on a PCA projection. So this streams Qdrant to a local memmap,
fits PCA on a strided subsample, and writes only the reduced matrix.

Writes into --out (default C:\\rag_server\\atlas_export):
  chunk_pca.npy    float32 [N, DIM]  PCA-reduced chunk vectors
  chunk_meta.jsonl one JSON object per line: {qid, chunk_id, file_path, content}
  export_info.json {n, dim, explained_variance, collection}

Usage (on the PC):
  C:\\rag_server\\venv\\Scripts\\python pc_export_chunks.py
"""

import argparse
import json
import time
import urllib.request
from pathlib import Path

import numpy as np

QDRANT = "http://127.0.0.1:6333"
COLL = "lightrag_vdb_chunks"
BATCH = 512
DIM = 128           # PCA target — plenty for UMAP structure
FIT_SAMPLE = 40000  # vectors used to fit the PCA basis
CONTENT_CHARS = 900


def post(path: str, body: dict, timeout: int = 300) -> dict:
    req = urllib.request.Request(
        QDRANT + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def get(path: str, timeout: int = 60) -> dict:
    with urllib.request.urlopen(QDRANT + path, timeout=timeout) as r:
        return json.load(r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"C:\rag_server\atlas_export")
    ap.add_argument("--dim", type=int, default=DIM)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    info = get(f"/collections/{COLL}")["result"]
    n = int(info["points_count"])
    src_dim = int(info["config"]["params"]["vectors"]["size"])
    print(f"collection {COLL}: {n} points x {src_dim} dims", flush=True)

    raw_path = out / "_raw_vectors.f32"
    raw = np.memmap(raw_path, dtype=np.float32, mode="w+", shape=(n, src_dim))

    meta_f = (out / "chunk_meta.jsonl").open("w", encoding="utf-8")
    offset = None
    i = 0
    t0 = time.time()
    while True:
        body = {"limit": BATCH, "with_payload": True, "with_vector": True}
        if offset is not None:
            body["offset"] = offset
        res = post(f"/collections/{COLL}/points/scroll", body)["result"]
        pts = res["points"]
        if not pts:
            break
        for p in pts:
            if i >= n:
                break
            v = p.get("vector")
            if isinstance(v, dict):  # named vectors
                v = next(iter(v.values()))
            raw[i] = np.asarray(v, dtype=np.float32)
            pl = p.get("payload") or {}
            meta_f.write(
                json.dumps(
                    {
                        "qid": str(p["id"]),
                        "chunk_id": pl.get("id") or "",
                        "file_path": pl.get("file_path") or "",
                        "content": (pl.get("content") or "")[:CONTENT_CHARS],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            i += 1
        offset = res.get("next_page_offset")
        if i % (BATCH * 20) == 0 or offset is None:
            el = time.time() - t0
            rate = i / max(el, 1e-6)
            print(f"  {i}/{n} points  {rate:.0f}/s  eta {(n - i) / max(rate, 1e-6) / 60:.1f}m",
                  flush=True)
        if offset is None:
            break
    meta_f.close()
    n = i
    print(f"scrolled {n} points in {(time.time() - t0)/60:.1f} min", flush=True)
    raw.flush()

    # L2-normalize (cosine space) then PCA on a strided subsample
    from sklearn.decomposition import PCA

    step = max(1, n // FIT_SAMPLE)
    sample = np.asarray(raw[::step][:FIT_SAMPLE], dtype=np.float32)
    sample /= np.linalg.norm(sample, axis=1, keepdims=True) + 1e-9
    print(f"fitting PCA({args.dim}) on {sample.shape[0]} vectors...", flush=True)
    pca = PCA(n_components=args.dim, svd_solver="randomized", random_state=42)
    pca.fit(sample)
    ev = float(pca.explained_variance_ratio_.sum())
    print(f"explained variance: {ev:.3f}", flush=True)
    del sample

    red = np.empty((n, args.dim), dtype=np.float32)
    BLK = 20000
    for s in range(0, n, BLK):
        e = min(n, s + BLK)
        blk = np.asarray(raw[s:e], dtype=np.float32)
        blk /= np.linalg.norm(blk, axis=1, keepdims=True) + 1e-9
        red[s:e] = pca.transform(blk).astype(np.float32)
        print(f"  projected {e}/{n}", flush=True)
    np.save(out / "chunk_pca.npy", red)
    (out / "export_info.json").write_text(
        json.dumps(
            {"n": n, "dim": args.dim, "src_dim": src_dim,
             "explained_variance": ev, "collection": COLL}
        )
    )
    del raw
    raw_path.unlink(missing_ok=True)
    print(f"wrote {out/'chunk_pca.npy'} {red.shape} and chunk_meta.jsonl", flush=True)


if __name__ == "__main__":
    main()
