"""Atlas layout for the full corpus, computed on the HPC beside the data.

Replaces the local pipeline.py projection stages for the ~10.4k-paper / ~445k-chunk
corpus. Everything runs where the vectors already live, so the embeddings are used
at their native 4096 dimensions — no PCA, no transfer of 7.3 GB, and no question
about how much structure a projection threw away.

Inputs (all read-only, on Rorqual):
  --qdrant     a Qdrant HTTP endpoint serving qdrant_final (apptainer sidecar)
  --chunks-kv  kv_store_text_chunks.json   (section titles + page starts)
  --manifest   papers_metadata.json        (APA records for the paper table)

Outputs (--out, all small enough to rsync home):
  atlas_cols.npz   pos2/pos3/cluster/paper/year/docIdx/chunkNum  (packed to atlas.bin locally)
  doc_hashes.json  docIdx -> 32-hex doc hash, so the client can rebuild chunk ids
  papers.json      the paper table (title/authors/year/journal/doi/abstract/centroids)
  clusters.json    cluster stats + c-TF-IDF terms + sample titles (names added later)
  knn.npz          k-nearest-neighbour graph over chunks (the radio rover's map)
  heightmap.bin    512x512 float32 density
  voids.json       low-density sites for the research-gap tool

Stages checkpoint to --out, so a rerun after a walltime kill resumes rather than
repeating the expensive neighbour search.
"""

import argparse
import ast
import json
import re
import time
import urllib.request
from collections import Counter
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, label
from sklearn.feature_extraction.text import TfidfVectorizer

GRID = 512
KNN_K = 9          # 1 self + 8 neighbours, as the rover expects
UMAP_NEIGHBOURS = 30
TERM_SAMPLE = 4000  # chunks sampled per cluster for c-TF-IDF (full join is 400 MB+)
CHUNK_ID_RE = re.compile(r"^doc-([0-9a-f]{32})-chunk-(\d+)$")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def rf(x, nd=4):
    return round(float(x), nd)


# ── Qdrant scroll ─────────────────────────────────────────────────────────────


