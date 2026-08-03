"""Turn the HPC layout artifacts into the browser payload.

Runs after hpc_layout.py + pc_export_kg.py (see hpc_out/). The shape of what ships
changed with the full corpus: at 445k passages the old string sidecar was ~118 MB
and the bundled passage text ~1.8 GB, so neither ships at all any more. Chunk ids
are packed as (docIdx, chunkNum) and rebuilt in the browser; passage prose is read
from the PC on demand; the kNN graph is a separate binary the client only fetches
when the radio actually needs it.

Writes ../public/data/:
  atlas.bin / atlas.meta.json   columnar chunks incl. compact chunk ids
  doc_hashes.json               docIdx -> 32-hex hash (id reconstruction)
  papers.json clusters.json voids.json heightmap.bin
  constellations.json           top entities placed on the map
  knn.bin / knn.meta.json       lazy-loaded neighbour graph
"""

import json
import re
import shutil
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
SRC = HERE / "hpc_out"
PUB = HERE.parent / "public" / "data"
PUB.mkdir(parents=True, exist_ok=True)

TOP_ENTITIES = 600
MAX_EDGES = 2500
MAX_MEMBERS = 12

# paper furniture the atlas refuses to label the sky with (mirrors derive.ts)
GENERIC = re.compile(
    r"^(table|figure|fig|study|experiment|exp|appendix|equation|section|chapter|"
    r"participants?|stimuli|procedure|methods?|results?|discussion|introduction|"
    r"abstract|model|step|phase|task|item|block)\.?\s*\d*[a-z]?$",
    re.I,
)


def rf(x, nd=4):
    return round(float(x), nd)


def pack(path: Path, meta_path: Path, columns) -> None:
    buf = bytearray()
    sections = []
    for name, arr in columns:
        while len(buf) % arr.dtype.itemsize:
            buf += b"\x00"
        sections.append({"name": name, "dtype": str(arr.dtype),
                         "offset": len(buf), "count": int(arr.size)})
        buf += arr.tobytes()
    path.write_bytes(bytes(buf))
    meta_path.write_text(json.dumps({"n": int(columns[2][1].size), "sections": sections}))
    print(f"wrote {path.name} ({path.stat().st_size/1e6:.2f} MB)")


def main() -> None:
    z = np.load(SRC / "atlas_cols.npz")
    n = int(z["cluster"].size)
    doc_hashes = json.loads((SRC / "doc_hashes.json").read_text())
    print(f"{n} chunks, {len(doc_hashes)} documents")

    pack(PUB / "atlas.bin", PUB / "atlas.meta.json", [
        ("pos2", z["pos2"].astype(np.float32)),
        ("pos3", z["pos3"].astype(np.float32)),
        ("cluster", z["cluster"].astype(np.int16)),
        ("paper", z["paper"].astype(np.int32)),
        ("year", z["year"].astype(np.int16)),
        ("docIdx", z["docIdx"].astype(np.int32)),
        ("chunkNum", z["chunkNum"].astype(np.int32)),
    ])
    (PUB / "doc_hashes.json").write_text(json.dumps(doc_hashes, separators=(",", ":")))

    # ── straight copies ──────────────────────────────────────────────────────
    for f in ("papers.json", "clusters.json", "voids.json", "heightmap.bin"):
        shutil.copy(SRC / f, PUB / f)
        print(f"wrote {f} ({(PUB / f).stat().st_size/1e6:.2f} MB)")

    # ── kNN as its own binary: the radio is opt-in, so this loads lazily ─────
    k = np.load(SRC / "knn.npz")
    idx, sim = k["idx"].astype(np.int32), k["sim"].astype(np.float32)
    kk = int(idx.shape[1])
    buf = bytearray()
    sections = []
    for name, arr in (("idx", idx.ravel()), ("sim", sim.ravel())):
        sections.append({"name": name, "dtype": str(arr.dtype),
                         "offset": len(buf), "count": int(arr.size)})
        buf += arr.tobytes()
    (PUB / "knn.bin").write_bytes(bytes(buf))
    (PUB / "knn.meta.json").write_text(json.dumps({"n": n, "k": kk, "sections": sections}))
    print(f"wrote knn.bin ({(PUB/'knn.bin').stat().st_size/1e6:.2f} MB, k={kk})")

    # ── constellations: place entities by their member chunks ────────────────
    kg = json.loads((SRC / "kg_top.json").read_text())
    # chunk id -> atlas index, rebuilt from the compact columns
    doc_idx, chunk_num = z["docIdx"], z["chunkNum"]
    id_to_idx = {}
    for i in range(n):
        d = int(doc_idx[i])
        if d >= 0:
            id_to_idx[f"doc-{doc_hashes[d]}-chunk-{int(chunk_num[i]):03d}"] = i

    p2 = z["pos2"].reshape(-1, 2)
    p3 = z["pos3"].reshape(-1, 3)
    ents = []
    for e in kg["entities"]:
        if GENERIC.match(e["id"].strip()):
            continue
        members = [id_to_idx[c] for c in e.get("sourceChunks", []) if c in id_to_idx]
        if not members:
            continue
        ents.append({
            "id": e["id"],
            "type": e.get("type", ""),
            "desc": e.get("desc", ""),
            "deg": e.get("deg", 0),
            "nChunks": len(members),
            "pos2": [rf(v) for v in p2[members].mean(axis=0)],
            "pos3": [rf(v) for v in p3[members].mean(axis=0)],
            "chunkIdx": members[:MAX_MEMBERS],
        })
        if len(ents) >= TOP_ENTITIES:
            break
    keep = {e["id"] for e in ents}
    edges = [e for e in kg["edges"] if e["s"] in keep and e["t"] in keep][:MAX_EDGES]
    (PUB / "constellations.json").write_text(
        json.dumps({"entities": ents, "edges": edges}, separators=(",", ":")))
    print(f"wrote constellations.json ({(PUB/'constellations.json').stat().st_size/1e6:.2f} MB)"
          f" — {len(ents)} entities, {len(edges)} edges")

    # ── retire the artifacts that no longer ship ─────────────────────────────
    for stale in ("atlas.json", "atlas_strings.json", "knn.json"):
        p = PUB / stale
        if p.exists():
            p.unlink()
            print(f"removed {stale} (superseded at full scale)")
    total = sum(f.stat().st_size for f in PUB.glob("*") if f.is_file())
    print(f"\npublic/data total: {total/1e6:.1f} MB")


if __name__ == "__main__":
    main()
