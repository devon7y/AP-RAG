"""Export the APA-metadata layers for the Papers Atlas world.

Runs AFTER the layout chain (joins against public/data/papers.json paper order).
Reads the CANONICAL paper database at the repo root — data/papers_metadata.json
and data/drive_links.json, the same two files the PC query server and the chat
app's citation layer are deployed from — and writes:

  ../public/data/authors.json      author table: display name, paper idxs, map pos
  ../public/data/papermeta.json    per-paper keywords / subjects / affiliations /
                                   drive links / fractional dates
  ../server-data/author_game.json  daily author-guess game, SELF-CONTAINED:
                                   pool names, cosine matrix, and per-candidate
                                   papers with prebuilt chunk ids (passage prose
                                   is fetched from the PC /chunk_text at play
                                   time — no local chunk-text table)

The cosine matrix comes from real 4096-d oeuvre centroids. Two sources:
  default    reuse the matrix from hpc_out/author_game.json (built on HPC where
             the chunk vectors live), remapping its names onto the CURRENT
             author table so the game can never drift out of index space again
  --pc-sim   rebuild the matrix from the PC query server's /paper_centroid
             (needs APRAG_QUERY_URL [+ APRAG_API_KEY]); per-paper centroids are
             cached in raw/paper_centroids.npz so re-runs only fetch new papers
"""

import ast
import json
import os
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
RAW = HERE / "raw"
HPC = HERE / "hpc_out"
PUB = HERE.parent / "public" / "data"
SRV = HERE.parent / "server-data"
DATA = HERE.parent.parent / "data"  # the canonical paper database
SRV.mkdir(parents=True, exist_ok=True)

MIN_PAPERS_ELIGIBLE = 2   # daily-game targets need an oeuvre, not a cameo
MAX_GAME_AUTHORS = 600    # pool cap when rebuilding the matrix from scratch
MIN_CANDIDATE_CHUNKS = 3  # a candidate paper must have passages to draw from
MAX_CANDIDATE_CHUNKS = 12


def jdump(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, separators=(",", ":")))
    print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB)")


def parse_list(v):
    if isinstance(v, str):
        try:
            v = ast.literal_eval(v)
        except (ValueError, SyntaxError):
            return []
    return v if isinstance(v, list) else []


def clean_str_list(v, cap: int) -> list[str]:
    out: list[str] = []
    seen = set()
    for s in parse_list(v):
        if not isinstance(s, str):
            continue
        t = re.sub(r"\s+", " ", s).strip()
        if not t or len(t) > 80:
            continue
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
        if len(out) >= cap:
            break
    return out


papers = json.loads((PUB / "papers.json").read_text())
manifest = json.loads((DATA / "papers_metadata.json").read_text())
drive_map_path = DATA / "drive_links.json"
drive_map: dict[str, str] = (
    json.loads(drive_map_path.read_text()) if drive_map_path.exists() else {}
)

file_to_idx = {p["file"]: i for i, p in enumerate(papers)}

