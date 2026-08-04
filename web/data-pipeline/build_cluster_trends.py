"""Semantic trend layer for the Research Trends dashboard.

Reads the Atlas artifacts that ``pipeline.py`` already produces and writes

    ../public/data/cluster_trends.json

Two things live in there, both keyword-independent:

**Cluster trends.** The 75 HDBSCAN regions over chunk embeddings, each already
carrying an LLM-written name and one-line flavor, counted per year. This matters
because the keyword dimension is a poor trend unit on this corpus: 16.6k distinct
keywords, 72% appearing exactly once, uncontrolled vocabulary, and 18% of papers
carrying no keywords at all. A cluster is assigned from the paper's own text, so it
covers every paper and cannot be gamed by whichever synonym an author happened to
pick.

**The frontier.** Grid cells of the Atlas where recent papers are concentrated far
beyond the corpus-wide recent rate — regions the corpus is growing into that it was
not before. Reported in Atlas coordinates so each one links straight to the map.

Run from ``web/data-pipeline/`` after ``pipeline.py``:

    python build_cluster_trends.py
"""

import json
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
PUB = HERE.parent / "public" / "data"

RECENT_SPAN = 10          # matches aprag_trends.RECENT_SPAN
BASE_SPAN = 10
FRONTIER_SPAN = 8         # "recent" for the frontier is tighter than the trend window
GRID = 28                 # frontier cells per axis
MIN_CELL_PAPERS = 6
MIN_FRONTIER_Z = 2.5
MIN_YEAR, MAX_YEAR = 1800, 2100


def load_atlas_columns() -> dict:
    """Columnar chunk arrays from atlas.bin, sliced by atlas.meta.json."""
    meta = json.loads((PUB / "atlas.meta.json").read_text())
    raw = (PUB / "atlas.bin").read_bytes()
    out = {}
    for section in meta["sections"]:
        dtype = np.dtype(section["dtype"])
        start = section["offset"]
        end = start + section["count"] * dtype.itemsize
        out[section["name"]] = np.frombuffer(raw[start:end], dtype=dtype)
    return out


def dominant_cluster_per_paper(cols: dict, n_papers: int) -> np.ndarray:
    """Each paper's modal chunk cluster (-1 = noise/unassigned).

    A paper's chunks scatter across neighbouring regions; the mode is the region it
    mostly sits in. Noise chunks (cluster -1) are ignored unless a paper is entirely
    noise.
    """
    cluster = cols["cluster"].astype(np.int32)
    paper = cols["paper"].astype(np.int32)
    votes: list[Counter] = [Counter() for _ in range(n_papers)]
    for c, p in zip(cluster, paper):
        if 0 <= p < n_papers:
            votes[p][int(c)] += 1
    out = np.full(n_papers, -1, dtype=np.int32)
    for i, counter in enumerate(votes):
        counter.pop(-1, None)
        if counter:
            out[i] = counter.most_common(1)[0][0]
    return out


def year_stats(counts: dict) -> dict:
    if not counts:
        return {}
    years = sorted(counts)
    total = sum(counts.values())
    peak = max(years, key=lambda y: (counts[y], y))
    running = 0
    median = years[0]
    for y in years:
        running += counts[y]
        if running >= total / 2:
            median = y
            break
    return {"first": years[0], "last": years[-1], "peak": peak,
            "peakN": counts[peak], "median": median}


def window_sum(counts: dict, lo: int, hi: int) -> int:
    return sum(n for y, n in counts.items() if lo <= y <= hi)


