"""AP-RAG Atlas data pipeline.

Reads raw/ (chunk_vectors.npy, chunk_meta.json, papers_metadata.json,
kv_store_text_chunks.json, graph_chunk_entity_relation.graphml) and writes:

  ../public/data/atlas.json          columnar chunk data (pos2, pos3, cluster, paper, year)
  ../public/data/papers.json         paper table (title, authors, year, journal, doi, centroid)
  ../public/data/clusters.json       cluster stats + top terms + sample titles (names added later)
  ../public/data/knn.json            k-nearest-neighbor graph (indices, flat)
  ../public/data/heightmap.bin       512x512 float32 density heightmap
  ../public/data/constellations.json top entities + edges with map positions
  ../public/data/voids.json          low-density void centers + neighborhood context
  ../server-data/chunk_text.json     chunk_id -> {text, section, page} (API-route lookup)
  naming_input.json                  cluster term/title dump for LLM region naming
"""

import ast
import json
import re
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, label
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.neighbors import NearestNeighbors

import hdbscan
import umap

HERE = Path(__file__).parent
RAW = HERE / "raw"
PUB = HERE.parent / "public" / "data"
SRV = HERE.parent / "server-data"
PUB.mkdir(parents=True, exist_ok=True)
SRV.mkdir(parents=True, exist_ok=True)

GRID = 512
KNN_K = 9  # 1 self + 8 neighbors


def jdump(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"wrote {path} ({path.stat().st_size/1e6:.2f} MB)")


def rf(x, nd=4):
    return round(float(x), nd)


print("loading raw data...")
vecs = np.load(RAW / "chunk_vectors.npy")
meta = json.loads((RAW / "chunk_meta.json").read_text())
manifest = json.loads((RAW / "papers_metadata.json").read_text())
text_chunks = json.loads((RAW / "kv_store_text_chunks.json").read_text())
N = len(meta)
assert vecs.shape[0] == N

vecs = vecs / (np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9)

# ── papers table ──────────────────────────────────────────────────────────────
files = sorted({m["file_path"] for m in meta})
file_idx = {f: i for i, f in enumerate(files)}


def short_authors(rec) -> str:
    try:
        au = ast.literal_eval(rec.get("authors", "[]"))
    except Exception:
        au = []
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
    year = None
    m = re.search(r"(19|20)\d\d", str(rec.get("year", "")))
    if m:
        year = int(m.group(0))
    if year is None:
        m = re.search(r"(19|20)\d\d", f)
        year = int(m.group(0)) if m else 0
    papers.append(
        {
            "file": f,
            "title": rec.get("title") or f.replace(".pdf", "").replace("_", " "),
            "authors": short_authors(rec) or f.split("_")[0],
            "year": year,
            "journal": rec.get("container_title", ""),
            "doi": rec.get("doi", ""),
            "abstract": (rec.get("abstract") or "")[:600],
        }
    )

# ── projections ───────────────────────────────────────────────────────────────
print("UMAP 2D...")
u2 = umap.UMAP(n_components=2, n_neighbors=30, min_dist=0.08, metric="cosine",
               random_state=42).fit_transform(vecs)
print("UMAP 3D...")
u3 = umap.UMAP(n_components=3, n_neighbors=30, min_dist=0.15, metric="cosine",
               random_state=42).fit_transform(vecs)
print("UMAP 8D for clustering...")
u8 = umap.UMAP(n_components=8, n_neighbors=30, min_dist=0.0, metric="cosine",
               random_state=42).fit_transform(vecs)


def norm01(a):
    lo, hi = a.min(axis=0), a.max(axis=0)
    return (a - lo) / (hi - lo + 1e-9)


p2 = norm01(u2)
p3 = norm01(u3)

# ── clustering ────────────────────────────────────────────────────────────────
print("HDBSCAN...")
cl = hdbscan.HDBSCAN(min_cluster_size=45, min_samples=10).fit(u8)
labels = cl.labels_.copy()
n_cl = labels.max() + 1
print(f"{n_cl} clusters, {(labels == -1).sum()} noise points")

centroids8 = np.stack([u8[labels == c].mean(axis=0) for c in range(n_cl)])
noise = np.where(labels == -1)[0]
if len(noise):
    d = np.linalg.norm(u8[noise, None, :] - centroids8[None, :, :], axis=2)
    labels[noise] = d.argmin(axis=1)

