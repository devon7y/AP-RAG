"""Reduce the PC's knowledge graph to the atlas's constellation set, on the PC.

The full graph is a 2.67 GB graphml (~3.6M entities, ~8.1M relations) — far too
big to move, and the atlas only draws the few hundred best-connected entities.
So this stream-parses it in place and writes a few-MB summary.

Two passes (degree first, because "top" isn't known until every edge is seen):
  1. edges only -> degree per entity
  2. nodes in the top set -> type/description/source chunks
     edges with both ends in the top set -> weighted relations

Writes into --out (default C:\\rag_server\\atlas_export):
  kg_top.json  {entities: [{id,type,desc,deg,sourceChunks}], edges: [{s,t,w,desc,kw}]}

Usage (on the PC):
  C:\\rag_server\\venv\\Scripts\\python pc_export_kg.py
"""

import argparse
import json
import time
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

NS = "{http://graphml.graphdrawing.org/xmlns}"
GRAPHML = r"C:\rag_server\rag_storage_full\graph_chunk_entity_relation.graphml"
TOP_ENT = 900        # a little headroom; the pipeline trims to its own cap
MAX_EDGES = 6000
MAX_SRC_CHUNKS = 40  # chunk ids kept per entity (for map placement)


def key_map(path: str) -> dict:
    """graphml <key id> -> attr.name (read from the header only)."""
    keys = {}
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag == f"{NS}key":
            keys[el.get("id")] = el.get("attr.name")
            el.clear()
        elif el.tag in (f"{NS}node", f"{NS}edge"):
            el.clear()
            break
    return keys


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--graphml", default=GRAPHML)
    ap.add_argument("--out", default=r"C:\rag_server\atlas_export")
    ap.add_argument("--top", type=int, default=TOP_ENT)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    keys = key_map(args.graphml)
    print(f"graphml keys: {keys}", flush=True)

    # ── pass 1: degree ────────────────────────────────────────────────────────
    t0 = time.time()
    deg: Counter = Counter()
    n_edges = 0
    for _, el in ET.iterparse(args.graphml, events=("end",)):
        if el.tag == f"{NS}edge":
            deg[el.get("source")] += 1
            deg[el.get("target")] += 1
            n_edges += 1
            if n_edges % 1_000_000 == 0:
                print(f"  pass1 {n_edges/1e6:.0f}M edges  {time.time()-t0:.0f}s", flush=True)
            el.clear()
        elif el.tag == f"{NS}node":
            el.clear()
    print(f"pass1: {n_edges} edges, {len(deg)} entities, {time.time()-t0:.0f}s", flush=True)

    top = [nid for nid, _ in deg.most_common(args.top)]
    top_set = set(top)

    # ── pass 2: node data + inter-top edges ──────────────────────────────────
    t1 = time.time()
    ents: dict[str, dict] = {}
    edges_out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for _, el in ET.iterparse(args.graphml, events=("end",)):
        if el.tag == f"{NS}node":
            nid = el.get("id")
            if nid in top_set:
                d = {keys.get(x.get("key")): x.text for x in el.findall(f"{NS}data")}
                src = (d.get("source_id") or "").split("<SEP>")
                ents[nid] = {
                    "id": nid,
                    "type": (d.get("entity_type") or "").strip('"'),
                    "desc": (d.get("description") or "")[:300],
                    "deg": deg[nid],
                    "sourceChunks": [s for s in src if s][:MAX_SRC_CHUNKS],
                }
            el.clear()
        elif el.tag == f"{NS}edge":
            s, t = el.get("source"), el.get("target")
            if s in top_set and t in top_set and s != t:
                k = (s, t) if s < t else (t, s)
                if k not in seen:
                    seen.add(k)
                    d = {keys.get(x.get("key")): x.text for x in el.findall(f"{NS}data")}
                    try:
                        w = float(d.get("weight") or 1)
                    except ValueError:
                        w = 1.0
                    edges_out.append(
                        {
                            "s": s,
                            "t": t,
                            "w": w,
                            "desc": (d.get("description") or "")[:200],
                            "kw": (d.get("keywords") or "")[:100],
                        }
                    )
            el.clear()
    print(f"pass2: {len(ents)} entities, {len(edges_out)} inter-top edges, "
          f"{time.time()-t1:.0f}s", flush=True)

    edges_out.sort(key=lambda e: -e["w"])
    edges_out = edges_out[:MAX_EDGES]
    payload = {"entities": [ents[n] for n in top if n in ents], "edges": edges_out}
    p = out / "kg_top.json"
    p.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {p} ({p.stat().st_size/1e6:.2f} MB)", flush=True)


if __name__ == "__main__":
    main()
