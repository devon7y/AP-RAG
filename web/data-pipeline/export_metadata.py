"""Export the APA-metadata layers for the Papers Atlas world.

Runs AFTER pipeline.py (joins against its public/data/papers.json paper order).
Reads raw/papers_metadata.json (the same APA manifest the chat app's citation
layer uses) + raw/chunk_vectors.npy + raw/chunk_meta.json, and writes:

  ../public/data/authors.json    author table: display name, paper idxs, map pos
  ../public/data/papermeta.json  per-paper keywords / subjects / affiliations
  ../server-data/author_game.json  daily author-guess game: eligible targets +
                                   cosine matrix (eligible x all authors) over
                                   real 4096-d oeuvre centroids

Scale note (full ~9.7k-paper corpus): authors.json grows linearly (fine);
author_game.json's eligible x all matrix should switch to on-demand centroid
cosines (PC /paper_centroid or Qdrant) once authors > ~3k.
"""

import ast
import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
RAW = HERE / "raw"
PUB = HERE.parent / "public" / "data"
SRV = HERE.parent / "server-data"
SRV.mkdir(parents=True, exist_ok=True)

MIN_PAPERS_ELIGIBLE = 2  # daily-game targets need an oeuvre, not a cameo


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
manifest = json.loads((RAW / "papers_metadata.json").read_text())
chunk_meta = json.loads((RAW / "chunk_meta.json").read_text())
# repo-root Drive map (filename → webViewLink), built by scripts/build_drive_map.py
drive_map_path = HERE.parent.parent / "data" / "drive_links.json"
drive_map: dict[str, str] = (
    json.loads(drive_map_path.read_text()) if drive_map_path.exists() else {}
)
vecs = np.load(RAW / "chunk_vectors.npy")
vecs = vecs / (np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9)

file_to_idx = {p["file"]: i for i, p in enumerate(papers)}

# ── per-paper APA extras (parallel to papers.json order) ─────────────────────
keywords: list[list[str]] = []
subjects: list[list[str]] = []
affils: list[list[str]] = []
for p in papers:
    rec = manifest.get(p["file"], {})
    keywords.append(clean_str_list(rec.get("keywords"), 8))
    subjects.append(clean_str_list(rec.get("subjects"), 6))
    affils.append(clean_str_list(rec.get("affiliations"), 4))

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
    },
)

# ── oeuvre centroids + eligible x all cosine matrix (daily game) ─────────────
paper_chunks: dict[int, list[int]] = defaultdict(list)
for ci, m in enumerate(chunk_meta):
    pi = file_to_idx.get(m["file_path"])
    if pi is not None:
        paper_chunks[pi].append(ci)

cent = np.zeros((len(authors), vecs.shape[1]), dtype=np.float32)
for ai, a in enumerate(authors):
    rows = [ci for pi in a["papers"] for ci in paper_chunks.get(pi, [])]
    if rows:
        v = vecs[rows].mean(axis=0)
        cent[ai] = v / (np.linalg.norm(v) + 1e-9)

eligible = [ai for ai, a in enumerate(authors) if len(a["papers"]) >= MIN_PAPERS_ELIGIBLE]
sim = cent[eligible] @ cent.T  # (n_eligible, n_all)
jdump(
    SRV / "author_game.json",
    {
        "names": [a["name"] for a in authors],
        "nPapers": [len(a["papers"]) for a in authors],
        "eligible": eligible,
        "sim": [[round(float(x), 3) for x in row] for row in sim],
    },
)
print("done.")