def main() -> None:
    papers = json.loads((PUB / "papers.json").read_text())
    clusters = json.loads((PUB / "clusters.json").read_text())
    cols = load_atlas_columns()

    n_papers = len(papers)
    assigned = dominant_cluster_per_paper(cols, n_papers)

    cluster_by_id = {c["id"]: c for c in clusters}
    years: Counter = Counter()
    per_cluster: dict[int, Counter] = defaultdict(Counter)
    cell_papers: dict[tuple[int, int], list[int]] = defaultdict(list)

    for index, paper in enumerate(papers):
        year = paper.get("year")
        if not isinstance(year, int) or not (MIN_YEAR <= year <= MAX_YEAR):
            continue
        years[year] += 1
        cid = int(assigned[index])
        if cid >= 0:
            per_cluster[cid][year] += 1
        centroid = paper.get("centroid")
        if isinstance(centroid, list) and len(centroid) == 2:
            cx = min(GRID - 1, max(0, int(centroid[0] * GRID)))
            cy = min(GRID - 1, max(0, int(centroid[1] * GRID)))
            cell_papers[(cx, cy)].append(index)

    if not years:
        raise SystemExit("no dated papers in papers.json — nothing to build")

    corpus = dict(years)
    corpus_total = sum(corpus.values())
    max_year = max(corpus)
    recent = (max_year - RECENT_SPAN + 1, max_year)
    base = (recent[0] - BASE_SPAN, recent[0] - 1)
    corpus_recent = max(1, window_sum(corpus, *recent))
    corpus_base = max(1, window_sum(corpus, *base))

    # ── Cluster trends, shaped exactly like a TrendTerm so the dashboard can chart
    # them with the same code path as keywords or subjects.
    shaped = []
    for cid, counts in per_cluster.items():
        meta = cluster_by_id.get(cid, {})
        total = sum(counts.values())
        if total < 5:
            continue
        in_recent = window_sum(counts, *recent)
        in_base = window_sum(counts, *base)
        delta = in_recent / corpus_recent - in_base / corpus_base
        shaped.append({
            "term": meta.get("name") or f"Region {cid}",
            "id": cid,
            "flavor": meta.get("flavor", ""),
            "terms": (meta.get("terms") or [])[:8],
            "center": meta.get("center"),
            "center3": meta.get("center3"),
            "total": total,
            "counts": {str(y): n for y, n in sorted(counts.items())},
            "stats": year_stats(counts),
            "base": in_base,
            "recent": in_recent,
            "delta": round(delta * 100, 3),
        })
    shaped.sort(key=lambda c: -c["total"])

    # ── Frontier: cells whose recent share far exceeds the corpus-wide recent share.
    # Poisson surprise on the cell's recent count, same statistic as the burst score.
    frontier_lo = max_year - FRONTIER_SPAN + 1
    corpus_recent_rate = window_sum(corpus, frontier_lo, max_year) / corpus_total
    frontier = []
    for (cx, cy), indices in cell_papers.items():
        dated = [papers[i] for i in indices
                 if isinstance(papers[i].get("year"), int)]
        if len(dated) < MIN_CELL_PAPERS:
            continue
        recent_here = [p for p in dated if p["year"] >= frontier_lo]
        expected = len(dated) * corpus_recent_rate
        if expected < 1 or len(recent_here) <= expected:
            continue
        z = (len(recent_here) - expected) / (expected ** 0.5)
        if z < MIN_FRONTIER_Z:
            continue
        cluster_votes = Counter(
            int(assigned[i]) for i in indices if int(assigned[i]) >= 0
        )
        cid = cluster_votes.most_common(1)[0][0] if cluster_votes else -1
        recent_here.sort(key=lambda p: -p["year"])
        frontier.append({
            "x": round((cx + 0.5) / GRID, 4),
            "y": round((cy + 0.5) / GRID, 4),
            "n": len(dated),
            "recentN": len(recent_here),
            "expected": round(expected, 1),
            "z": round(z, 2),
            "cluster": cid,
            "name": cluster_by_id.get(cid, {}).get("name", "Unmapped"),
            "titles": [p.get("title", "")[:110] for p in recent_here[:4]],
            "files": [p.get("file", "") for p in recent_here[:4]],
        })
    frontier.sort(key=lambda f: -f["z"])

    out = {
        "generated": date.today().isoformat(),
        "years": {str(y): n for y, n in sorted(corpus.items())},
        "windows": {"base": list(base), "recent": list(recent)},
        "frontierWindow": [frontier_lo, max_year],
        "clusters": shaped,
        "frontier": frontier[:14],
        "totals": {
            "papers": n_papers,
            "dated": corpus_total,
            "clustered": int((assigned >= 0).sum()),
            "regions": len(shaped),
        },
    }
    path = PUB / "cluster_trends.json"
    path.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB)")
    print(f"  {len(shaped)} regions, {out['totals']['clustered']}/{n_papers} papers clustered")
    print(f"  {len(frontier)} frontier cells (kept {len(out['frontier'])})")
    for region in shaped[:5]:
        print(f"    {region['term']:38s} {region['total']:5d}  Δ{region['delta']:+.2f}pp")
    for cell in out["frontier"][:5]:
        print(f"    frontier z={cell['z']:5.2f}  {cell['recentN']:3d}/{cell['n']:3d} recent  {cell['name']}")


if __name__ == "__main__":
    main()
