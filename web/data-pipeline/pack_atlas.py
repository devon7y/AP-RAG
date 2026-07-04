"""Pack atlas.json's numeric columns into a binary buffer (scale prep).

Runs AFTER pipeline.py. The 175-paper test corpus ships a 2.6 MB atlas.json;
the full ~9.7k-paper corpus (~500k chunks) would be ~150 MB as JSON. Numeric
columns as raw typed arrays stay ~14 MB and parse in O(1). Strings (snippet /
section / chunkId) move to a sidecar JSON — at full scale that sidecar should
move server-side behind /api/atlas/chunk-style lookups; the loader in
lib/atlas/data.ts is the single seam.

Writes:
  ../public/data/atlas.bin           pos2 f32 | pos3 f32 | cluster i16 | paper i32 | year i16
  ../public/data/atlas.meta.json     {n, sections: [{name,dtype,offset,count}]}
  ../public/data/atlas_strings.json  {snippet, section, chunkId}
"""

import json
from pathlib import Path

import numpy as np

PUB = Path(__file__).parent.parent / "public" / "data"

atlas = json.loads((PUB / "atlas.json").read_text())
n = atlas["n"]

columns = [
    ("pos2", np.asarray(atlas["pos2"], dtype=np.float32)),
    ("pos3", np.asarray(atlas["pos3"], dtype=np.float32)),
    ("cluster", np.asarray(atlas["cluster"], dtype=np.int16)),
    ("paper", np.asarray(atlas["paper"], dtype=np.int32)),
    ("year", np.asarray(atlas["year"], dtype=np.int16)),
]

buf = bytearray()
sections = []
for name, arr in columns:
    align = arr.dtype.itemsize
    while len(buf) % align:
        buf += b"\x00"
    sections.append(
        {"name": name, "dtype": str(arr.dtype), "offset": len(buf), "count": int(arr.size)}
    )
    buf += arr.tobytes()

(PUB / "atlas.bin").write_bytes(bytes(buf))
(PUB / "atlas.meta.json").write_text(json.dumps({"n": n, "sections": sections}))
(PUB / "atlas_strings.json").write_text(
    json.dumps(
        {"snippet": atlas["snippet"], "section": atlas["section"], "chunkId": atlas["chunkId"]},
        separators=(",", ":"),
    )
)
for f in ("atlas.bin", "atlas.meta.json", "atlas_strings.json"):
    p = PUB / f
    print(f"wrote {p} ({p.stat().st_size / 1e6:.2f} MB)")