def scroll_chunks(qdrant: str, out: Path) -> tuple[np.ndarray, list[dict]]:
    """All chunk vectors (native dim) + payloads, checkpointed to disk."""
    vec_p, meta_p = out / "_vectors.npy", out / "_meta.jsonl"
    if vec_p.exists() and meta_p.exists():
        log("reusing checkpointed vectors")
        meta = [json.loads(l) for l in meta_p.open(encoding="utf-8")]
        return np.load(vec_p, mmap_mode="r"), meta

    def post(path, body):
        req = urllib.request.Request(
            qdrant + path, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.load(r)

    with urllib.request.urlopen(f"{qdrant}/collections/lightrag_vdb_chunks", timeout=60) as r:
        info = json.load(r)["result"]
    n = int(info["points_count"])
    dim = int(info["config"]["params"]["vectors"]["size"])
    log(f"scrolling {n} chunks x {dim} dims")

    vecs = np.lib.format.open_memmap(vec_p, mode="w+", dtype=np.float32, shape=(n, dim))
    meta: list[dict] = []
    offset, i, t0 = None, 0, time.time()
    with meta_p.open("w", encoding="utf-8") as mf:
        while True:
            body = {"limit": 512, "with_payload": True, "with_vector": True}
            if offset is not None:
                body["offset"] = offset
            res = post("/collections/lightrag_vdb_chunks/points/scroll", body)["result"]
            pts = res["points"]
            if not pts:
                break
            for p in pts:
                if i >= n:
                    break
                v = p.get("vector")
                if isinstance(v, dict):
                    v = next(iter(v.values()))
                vecs[i] = v
                pl = p.get("payload") or {}
                rec = {"qid": str(p["id"]), "chunk_id": pl.get("id") or "",
                       "file_path": pl.get("file_path") or "",
                       "content": (pl.get("content") or "")[:700]}
                meta.append(rec)
                mf.write(json.dumps(rec, ensure_ascii=False) + "\n")
                i += 1
            offset = res.get("next_page_offset")
            if i % 51200 == 0 or offset is None:
                el = max(time.time() - t0, 1e-6)
                log(f"  {i}/{n}  {i/el:.0f}/s  eta {(n-i)/(i/el)/60:.1f}m")
            if offset is None:
                break
    vecs.flush()
    log(f"scrolled {i} chunks in {(time.time()-t0)/60:.1f} min")
    return np.load(vec_p, mmap_mode="r"), meta


# ── neighbour graph at native dimensionality ─────────────────────────────────


def _knn_gpu(vecs, k: int):
    """Exact cosine kNN on one GPU, in tiles.

    At 4096 dimensions this is a matmul, which is what a GPU is for: the whole
    corpus is ~1.6 PFLOP of similarity, minutes of H100 time. It is also EXACT —
    pynndescent and HNSW both approximate, so this is faster *and* more faithful
    than the CPU paths below.
    """
    import torch

    n, d = vecs.shape
    dev = torch.device("cuda")
    log(f"GPU exact kNN: {n} x {d} on {torch.cuda.get_device_name(0)}")
    X = torch.from_numpy(np.asarray(vecs)).to(dev, dtype=torch.float16)
    X = torch.nn.functional.normalize(X, dim=1)
    Xt = X.T.contiguous()
    idx = np.zeros((n, k), dtype=np.int32)
    dist = np.zeros((n, k), dtype=np.float32)
    B, t0 = 2048, time.time()
    for s0 in range(0, n, B):
        q = X[s0:s0 + B]
        sim = (q @ Xt).float()          # (B, n) cosine — rows are unit-norm
        v, i = torch.topk(sim, k, dim=1)  # self ranks first at 1.0, as UMAP expects
        idx[s0:s0 + B] = i.cpu().numpy()
        dist[s0:s0 + B] = (1.0 - v).clamp(min=0).cpu().numpy()
        del sim, v, i
        if (s0 // B) % 40 == 0:
            done = min(s0 + B, n)
            el = max(time.time() - t0, 1e-6)
            log(f"  knn {done}/{n}  {done/el:.0f}/s  eta {(n-done)/(done/el)/60:.1f}m")
    del X, Xt
    torch.cuda.empty_cache()
    log(f"GPU kNN done in {(time.time()-t0)/60:.1f} min")
    return idx, dist


def _knn_from_qdrant(qdrant: str, qids: list[str], k: int, out: Path):
    """Neighbours from the HNSW index Qdrant has ALREADY built over these vectors.

    Querying by point id means no vector ever crosses the wire, and it reuses the
    same index that serves production search — far cheaper than having pynndescent
    rebuild a graph from scratch at 4096 dimensions.
    """
    import concurrent.futures as cf

    n = len(qids)
    pos = {q: i for i, q in enumerate(qids)}
    idx = np.zeros((n, k), dtype=np.int32)
    dist = np.zeros((n, k), dtype=np.float32)
    BATCH, WORKERS = 128, 16

    def run(s: int):
        e = min(n, s + BATCH)
        body = {"searches": [
            {"query": {"nearest": qids[i]}, "limit": k, "with_payload": False,
             "with_vector": False} for i in range(s, e)]}
        req = urllib.request.Request(
            f"{qdrant}/collections/lightrag_vdb_chunks/points/query/batch",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=600) as r:
            res = json.load(r)["result"]
        for off, group in enumerate(res):
            i = s + off
            # self first at distance 0, as pynndescent's neighbor_graph returns it
            row_i, row_d = [i], [0.0]
            for pt in group.get("points", []):
                j = pos.get(str(pt["id"]))
                if j is None or j == i:
                    continue
                row_i.append(j)
                row_d.append(max(0.0, 1.0 - float(pt.get("score") or 0.0)))
                if len(row_i) == k:
                    break
            while len(row_i) < k:      # pad degenerate rows with self
                row_i.append(i)
                row_d.append(0.0)
            idx[i] = row_i
            dist[i] = row_d
        return e - s

    t0, done = time.time(), 0
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(run, s) for s in range(0, n, BATCH)]
        for f in cf.as_completed(futs):
            done += f.result()
            if done % 51200 < BATCH:
                el = max(time.time() - t0, 1e-6)
                log(f"  knn {done}/{n}  {done/el:.0f}/s  eta {(n-done)/(done/el)/60:.1f}m")
    log(f"qdrant knn done in {(time.time()-t0)/60:.1f} min")
    return idx, dist


def neighbour_graph(vecs, out: Path, k: int, qdrant: str = "", qids=None):
    """kNN over the FULL-dimension vectors — the only thing UMAP consumes, so
    computing it at native width is what keeps the map faithful. Cached."""
    p = out / "_knn.npz"
    if p.exists():
        log("reusing checkpointed neighbour graph")
        z = np.load(p)
        return z["idx"], z["dist"]

    idx = dist = None
    try:
        import torch
        if torch.cuda.is_available():
            idx, dist = _knn_gpu(vecs, k)
    except Exception as exc:
        log(f"GPU knn unavailable ({exc!r}) — trying Qdrant")
        idx = dist = None
    if idx is None and qdrant and qids:
        try:
            log(f"neighbour graph from Qdrant HNSW (k={k}, {len(qids)} points)")
            idx, dist = _knn_from_qdrant(qdrant, qids, k, out)
        except Exception as exc:
            log(f"qdrant knn failed ({exc!r}) — falling back to pynndescent")
            idx = dist = None
    if idx is None:
        from pynndescent import NNDescent

        log(f"building neighbour graph with pynndescent (k={k}, dim={vecs.shape[1]})")
        t0 = time.time()
        index = NNDescent(np.asarray(vecs), n_neighbors=k, metric="cosine",
                          random_state=42, low_memory=True, verbose=True)
        idx, dist = index.neighbor_graph
        idx, dist = idx.astype(np.int32), dist.astype(np.float32)
        log(f"pynndescent done in {(time.time()-t0)/60:.1f} min")

    np.savez(p, idx=idx, dist=dist)
    return idx, dist


def project(vecs, knn, out: Path, dims: int, min_dist: float, tag: str) -> np.ndarray:
    p = out / f"_umap{tag}.npy"
    if p.exists():
        log(f"reusing checkpointed UMAP {tag}")
        return np.load(p)
    import umap

    log(f"UMAP -> {dims}D ({tag})")
    t0 = time.time()
    emb = umap.UMAP(n_components=dims, n_neighbors=UMAP_NEIGHBOURS, min_dist=min_dist,
                    metric="cosine", random_state=42, verbose=True,
                    precomputed_knn=knn).fit_transform(np.asarray(vecs))
    emb = np.asarray(emb, dtype=np.float32)
    np.save(p, emb)
    log(f"UMAP {tag} done in {(time.time()-t0)/60:.1f} min")
    return emb


def norm01(a: np.ndarray) -> np.ndarray:
    lo, hi = a.min(axis=0), a.max(axis=0)
    return ((a - lo) / (hi - lo + 1e-9)).astype(np.float32)


# ── main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant", default="http://127.0.0.1:6333")
    ap.add_argument("--chunks-kv", default=None,  # section titles now come
                    help="unused; passages are served by the PC at query time")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-cluster-size", type=int, default=1200)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    vecs, meta = scroll_chunks(args.qdrant, out)
    n = len(meta)

    # ── paper table ──────────────────────────────────────────────────────────
    manifest = json.loads(Path(args.manifest).read_text())
    files = sorted({m["file_path"] for m in meta})
    file_idx = {f: i for i, f in enumerate(files)}
    log(f"{n} chunks across {len(files)} papers")

    def _author_list(rec) -> list:
        """The manifest stores authors as a real LIST, not a repr of one.
        ast.literal_eval threw on every record, so every paper silently fell back
        to the first token of its filename — which is why bylines read as a bare
        surname. Accept both shapes."""
        v = rec.get("authors")
        if isinstance(v, list):
            return v
        if isinstance(v, str):
            try:
                return ast.literal_eval(v)
            except Exception:
                return []
        return []

    def _initials(given: str) -> str:
        return " ".join(f"{x[0]}." for x in re.split(r"[\s\-]+", (given or "").strip()) if x)

    def short_authors(rec) -> str:
        au = _author_list(rec)
        fams = [a.get("family", "") for a in au if isinstance(a, dict) and a.get("family")]
        if not fams:
            return ""
        if len(fams) == 1:
            return fams[0]
        if len(fams) == 2:
            return f"{fams[0]} & {fams[1]}"
        return f"{fams[0]} et al."

    papers = []
    for f in files:
        rec = manifest.get(f, {})
        m = re.search(r"(19|20)\d\d", str(rec.get("year", "")))
        year = int(m.group(0)) if m else 0
        if not year:
            m = re.search(r"(19|20)\d\d", f)
            year = int(m.group(0)) if m else 0
        papers.append({
            "file": f,
            "title": rec.get("title") or f.replace(".pdf", "").replace("_", " "),
            "authors": short_authors(rec) or f.split("_")[0],
            "year": year,
            "journal": rec.get("container_title", ""),
            "doi": rec.get("doi", ""),
            # trimmed vs the old pipeline: 10.4k abstracts ship to the browser
            "abstract": (rec.get("abstract") or "")[:320],
            # ordered APA names so a card can print the byline as printed
            "authorsFull": [
                f"{a['family']}, {_initials(a.get('given'))}".strip().rstrip(",")
                for a in _author_list(rec)
                if isinstance(a, dict) and a.get("family")
            ][:25],
        })

    paper_of = np.fromiter((file_idx[m["file_path"]] for m in meta), dtype=np.int32, count=n)
    year_of = np.asarray([papers[p]["year"] for p in paper_of], dtype=np.int16)

    # ── compact chunk ids: docIdx + chunkNum reconstruct the string client-side ─
    doc_hashes: list[str] = []
    doc_pos: dict[str, int] = {}
    doc_idx = np.zeros(n, dtype=np.int32)
    chunk_num = np.zeros(n, dtype=np.int32)
    bad = 0
    for i, m in enumerate(meta):
        mt = CHUNK_ID_RE.match(m["chunk_id"])
        if not mt:
            bad += 1
            doc_idx[i], chunk_num[i] = -1, -1
            continue
        h, num = mt.group(1), int(mt.group(2))
        j = doc_pos.get(h)
        if j is None:
            j = len(doc_hashes)
            doc_pos[h] = j
            doc_hashes.append(h)
        doc_idx[i], chunk_num[i] = j, num
    if bad:
        log(f"WARNING: {bad} chunk ids did not match the doc-<hash>-chunk-<n> form")
    # the client rebuilds ids with zero-padding to 3; verify that is lossless here
    pad_mismatch = sum(
        1 for i, m in enumerate(meta)
        if doc_idx[i] >= 0
        and f"doc-{doc_hashes[doc_idx[i]]}-chunk-{chunk_num[i]:03d}" != m["chunk_id"]
    )
    log(f"chunk-id round-trip mismatches: {pad_mismatch} (must be 0)")

    # ── projections ──────────────────────────────────────────────────────────
    knn_idx, knn_dist = neighbour_graph(
        vecs, out, UMAP_NEIGHBOURS, args.qdrant, [m['qid'] for m in meta])
    knn = (knn_idx, knn_dist)
    p2 = norm01(project(vecs, knn, out, 2, 0.08, "2d"))
    p3 = norm01(project(vecs, knn, out, 3, 0.15, "3d"))
    u8 = project(vecs, knn, out, 8, 0.0, "8d")

    # ── clustering ───────────────────────────────────────────────────────────
    from sklearn.cluster import HDBSCAN

    log(f"HDBSCAN (min_cluster_size={args.min_cluster_size})")
    t0 = time.time()
    # no n_jobs: sklearn's process pool fails on this cluster's python build
    labels = HDBSCAN(min_cluster_size=args.min_cluster_size,
                     min_samples=25).fit_predict(u8.astype(np.float64))
    n_cl = int(labels.max()) + 1
    log(f"{n_cl} clusters, {(labels == -1).sum()} noise, {(time.time()-t0)/60:.1f} min")
    if n_cl < 2:
        raise SystemExit("clustering collapsed — lower --min-cluster-size and rerun")
    cent8 = np.stack([u8[labels == c].mean(axis=0) for c in range(n_cl)])
    noise = np.where(labels == -1)[0]
    for s in range(0, len(noise), 20000):  # assign noise in blocks (memory)
        blk = noise[s:s + 20000]
        d = np.linalg.norm(u8[blk, None, :] - cent8[None, :, :], axis=2)
        labels[blk] = d.argmin(axis=1)
    labels = labels.astype(np.int16)

    # ── cluster terms (sampled: joining every chunk is 400 MB of text) ───────
    log("cluster terms (c-TF-IDF)")
    rng = np.random.default_rng(42)
    docs = []
    for c in range(n_cl):
        idx = np.where(labels == c)[0]
        if len(idx) > TERM_SAMPLE:
            idx = rng.choice(idx, TERM_SAMPLE, replace=False)
        docs.append(" ".join(meta[i]["content"] for i in idx))
    tfidf = TfidfVectorizer(max_features=30000, stop_words="english",
                            ngram_range=(1, 2), min_df=2)
    X = tfidf.fit_transform(docs)
    terms = np.array(tfidf.get_feature_names_out())
    top_terms = [terms[np.asarray(X[c].todense()).ravel().argsort()[::-1][:15]].tolist()
                 for c in range(n_cl)]

    clusters = []
    for c in range(n_cl):
        idx = np.where(labels == c)[0]
        pf = Counter(paper_of[i] for i in idx)
        clusters.append({
            "id": c,
            "size": int(len(idx)),
            "nPapers": len(pf),
            "center": [rf(v) for v in p2[idx].mean(axis=0)],
            "center3": [rf(v) for v in p3[idx].mean(axis=0)],
            "terms": top_terms[c],
            "sampleTitles": [papers[p]["title"][:110] for p, _ in pf.most_common(8)],
            "name": "",
            "flavor": "",
        })

    # ── heightmap + voids ────────────────────────────────────────────────────
    log("heightmap + voids")
    H, _, _ = np.histogram2d(p2[:, 0], p2[:, 1], bins=GRID, range=[[0, 1], [0, 1]])
    Hs = gaussian_filter(H, sigma=6.0) + 0.35 * gaussian_filter(H, sigma=2.0)
    Hs = np.log1p(Hs)
    Hs /= Hs.max()
    (out / "heightmap.bin").write_bytes(Hs.astype(np.float32).T.tobytes())

    occupied = gaussian_filter((H > 0).astype(float), sigma=10) > 0.02
    lab, n_lab = label((Hs < 0.10) & occupied)
    voids = []
    for li in range(1, n_lab + 1):
        ys, xs = np.where(lab == li)
        if len(ys) < 40:
            continue
        cx, cy = xs.mean() / GRID, ys.mean() / GRID
        near = np.linalg.norm(p2 - np.array([cx, cy], dtype=np.float32), axis=1).argsort()[:12]
        voids.append({
            "pos": [rf(cx), rf(cy)],
            "area": int(len(ys)),
            "nearClusters": [int(c) for c, _ in Counter(int(labels[i]) for i in near).most_common(4)],
            "nearChunks": [{"paper": papers[paper_of[i]]["title"][:110],
                            "snippet": meta[i]["content"][:200]} for i in near[:8]],
            "title": "", "abstract": "",
        })
    voids.sort(key=lambda v: -v["area"])
    voids = voids[:10]

    # ── per-paper centroids (vectorised; the old per-file scan was O(papers*n)) ─
    log("paper centroids")
    npap = len(papers)
    counts = np.bincount(paper_of, minlength=npap).astype(np.float32)
    safe = np.maximum(counts, 1)[:, None]
    c2 = np.zeros((npap, 2), np.float32)
    c3 = np.zeros((npap, 3), np.float32)
    np.add.at(c2, paper_of, p2)
    np.add.at(c3, paper_of, p3)
    c2 /= safe
    c3 /= safe
    for i, p in enumerate(papers):
        p["centroid"] = [rf(v) for v in c2[i]]
        p["centroid3"] = [rf(v) for v in c3[i]]
        p["nChunks"] = int(counts[i])

    # ── write ────────────────────────────────────────────────────────────────
    np.savez_compressed(
        out / "atlas_cols.npz",
        pos2=p2.ravel(), pos3=p3.ravel(), cluster=labels,
        paper=paper_of, year=year_of, docIdx=doc_idx, chunkNum=chunk_num.astype(np.int32),
    )
    # the rover only needs the first KNN_K-1 neighbours; sim, not distance
    np.savez_compressed(
        out / "knn.npz",
        idx=knn_idx[:, 1:KNN_K].astype(np.int32),
        sim=(1.0 - knn_dist[:, 1:KNN_K]).astype(np.float32),
    )
    (out / "doc_hashes.json").write_text(json.dumps(doc_hashes))
    (out / "papers.json").write_text(json.dumps(papers, separators=(",", ":")))
    (out / "clusters.json").write_text(json.dumps(clusters, separators=(",", ":")))
    (out / "voids.json").write_text(json.dumps(voids, separators=(",", ":")))
    (out / "layout_info.json").write_text(json.dumps(
        {"n": n, "papers": npap, "clusters": n_cl, "dim": int(vecs.shape[1]),
         "knn_k": KNN_K - 1, "chunk_id_mismatches": int(pad_mismatch)}))
    for f in sorted(out.glob("*")):
        if not f.name.startswith("_"):
            log(f"wrote {f.name} ({f.stat().st_size/1e6:.2f} MB)")
    log("done")


if __name__ == "__main__":
    main()
