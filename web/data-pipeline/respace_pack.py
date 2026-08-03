"""Re-normalise the map so the corpus fills it.

Two fixes, measured before and after:
  1. min-max normalisation let a few outliers squeeze the bulk into ~half the
     range; clipping to percentiles gives that range back
  2. the projection itself was re-run with a larger min_dist/spread, so points
     no longer pile up inside a region

Clustering is untouched — it comes from the 8D projection, which did not change.
"""
import json
import numpy as np
from scipy.ndimage import gaussian_filter, label
from pathlib import Path

SRC = Path("hpc_out")
GRID, LO, HI = 512, 0.5, 99.5

def norm_pct(a):
    """Percentile-clipped [0,1]; outliers stop dictating the scale."""
    lo = np.percentile(a, LO, axis=0)
    hi = np.percentile(a, HI, axis=0)
    return np.clip((a - lo) / (hi - lo + 1e-9), 0.0, 1.0).astype(np.float32)

def occupancy(p2, tag):
    H, _, _ = np.histogram2d(p2[:, 0], p2[:, 1], bins=200, range=[[0, 1], [0, 1]])
    mid = np.percentile(p2, 97.5, axis=0) - np.percentile(p2, 2.5, axis=0)
    dens = np.sort(H.ravel())[::-1]
    half = int((dens.cumsum() < p2.shape[0] * 0.5).sum())
    print(f"  {tag:<8} occupied {(H>0).mean()*100:5.1f}% of map | middle-95% span "
          f"x={mid[0]:.2f} y={mid[1]:.2f} | densest-half in {half} cells")

old = np.load(SRC / "atlas_cols.npz")
p2_old = old["pos2"].reshape(-1, 2)
u2 = np.load(SRC / "_umap2d_wide.npy")
u3 = np.load(SRC / "_umap3d_wide.npy")
p2 = norm_pct(u2)
p3 = norm_pct(u3)
print("map occupancy:")
occupancy(p2_old, "before")
occupancy(p2, "after")

# heightmap + voids follow the coordinates, so they are rebuilt here
H, _, _ = np.histogram2d(p2[:, 0], p2[:, 1], bins=GRID, range=[[0, 1], [0, 1]])
Hs = gaussian_filter(H, sigma=6.0) + 0.35 * gaussian_filter(H, sigma=2.0)
Hs = np.log1p(Hs); Hs /= Hs.max()
(SRC / "heightmap.bin").write_bytes(Hs.astype(np.float32).T.tobytes())

papers = json.loads((SRC / "papers.json").read_text())
paper_of = old["paper"]
meta_titles = [p["title"][:110] for p in papers]
occupied = gaussian_filter((H > 0).astype(float), sigma=10) > 0.02
lab, n_lab = label((Hs < 0.10) & occupied)
voids = []
for li in range(1, n_lab + 1):
    ys, xs = np.where(lab == li)
    if len(ys) < 40: continue
    cx, cy = xs.mean() / GRID, ys.mean() / GRID
    near = np.linalg.norm(p2 - np.array([cx, cy], np.float32), axis=1).argsort()[:12]
    voids.append({"pos": [round(float(cx),4), round(float(cy),4)], "area": int(len(ys)),
                  "nearClusters": [int(c) for c in np.unique(old["cluster"][near])[:4]],
                  "nearChunks": [{"paper": meta_titles[paper_of[i]], "snippet": ""} for i in near[:8]],
                  "title": "", "abstract": ""})
voids.sort(key=lambda v: -v["area"]); voids = voids[:10]
(SRC / "voids.json").write_text(json.dumps(voids, separators=(",", ":")))

# per-paper centroids move with the coordinates
npap = len(papers)
counts = np.bincount(paper_of, minlength=npap).astype(np.float32)
safe = np.maximum(counts, 1)[:, None]
c2 = np.zeros((npap, 2), np.float32); c3 = np.zeros((npap, 3), np.float32)
np.add.at(c2, paper_of, p2); np.add.at(c3, paper_of, p3)
c2 /= safe; c3 /= safe
for i, p in enumerate(papers):
    p["centroid"] = [round(float(v),4) for v in c2[i]]
    p["centroid3"] = [round(float(v),4) for v in c3[i]]
(SRC / "papers.json").write_text(json.dumps(papers, separators=(",", ":")))

np.savez_compressed(SRC / "atlas_cols.npz", pos2=p2.ravel(), pos3=p3.ravel(),
                    cluster=old["cluster"], paper=paper_of, year=old["year"],
                    docIdx=old["docIdx"], chunkNum=old["chunkNum"])
print(f"\n{len(voids)} void sites; repacked {npap} paper centroids")
