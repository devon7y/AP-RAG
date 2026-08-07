"""Compare fp16-4096 and fp16-1024 stores against the canonical fp32 store.

Answers ONE question: what does each variant cost in retrieval quality?

Latency is deliberately NOT the headline here. This runs on a 192-core / 768 GB
Ror node where everything is RAM-cached; that tells us nothing about a 31 GB PC
whose whole problem is page-cache misses. Latency must be measured on the PC
after transfer. What Ror CAN answer exactly -- because all three stores are
mounted at once -- is whether the rankings agree.

The 1024d store requires the QUERY to be truncated to 1024 dims too. That is
the same change query_server.py will need if this variant wins; a mismatch there
would silently return garbage rather than error.
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request

H = {"Content-Type": "application/json"}
COLLECTIONS = ("lightrag_vdb_chunks", "lightrag_vdb_entities",
               "lightrag_vdb_relationships")


def post(url, payload, timeout=1800):
    r = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=H)
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read())


def search(base, coll, vec, params=None, limit=40):
    body = {"query": vec, "limit": limit, "with_payload": False,
            "filter": {"must": [{"key": "workspace_id", "match": {"value": "_"}}]}}
    if params:
        body["params"] = params
    t0 = time.perf_counter()
    r = post(f"{base}/collections/{coll}/points/query", body)
    return time.perf_counter() - t0, [p["id"] for p in r["result"]["points"]]


def recall_at(ref: list, got: list, k: int) -> float:
    a, b = set(ref[:k]), set(got[:k])
    return len(a & b) / max(1, len(a))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="canonical fp32 store base URL")
    ap.add_argument("--fp16", required=True,
                    help="candidate store base URL (fp16 or uint8)")
    ap.add_argument("--label", default="candidate", help="name for the candidate")
    ap.add_argument("--fp1k", help="optional second candidate (truncated dims)")
    ap.add_argument("--queries", required=True, help="query_vectors.json")
    ap.add_argument("--dims", type=int, default=1024)
    args = ap.parse_args()

    q = json.load(open(args.queries))
    vecs = q["vectors"]
    print(f"{len(vecs)} real query vectors, dim={len(vecs[0])}\n", flush=True)

    for coll in COLLECTIONS:
        print(f"=== {coll} ===", flush=True)
        names = [args.label] + (["truncated"] if args.fp1k else [])
        rows = {nm: {"r10": [], "r40": [], "t": [], "top1": 0} for nm in names}
        n = 0
        for v in vecs:
            try:
                # reference: canonical fp32, high ef so ANN error is minimal
                _, ref = search(args.src, coll, v, {"hnsw_ef": 256})
                if not ref:
                    continue
                ta, a = search(args.fp16, coll, v)   # production params
                b = None
                if args.fp1k:
                    _, b = search(args.fp1k, coll, v[:args.dims])
            except Exception as e:
                print(f"  query failed: {type(e).__name__}: {e}", flush=True)
                continue
            n += 1
            pairs = [(args.label, a)] + ([("truncated", b)] if b is not None else [])
            for name, got in pairs:
                rows[name]["r10"].append(recall_at(ref, got, 10))
                rows[name]["r40"].append(recall_at(ref, got, 40))
                rows[name]["t"].append(ta)
                if got and got[0] == ref[0]:
                    rows[name]["top1"] += 1

        print(f"  {'variant':12s} {'recall@10':>10s} {'recall@40':>10s} "
              f"{'top1 same':>11s}")
        print("  " + "-" * 46)
        for name in names:
            d = rows[name]
            if not d["r40"]:
                print(f"  {name:12s} (no data)")
                continue
            print(f"  {name:12s} {statistics.mean(d['r10']):10.3f} "
                  f"{statistics.mean(d['r40']):10.3f} {d['top1']:>7d}/{n:<3d}")
        print(flush=True)

    print("Recall is vs the canonical fp32 ranking on the SAME node, so this "
          "isolates format loss from any latency/caching effect. Latency here is "
          "meaningless for the PC -- everything is RAM-cached on a 32-core node.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