# ── per-paper APA extras (parallel to papers.json order) ─────────────────────
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def parse_date(rec: dict, fallback_year: int) -> tuple[float, str]:
    """Manifest `date` (YYYY[-MM[-DD]]) → (fractional year, display string).
    Conventions: day-precision = exact; month-only = mid-month; year-only =
    mid-year. Unknown → (0, "")."""
    m = re.fullmatch(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", str(rec.get("date") or ""))
    if m:
        y = int(m.group(1))
        mo = int(m.group(2)) if m.group(2) else None
        dy = int(m.group(3)) if m.group(3) else None
        if mo and 1 <= mo <= 12:
            if dy and 1 <= dy <= 31:
                frac = y + ((mo - 1) + (dy - 0.5) / DAYS_IN[mo - 1]) / 12
                return round(frac, 4), f"{MONTHS[mo - 1]} {dy}, {y}"
            return round(y + (mo - 0.5) / 12, 4), f"{MONTHS[mo - 1]} {y}"
        return y + 0.5, str(y)
    if fallback_year > 0:
        return fallback_year + 0.5, str(fallback_year)
    return 0.0, ""


keywords: list[list[str]] = []
subjects: list[list[str]] = []
affils: list[list[str]] = []
fracs: list[float] = []
date_strs: list[str] = []
for p in papers:
    rec = manifest.get(p["file"], {})
    keywords.append(clean_str_list(rec.get("keywords"), 8))
    subjects.append(clean_str_list(rec.get("subjects"), 6))
    affils.append(clean_str_list(rec.get("affiliations"), 4))
    frac, dstr = parse_date(rec, int(p.get("year") or 0))
    fracs.append(frac)
    date_strs.append(dstr)

n_month = sum(1 for f in fracs if f and abs((f % 1) - 0.5) > 1e-6)
print(f"dates: {sum(1 for f in fracs if f)}/{len(papers)} known, {n_month} finer than a year")

# ── author table ─────────────────────────────────────────────────────────────
def author_key(family: str, given: str) -> str:
    fam = re.sub(r"[^a-z]", "", family.lower())
    init = next((c for c in given.lower() if c.isalpha()), "")
    return f"{fam}|{init}"


by_key: dict[str, dict] = {}
for p_idx, p in enumerate(papers):
    rec = manifest.get(p["file"], {})
    for a in parse_list(rec.get("authors")):
        if not isinstance(a, dict):
            continue
        family = re.sub(r"\s+", " ", str(a.get("family") or "")).strip()
        given = re.sub(r"\s+", " ", str(a.get("given") or "")).strip()
        if not family:
            continue
        k = author_key(family, given)
        slot = by_key.setdefault(k, {"family": family, "given": given, "papers": []})
        if len(given) > len(slot["given"]):
            slot["given"] = given  # keep the fullest given-name variant
        if p_idx not in slot["papers"]:
            slot["papers"].append(p_idx)

authors = []
for k, slot in by_key.items():
    idxs = sorted(slot["papers"])
    c2 = np.mean([papers[i]["centroid"] for i in idxs], axis=0)
    c3 = np.mean([papers[i]["centroid3"] for i in idxs], axis=0)
    name = f"{slot['given']} {slot['family']}".strip() or slot["family"]
    authors.append(
        {
            "key": k,
            "name": name,
            "family": slot["family"],
            "papers": idxs,
            "pos2": [round(float(v), 4) for v in c2],
            "pos3": [round(float(v), 4) for v in c3],
        }
    )
authors.sort(key=lambda a: (-len(a["papers"]), a["family"].lower()))
key_to_idx = {a["key"]: ai for ai, a in enumerate(authors)}
for a in authors:
    del a["key"]
jdump(PUB / "authors.json", authors)
print(f"{len(authors)} authors, {sum(1 for a in authors if len(a['papers']) >= MIN_PAPERS_ELIGIBLE)} with >= {MIN_PAPERS_ELIGIBLE} papers")

# ── first author per paper (index into authors.json; -1 unknown) ─────────────
first_idx: list[int] = []
for p in papers:
    rec = manifest.get(p["file"], {})
    fi = -1
    for au in parse_list(rec.get("authors")):
        if isinstance(au, dict) and (au.get("family") or "").strip():
            fi = key_to_idx.get(
                author_key(str(au.get("family")), str(au.get("given") or "")), -1
            )
            break
    first_idx.append(fi)
print(f"first authors resolved: {sum(1 for i in first_idx if i >= 0)}/{len(papers)}")

drive = [str(drive_map.get(p["file"], "")) for p in papers]
print(f"drive links: {sum(1 for d in drive if d)}/{len(papers)}")

jdump(
    PUB / "papermeta.json",
    {
        "keywords": keywords,
        "subjects": subjects,
        "affil": affils,
        "first": first_idx,
        "drive": drive,
        "frac": fracs,
        "dateStr": date_strs,
    },
)

# ── daily author game (self-contained) ───────────────────────────────────────
# The game file carries everything its API route needs — pool names, cosine
# matrix, and per-candidate papers with chunk ids — so it is regenerated here in
# one shot with the tables above and can never drift out of index space.

def norm_name(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def load_atlas_chunk_ids() -> dict[int, list[str]] | None:
    """papers.json idx → chunk ids, from the layout run's columnar output."""
    npz_p, hashes_p = HPC / "atlas_cols.npz", HPC / "doc_hashes.json"
    if not (npz_p.exists() and hashes_p.exists()):
        return None
    z = np.load(npz_p)
    doc_hashes = json.loads(hashes_p.read_text())
    paper_col, doc_col, num_col = z["paper"], z["docIdx"], z["chunkNum"]
    out: dict[int, list[tuple[int, str]]] = {}
    for i in range(len(paper_col)):
        d, num = int(doc_col[i]), int(num_col[i])
        if d < 0:
            continue
        # chunk 0 is usually the title page — it names the authors outright
        if num == 0:
            continue
        out.setdefault(int(paper_col[i]), []).append(
            (num, f"doc-{doc_hashes[d]}-chunk-{num:03d}")
        )
    ids: dict[int, list[str]] = {}
    for pi, pairs in out.items():
        pairs.sort()
        if len(pairs) > MAX_CANDIDATE_CHUNKS:  # spread picks across the paper
            step = len(pairs) / MAX_CANDIDATE_CHUNKS
            pairs = [pairs[int(j * step)] for j in range(MAX_CANDIDATE_CHUNKS)]
        ids[pi] = [cid for _, cid in pairs]
    return ids


def matrix_from_hpc() -> tuple[list[str], np.ndarray] | None:
    """Reuse the HPC-built oeuvre-cosine matrix; names are matched to the
    current author table by display name, so a rename only drops that one
    author from the pool instead of shifting every index."""
    p = HPC / "author_game.json"
    if not p.exists():
        return None
    g = json.loads(p.read_text())
    names, sim, elig = g["names"], np.asarray(g["sim"], dtype=np.float32), g["eligible"]
    if sim.shape[0] != len(names):  # rows may cover only the old eligible set
        full = np.zeros((len(names), len(names)), dtype=np.float32)
        for row, j in enumerate(elig):
            full[j] = sim[row]
        sim = full
    return names, sim


def matrix_from_pc() -> tuple[list[str], np.ndarray] | None:
    """Rebuild oeuvre centroids from the PC query server's /paper_centroid.
    Per-paper centroids are cached in raw/paper_centroids.npz."""
    base = os.environ.get("APRAG_QUERY_URL", "").rstrip("/")
    if not base:
        print("--pc-sim needs APRAG_QUERY_URL")
        return None
    api_key = os.environ.get("APRAG_API_KEY", "")

    cache_p = RAW / "paper_centroids.npz"
    cache: dict[str, np.ndarray] = {}
    if cache_p.exists():
        z = np.load(cache_p, allow_pickle=False)
        cache = {f: v for f, v in zip(json.loads(str(z["files"])), z["vecs"])}

    def fetch(file: str) -> np.ndarray | None:
        if file in cache:
            return cache[file]
        req = urllib.request.Request(
            f"{base}/paper_centroid",
            data=json.dumps({"file": file}).encode(),
            headers={"Content-Type": "application/json",
                     **({"X-API-Key": api_key} if api_key else {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                v = np.asarray(json.load(r)["centroid"], dtype=np.float32)
        except Exception as e:  # 404 = paper not in the RAG store yet
            print(f"  no centroid for {file}: {e}")
            return None
        cache[file] = v
        return v

    ranked = sorted(range(len(authors)), key=lambda ai: -len(authors[ai]["papers"]))
    pool_ai = ranked[:MAX_GAME_AUTHORS]
    names = [authors[ai]["name"] for ai in pool_ai]
    dim = None
    cent_rows: list[np.ndarray | None] = []
    for done, ai in enumerate(pool_ai):
        vs = [v for i in authors[ai]["papers"]
              if (v := fetch(papers[i]["file"])) is not None]
        if vs:
            m = np.mean(vs, axis=0)
            m /= np.linalg.norm(m) + 1e-9
            cent_rows.append(m)
            dim = len(m)
        else:
            cent_rows.append(None)
        if (done + 1) % 50 == 0:
            print(f"  centroids: {done + 1}/{len(pool_ai)} authors")
    if dim is None:
        return None
    cent = np.stack([r if r is not None else np.zeros(dim, dtype=np.float32)
                     for r in cent_rows])
    files = list(cache.keys())
    np.savez_compressed(cache_p, files=json.dumps(files),
                        vecs=np.stack([cache[f] for f in files]))
    print(f"cached {len(files)} paper centroids -> {cache_p}")
    return names, (cent @ cent.T).astype(np.float32)


use_pc = "--pc-sim" in sys.argv
src = matrix_from_pc() if use_pc else matrix_from_hpc()
chunk_ids = load_atlas_chunk_ids()
if src is None or chunk_ids is None:
    missing = "cosine matrix" if src is None else "hpc_out atlas columns"
    print(f"no {missing} available — skipping author_game.json")
else:
    names, sim = src
    name_to_author = {norm_name(a["name"]): ai for ai, a in enumerate(authors)}
    pool_author = [name_to_author.get(norm_name(nm), -1) for nm in names]
    n_papers = [len(authors[ai]["papers"]) if ai >= 0 else 0 for ai in pool_author]
    pool_row = {ai: r for r, ai in enumerate(pool_author) if ai >= 0}

    # candidate papers: first author is in the pool with a real oeuvre, and the
    # atlas has enough passages of it to draw from
    candidates = []
    for i, p in enumerate(papers):
        r = pool_row.get(first_idx[i], -1)
        if r < 0 or n_papers[r] < MIN_PAPERS_ELIGIBLE:
            continue
        ids = chunk_ids.get(i, [])
        if len(ids) < MIN_CANDIDATE_CHUNKS:
            continue
        co = sorted(
            pool_row[ai] for ai in pool_row
            if ai != first_idx[i] and i in authors[ai]["papers"]
        )
        candidates.append({"i": i, "t": r, "c": ids, **({"co": co} if co else {})})

    eligible = sorted({c["t"] for c in candidates})
    jdump(
        SRV / "author_game.json",
        {
            "generated": date.today().isoformat(),
            "matrixSource": "pc" if use_pc else "hpc",
            "names": names,
            "nPapers": n_papers,
            "eligible": eligible,
            "sim": [[round(float(x), 3) for x in row] for row in sim],
            "papers": candidates,
        },
    )
    print(f"author game: {len(candidates)} candidate papers, "
          f"{len(eligible)} eligible authors, pool {len(names)}")
print("done.")
