r"""
pc_measure_serving.py — measure §3.7 serving numbers on the PC, from the PC.

Hits the local query server (:8001) and Qdrant (:6333) and prints a JSON report:
  - per-mode /retrieve latency (retrieval only, no answer LLM) over N repeats
  - one /query end-to-end sample per mode (includes gpt-5-mini synthesis)
  - a small concurrency test (C simultaneous /retrieve calls)
  - process RSS (query server, qdrant, embed server) + GPU VRAM
  - qdrant collection point counts

Usage: venv\Scripts\python pc_measure_serving.py [--modes naive,local,global,hybrid]
"""

import argparse
import concurrent.futures as cf
import json
import statistics
import subprocess
import time

import httpx

QS = "http://localhost:8001"
QD = "http://localhost:6333"

QUESTIONS = [
    "What is the relationship between word frequency and lexical decision reaction times?",
    "How does semantic diversity influence word recognition?",
    "What role does entropy play in models of semantic memory?",
    "Which brain regions are implicated in humor comprehension?",
]


def proc_rss() -> dict:
    """RSS of python/qdrant processes via PowerShell (MB)."""
    ps = (
        "Get-Process | Where-Object {$_.ProcessName -match 'python|qdrant'} | "
        "Select-Object ProcessName,Id,@{n='rss_mb';e={[math]::Round($_.WorkingSet64/1MB)}},"
        "@{n='cmd';e={$_.Path}} | ConvertTo-Json"
    )
    try:
        out = subprocess.run(["powershell", "-Command", ps],
                             capture_output=True, text=True, timeout=30).stdout
        return {"processes": json.loads(out)}
    except Exception as e:
        return {"error": str(e)}


def gpu() -> str:
    try:
        return subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total,utilization.gpu",
             "--format=csv,noheader"], capture_output=True, text=True, timeout=15
        ).stdout.strip()
    except Exception as e:
        return str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--modes", default="naive,local,global,hybrid")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--skip-query", action="store_true", help="skip /query (no LLM cost)")
    args = ap.parse_args()
    modes = args.modes.split(",")

    http = httpx.Client(timeout=600)
    report = {"qdrant": {}, "modes": {}, "concurrency": {}, "rss_before": proc_rss(),
              "gpu": gpu()}

    for col in ("lightrag_vdb_chunks", "lightrag_vdb_entities", "lightrag_vdb_relationships"):
        try:
            r = http.post(f"{QD}/collections/{col}/points/count", json={"exact": True})
            report["qdrant"][col] = r.json()["result"]["count"]
        except Exception as e:
            report["qdrant"][col] = f"err {e}"

    for mode in modes:
        lat = []
        counts = None
        for i in range(args.repeats):
            q = QUESTIONS[i % len(QUESTIONS)]
            t0 = time.perf_counter()
            r = http.post(f"{QS}/retrieve", json={"question": q, "mode": mode})
            dt = time.perf_counter() - t0
            if r.status_code != 200:
                lat.append(f"HTTP {r.status_code}")
                continue
            lat.append(round(dt, 2))
            d = r.json().get("data", r.json())
            counts = {k: len(v) for k, v in d.items() if isinstance(v, list)}
        report["modes"][mode] = {"retrieve_s": lat, "result_counts": counts}
        if not args.skip_query:
            t0 = time.perf_counter()
            r = http.post(f"{QS}/query", json={"question": QUESTIONS[0], "mode": mode})
            report["modes"][mode]["query_e2e_s"] = round(time.perf_counter() - t0, 2)
            report["modes"][mode]["query_http"] = r.status_code

    # concurrency: C simultaneous hybrid /retrieve
    def one(q):
        t0 = time.perf_counter()
        r = http.post(f"{QS}/retrieve", json={"question": q, "mode": "hybrid"})
        return time.perf_counter() - t0 if r.status_code == 200 else None

    with cf.ThreadPoolExecutor(args.concurrency) as ex:
        ts = list(ex.map(one, (QUESTIONS * 3)[: args.concurrency * 2]))
    ok = [t for t in ts if t]
    if ok:
        report["concurrency"] = {
            "n": len(ok), "parallel": args.concurrency,
            "mean_s": round(statistics.mean(ok), 2),
            "max_s": round(max(ok), 2),
        }
    report["rss_after"] = proc_rss()
    report["gpu_after"] = gpu()
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
