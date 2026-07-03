"""Export all chunk vectors + payloads from the PC's Qdrant into local .npy/.json.

Scrolls lightrag_vdb_chunks (workspace "_") in batches with vectors. Writes:
  raw/chunk_vectors.npy   float32 [N, 4096]
  raw/chunk_meta.json     [{qid, chunk_id, doc_id, file_path, content}]  (same order)
"""

import json
import urllib.request
from pathlib import Path

import numpy as np

QDRANT = "http://100.98.84.84:6333"
COLL = "lightrag_vdb_chunks"
RAW = Path(__file__).parent / "raw"
BATCH = 256


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        QDRANT + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def main() -> None:
    vectors: list[list[float]] = []
    meta: list[dict] = []
    offset = None
    while True:
        body = {"limit": BATCH, "with_payload": True, "with_vector": True}
        if offset is not None:
            body["offset"] = offset
        res = post(f"/collections/{COLL}/points/scroll", body)["result"]
        for p in res["points"]:
            pl = p["payload"]
            vectors.append(p["vector"])
            meta.append(
                {
                    "qid": p["id"],
                    "chunk_id": pl.get("id"),
                    "doc_id": pl.get("full_doc_id"),
                    "file_path": pl.get("file_path"),
                    "content": pl.get("content", ""),
                }
            )
        offset = res.get("next_page_offset")
        print(f"\r{len(vectors)} points", end="", flush=True)
        if offset is None:
            break
    print()
    arr = np.asarray(vectors, dtype=np.float32)
    np.save(RAW / "chunk_vectors.npy", arr)
    (RAW / "chunk_meta.json").write_text(json.dumps(meta))
    print(f"saved {arr.shape} vectors, {len(meta)} meta records")


if __name__ == "__main__":
    main()