# ── c-TF-IDF style top terms per cluster ─────────────────────────────────────
print("cluster terms...")
docs_per_cluster = [" ".join(meta[i]["content"] for i in np.where(labels == c)[0])
                    for c in range(n_cl)]
tfidf = TfidfVectorizer(max_features=30000, stop_words="english",
                        ngram_range=(1, 2), min_df=2)
X = tfidf.fit_transform(docs_per_cluster)
terms = np.array(tfidf.get_feature_names_out())
top_terms = [terms[np.asarray(X[c].todense()).ravel().argsort()[::-1][:15]].tolist()
             for c in range(n_cl)]

clusters = []
for c in range(n_cl):
    idx = np.where(labels == c)[0]
    pfiles = Counter(meta[i]["file_path"] for i in idx)
    sample_titles = []
    for f, _ in pfiles.most_common(8):
        sample_titles.append(papers[file_idx[f]]["title"][:110])
    cx, cy = p2[idx].mean(axis=0)
    clusters.append(
        {
            "id": c,
            "size": int(len(idx)),
            "nPapers": len(pfiles),
            "center": [rf(cx), rf(cy)],
            "center3": [rf(v) for v in p3[idx].mean(axis=0)],
            "terms": top_terms[c],
            "sampleTitles": sample_titles,
            "name": "",       # filled by naming pass
            "flavor": "",     # filled by naming pass
        }
    )

# ── kNN graph (full-vector cosine) ───────────────────────────────────────────
print("kNN graph...")
nn = NearestNeighbors(n_neighbors=KNN_K, metric="cosine").fit(vecs)
dist, nbr = nn.kneighbors(vecs)
knn_idx = nbr[:, 1:].astype(int)
knn_sim = (1.0 - dist[:, 1:]).round(4)

# ── heightmap ────────────────────────────────────────────────────────────────
print("heightmap...")
H, xe, ye = np.histogram2d(p2[:, 0], p2[:, 1], bins=GRID, range=[[0, 1], [0, 1]])
Hs = gaussian_filter(H, sigma=6.0) + 0.35 * gaussian_filter(H, sigma=2.0)
Hs = np.log1p(Hs)
Hs = Hs / Hs.max()
(PUB / "heightmap.bin").write_bytes(Hs.astype(np.float32).T.tobytes())  # row-major y
print(f"heightmap {GRID}x{GRID} range 0..1")

# ── voids (ghost-paper sites) ────────────────────────────────────────────────
print("voids...")
occupied = gaussian_filter((H > 0).astype(float), sigma=10) > 0.02  # inside the landmass
low = (Hs < 0.10) & occupied
lab, n_lab = label(low)
void_sites = []
for li in range(1, n_lab + 1):
    ys, xs = np.where(lab == li)
    if len(ys) < 40:
        continue
    cxg, cyg = xs.mean() / GRID, ys.mean() / GRID
    pt = np.array([cxg, cyg])
    d2 = np.linalg.norm(p2 - pt, axis=1)
    near = d2.argsort()[:12]
    near_clusters = Counter(int(labels[i]) for i in near)
    void_sites.append(
        {
            "pos": [rf(cxg), rf(cyg)],
            "area": int(len(ys)),
            "nearClusters": [c for c, _ in near_clusters.most_common(4)],
            "nearChunks": [
                {
                    "paper": papers[file_idx[meta[i]["file_path"]]]["title"][:110],
                    "snippet": meta[i]["content"][:200],
                }
                for i in near[:8]
            ],
            "title": "",     # filled by ghost-writing pass
            "abstract": "",  # filled by ghost-writing pass
        }
    )
void_sites.sort(key=lambda v: -v["area"])
void_sites = void_sites[:10]
print(f"{len(void_sites)} void sites")

# ── entities / constellations from graphml ──────────────────────────────────
print("parsing graphml (large)...")
NS = "{http://graphml.graphdrawing.org/xmlns}"
keys = {}
nodes = {}
edges = []
for ev, el in ET.iterparse(RAW / "graph_chunk_entity_relation.graphml", events=("end",)):
    if el.tag == f"{NS}key":
        keys[el.get("id")] = el.get("attr.name")
    elif el.tag == f"{NS}node":
        data = {keys.get(d.get("key")): d.text for d in el.findall(f"{NS}data")}
        nodes[el.get("id")] = data
        el.clear()
    elif el.tag == f"{NS}edge":
        data = {keys.get(d.get("key")): d.text for d in el.findall(f"{NS}data")}
        edges.append((el.get("source"), el.get("target"), data))
        el.clear()
