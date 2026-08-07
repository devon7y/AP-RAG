"""Per-collection recall for ScalarQuantization(int8), rescore ON vs OFF.

Chunks measured 0.979 (rescore off) / 0.996 (on), but chunks is the smallest and
easiest collection. Entities and relationships have different vector
distributions, so the result must be re-measured per collection rather than
assumed to carry over -- assuming exactly that is what made the uint8 attempt
waste a 2h38m conversion.

Also reports the Qdrant process RSS after each quantization change, because the
deciding question for the 31 GB serving PC is not only recall but whether int8
data stays out of RAM when always_ram=false. Prior evidence says it does NOT
(entities' 14.7 GB of int8 showed up as ~15.4 GB private), which is why
relationships' 33 GB OOMed that box before.

Ground truth is captured BEFORE any quantization change, with quantization
ignored, at high ef.
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import time
import urllib.request

H = {"Content-Type": "application/json"}
FILT = {"must": [{"key": "workspace_id", "match": {"value": "_"}}]}


def req(base, method, path, payload=None, timeout=3600):
    r = urllib.request.Request(base + path,
                               data=json.dumps(payload).encode() if payload else None,
                               headers=H, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def search(base, coll, vec, params=None, limit=40):
    body = {"query": vec, "limit": limit, "with_payload": False, "filter": FILT}
    if params:
        body["params"] = params
    t0 = time.perf_counter()
    st, r = req(base, "POST", f"/collections/{coll}/points/query", body)
    if st != 200:
        raise RuntimeError(str(r)[:200])
    return time.perf_counter() - t0, [p["id"] for p in r["result"]["points"]]


def wait_green(base, coll, tag, timeout=7200):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st, r = req(base, "GET", f"/collections/{coll}")
        if st == 200 and r["result"]["status"] == "green":
            print(f"    {tag}: green after {time.time()-t0:.0f}s "
                  f"(idx={r['result']['indexed_vectors_count']:,})", flush=True)
            return True
        time.sleep(15)
    print(f"    {tag}: TIMEOUT", flush=True)
    return False


def qdrant_rss_gb() -> float:
    """Resident size of the qdrant process, to see what int8 actually costs."""
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-C", "qdrant"],
                             capture_output=True, text=True, timeout=30).stdout
        kb = sum(int(x) for x in out.split() if x.strip().isdigit())
        return kb / 1024 / 1024
    except Exception:
        return float("nan")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--queries", required=True)
    ap.add_argument("--collections", nargs="+", required=True)
    ap.add_argument("--always-ram", default="false", choices=["true", "false"])
    args = ap.parse_args()

    vecs = json.load(open(args.queries))["vectors"]
    print(f"{len(vecs)} real query vectors; always_ram={args.always_ram}\n",
          flush=True)

    for coll in args.collections:
        print(f"================ {coll} ================", flush=True)
        st, info = req(args.base, "GET", f"/collections/{coll}")
        if st != 200:
            print(f"  cannot read collection: {info}"); continue
        pts = info["result"]["points_count"]
        cur_q = info["result"]["config"].get("quantization_config")
        print(f"  points={pts:,} current_quant={json.dumps(cur_q)} "
              f"qdrantRSS={qdrant_rss_gb():.1f}GB", flush=True)

        print("  capturing fp32 ground truth (quantization ignored, ef=256)...",
              flush=True)
        truth, tref = [], []
        for v in vecs:
            dt, ids = search(args.base, coll, v,
                             {"quantization": {"ignore": True}, "hnsw_ef": 256})
            truth.append(ids); tref.append(dt)
        print(f"    reference p50 {statistics.median(tref)*1000:.0f} ms", flush=True)

        print(f"  enabling int8 scalar (quantile 0.99, "
              f"always_ram={args.always_ram})...", flush=True)
        st, r = req(args.base, "PATCH", f"/collections/{coll}",
                    {"quantization_config": {
                        "scalar": {"type": "int8", "quantile": 0.99,
                                   "always_ram": args.always_ram == "true"}}})
        if st != 200:
            print(f"    patch failed: {r}"); continue
        if not wait_green(args.base, coll, "int8 build"):
            continue
        print(f"    qdrantRSS after int8: {qdrant_rss_gb():.1f}GB", flush=True)

        print(f"\n  {'condition':22s} {'recall@10':>10s} {'recall@40':>10s} "
              f"{'top1':>8s} {'p50 ms':>9s}")
        print("  " + "-" * 62)
        for label, params in [
            ("int8 rescore=FALSE", {"quantization": {"rescore": False}}),
            ("int8 rescore=TRUE",  {"quantization": {"rescore": True}}),
        ]:
            r10, r40, top1, ts = [], [], 0, []
            for v, ref in zip(vecs, truth):
                try:
                    dt, got = search(args.base, coll, v, params)
                except Exception as e:
                    print(f"    query failed: {type(e).__name__}"); continue
                ts.append(dt)
                if not ref:
                    continue
                r10.append(len(set(ref[:10]) & set(got[:10])) / min(10, len(ref)))
                r40.append(len(set(ref) & set(got)) / len(ref))
                if got and got[0] == ref[0]:
                    top1 += 1
            if r40:
                print(f"  {label:22s} {statistics.mean(r10):10.3f} "
                      f"{statistics.mean(r40):10.3f} {top1:>5d}/{len(r40):<3d} "
                      f"{statistics.median(ts)*1000:9.0f}", flush=True)
        print(flush=True)

    print("Recall is vs the fp32 ranking of the SAME collection, so this is pure "
          "format loss. Latency here is NOT predictive for the 31 GB PC.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