print(f"{len(nodes)} entities, {len(edges)} relations")

chunk_pos = {meta[i]["chunk_id"]: i for i in range(N)}
deg = Counter()
for s, t, _ in edges:
    deg[s] += 1
    deg[t] += 1

TOP_ENT = 500


def ent_indices(data) -> list:
    src = (data.get("source_id") or "").split("<SEP>")
    return [chunk_pos[c] for c in src if c in chunk_pos]


ranked = [nid for nid, _ in deg.most_common() if nid in nodes and ent_indices(nodes[nid])]
kept = ranked[:TOP_ENT]
kept_set = set(kept)
ents_out = []
for nid in kept:
    d = nodes[nid]
    idx = ent_indices(d)
    ents_out.append(
        {
            "id": nid,
            "type": d.get("entity_type", ""),
            "desc": (d.get("description") or "")[:300],
            "deg": deg[nid],
            "nChunks": len(idx),
            "pos2": [rf(v) for v in p2[idx].mean(axis=0)],
            "pos3": [rf(v) for v in p3[idx].mean(axis=0)],
            "chunkIdx": idx[:12],
        }
    )
edges_out = []
seen = set()
for s, t, d in edges:
    if s in kept_set and t in kept_set and (s, t) not in seen and (t, s) not in seen:
        seen.add((s, t))
        edges_out.append(
            {
                "s": s,
                "t": t,
                "w": float(d.get("weight") or 1),
                "desc": (d.get("description") or "")[:200],
                "kw": (d.get("keywords") or "")[:100],
            }
        )
edges_out.sort(key=lambda e: -e["w"])
edges_out = edges_out[:2500]
print(f"kept {len(ents_out)} entities, {len(edges_out)} edges")

# ── chunk-level outputs ──────────────────────────────────────────────────────
snippets = []
sections = []
pages = []
for m in meta:
    tc = text_chunks.get(m["chunk_id"], {})
    raw_txt = tc.get("raw_text_without_overlap") or tc.get("content") or m["content"]
    snippets.append(re.sub(r"\s+", " ", raw_txt)[:160])
    sections.append((tc.get("section_title") or "")[:60])
    pages.append(tc.get("page_start"))

atlas = {
    "n": N,
    "pos2": [rf(v) for v in p2.ravel()],
    "pos3": [rf(v) for v in p3.ravel()],
    "cluster": labels.astype(int).tolist(),
    "paper": [file_idx[m["file_path"]] for m in meta],
    "year": [papers[file_idx[m["file_path"]]]["year"] for m in meta],
    "snippet": snippets,
    "section": sections,
    "chunkId": [m["chunk_id"] for m in meta],
}

for f in files:
    idx = [i for i in range(N) if meta[i]["file_path"] == f]
    papers[file_idx[f]]["centroid"] = [rf(v) for v in p2[idx].mean(axis=0)]
    papers[file_idx[f]]["centroid3"] = [rf(v) for v in p3[idx].mean(axis=0)]
    papers[file_idx[f]]["nChunks"] = len(idx)

jdump(PUB / "atlas.json", atlas)
jdump(PUB / "papers.json", papers)
jdump(PUB / "clusters.json", clusters)
jdump(PUB / "knn.json", {"k": KNN_K - 1, "idx": knn_idx.ravel().tolist(),
                          "sim": knn_sim.ravel().tolist()})
jdump(PUB / "constellations.json", {"entities": ents_out, "edges": edges_out})
jdump(PUB / "voids.json", void_sites)

chunk_text = {
    m["chunk_id"]: {
        "text": (text_chunks.get(m["chunk_id"], {}).get("raw_text_without_overlap")
                 or text_chunks.get(m["chunk_id"], {}).get("content")
                 or m["content"])[:4000],
        "section": text_chunks.get(m["chunk_id"], {}).get("section_title") or "",
        "page": text_chunks.get(m["chunk_id"], {}).get("page_start"),
        "file": m["file_path"],
        "qid": m["qid"],
    }
    for m in meta
}
jdump(SRV / "chunk_text.json", chunk_text)

naming = [
    {
        "id": c["id"],
        "size": c["size"],
        "nPapers": c["nPapers"],
        "terms": c["terms"],
        "sampleTitles": c["sampleTitles"],
    }
    for c in clusters
]
jdump(HERE / "naming_input.json", naming)

years = sorted({p["year"] for p in papers if p["year"]})
print("year range:", years[:3], "...", years[-3:], f"({len(years)} distinct)")
print("done.")
