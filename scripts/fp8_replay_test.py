#!/usr/bin/env python3
"""FP8 quant validation via cache replay.

Replays cached BF16 entity-extraction prompts (from LightRAG's
kv_store_llm_response_cache.json, entries keyed `{mode}:extract:{hash}` with
`original_prompt` stored) against a live FP8 vLLM endpoint at temperature 0 /
fixed seed, then diffs the FP8 outputs against the cached BF16 outputs.

Reports:
  - exact-match rate (strict + whitespace-normalized)
  - entity-level agreement (per-pair Jaccard on entity names; relation pairs)
  - FP8 vs BF16 aggregate precision/recall on the union of extracted records
  - latency + throughput at production-like concurrency

Run on a compute node (the cache is ~10GB; never json.load it on a login node).
"""

import argparse
import asyncio
import json
import random
import re
import statistics
import sys
import time

try:
    from openai import AsyncOpenAI
except ImportError:
    sys.exit("openai package required (use the ingest venv)")

# This LightRAG version emits newline-separated records with <|#|> delimiters:
#   entity<|#|>NAME<|#|>TYPE<|#|>DESC
#   relation<|#|>SRC<|#|>TGT<|#|>REL_TYPE<|#|>DESC
# (verified against kv_store_llm_response_cache.json; the older paren format
#  ("entity"<|>...) is kept as a fallback so the parser works on both eras)
LINE_RE = re.compile(
    r"^\s*(entity|relation(?:ship)?)\s*<\|#\|>\s*(.*?)\s*$",
    re.MULTILINE | re.IGNORECASE,
)
HASH_SPLIT_RE = re.compile(r"\s*<\|#\|>\s*")
PAREN_RE = re.compile(
    r'\(\s*"(entity|relationship)"\s*<\|>\s*(.*?)\s*\)', re.DOTALL
)
PAREN_SPLIT_RE = re.compile(r"\s*<\|>\s*")
WS_RE = re.compile(r"\s+")


def parse_records(text: str):
    """Extract (entities, relations) sets from LightRAG extraction output."""
    entities, relations = set(), set()
    for kind, body in LINE_RE.findall(text or ""):
        parts = HASH_SPLIT_RE.split(body)
        if kind.lower() == "entity" and parts and parts[0]:
            entities.add(parts[0].strip().strip('"').lower())
        elif len(parts) >= 2:
            a = parts[0].strip().strip('"').lower()
            b = parts[1].strip().strip('"').lower()
            if a and b:
                relations.add((a, b) if a <= b else (b, a))
    for kind, body in PAREN_RE.findall(text or ""):
        parts = PAREN_SPLIT_RE.split(body)
        if kind == "entity" and parts and parts[0]:
            entities.add(parts[0].strip().strip('"').lower())
        elif len(parts) >= 2:
            a = parts[0].strip().strip('"').lower()
            b = parts[1].strip().strip('"').lower()
            if a and b:
                relations.add((a, b) if a <= b else (b, a))
    return entities, relations


def jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    return len(a & b) / max(1, len(a | b))


def norm(s: str) -> str:
    return WS_RE.sub(" ", (s or "").strip())


async def replay_one(client, model, sem, entry, max_tokens, results):
    async with sem:
        t0 = time.monotonic()
        try:
            resp = await client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": entry["prompt"]}],
                temperature=0.0,
                seed=42,
                max_tokens=max_tokens,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            dt = time.monotonic() - t0
            out = resp.choices[0].message.content or ""
            usage = getattr(resp, "usage", None)
            results.append(
                {
                    "key": entry["key"],
                    "bf16": entry["cached"],
                    "fp8": out,
                    "latency_s": dt,
                    "out_tokens": getattr(usage, "completion_tokens", 0) or 0,
                    "in_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                    "error": None,
                }
            )
        except Exception as e:  # noqa: BLE001 - record and continue
            results.append(
                {"key": entry["key"], "error": f"{type(e).__name__}: {e}"}
            )


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", required=True)
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--n", type=int, default=600)
    ap.add_argument("--concurrency", type=int, default=16)
    ap.add_argument("--max-tokens", type=int, default=4096)
    ap.add_argument("--min-prompt-chars", type=int, default=2000,
                    help="skip short prompts (gleaning continuations lack history)")
    ap.add_argument("--report", default="fp8_replay_report.json")
    ap.add_argument("--pairs", default="",
                    help="optional JSONL path to dump all (bf16, fp8) output pairs")
    args = ap.parse_args()

    print(f"[replay] loading cache: {args.cache}", flush=True)
    t0 = time.monotonic()
    with open(args.cache, "r", encoding="utf-8") as f:
        cache = json.load(f)
    print(f"[replay] cache loaded: {len(cache)} entries in "
          f"{time.monotonic() - t0:.0f}s", flush=True)

    # Filter: extraction entries with a full standalone prompt.
    candidates = []
    for key, val in cache.items():
        if ":extract:" not in key or not isinstance(val, dict):
            continue
        prompt = val.get("original_prompt") or ""
        cached = val.get("return") or ""
        if not prompt or not cached:
            continue
        if len(prompt) < args.min_prompt_chars:
            continue  # gleaning continuation w/o history context
        candidates.append({"key": key, "prompt": prompt, "cached": cached})
    del cache
    print(f"[replay] replayable extraction entries: {len(candidates)}",
          flush=True)
    if not candidates:
        sys.exit("no replayable extraction entries found — check cache format")

    rng = random.Random(42)
    sample = (rng.sample(candidates, args.n)
              if len(candidates) > args.n else candidates)
    del candidates
    print(f"[replay] replaying {len(sample)} prompts at "
          f"concurrency={args.concurrency}", flush=True)

    client = AsyncOpenAI(base_url=args.endpoint, api_key="none", timeout=600)
    sem = asyncio.Semaphore(args.concurrency)
    results: list[dict] = []
    t_run = time.monotonic()
    done = 0

    async def tracked(e):
        nonlocal done
        await replay_one(client, args.model, sem, e, args.max_tokens, results)
        done += 1
        if done % 50 == 0:
            print(f"[replay] {done}/{len(sample)} done "
                  f"({time.monotonic() - t_run:.0f}s elapsed)", flush=True)

    await asyncio.gather(*(tracked(e) for e in sample))
    wall = time.monotonic() - t_run

    ok = [r for r in results if not r.get("error")]
    errs = [r for r in results if r.get("error")]

    if args.pairs:
        with open(args.pairs, "w", encoding="utf-8") as f:
            for r in ok:
                f.write(json.dumps({"key": r["key"], "bf16": r["bf16"],
                                    "fp8": r["fp8"]}) + "\n")
        print(f"[replay] pairs dumped: {args.pairs}", flush=True)

    # ── Quality ──────────────────────────────────────────────────────────
    exact = sum(1 for r in ok if (r["bf16"] or "").strip() == (r["fp8"] or "").strip())
    nexact = sum(1 for r in ok if norm(r["bf16"]) == norm(r["fp8"]))
    ent_j, rel_j = [], []
    bf_e_all, fp_e_all, bf_r_all, fp_r_all = set(), set(), set(), set()
    for r in ok:
        be, br = parse_records(r["bf16"])
        fe, fr = parse_records(r["fp8"])
        ent_j.append(jaccard(be, fe))
        rel_j.append(jaccard(br, fr))
        # Key-scope the union sets so identical names in different chunks don't collide
        bf_e_all |= {(r["key"], e) for e in be}
        fp_e_all |= {(r["key"], e) for e in fe}
        bf_r_all |= {(r["key"], x) for x in br}
        fp_r_all |= {(r["key"], x) for x in fr}

    def pr(fp: set, bf: set):
        p = len(fp & bf) / max(1, len(fp))
        rec = len(fp & bf) / max(1, len(bf))
        return p, rec

    ep, er = pr(fp_e_all, bf_e_all)
    rp, rr = pr(fp_r_all, bf_r_all)

    # ── Speed ────────────────────────────────────────────────────────────
    lats = sorted(r["latency_s"] for r in ok)
    toks = sum(r["out_tokens"] for r in ok)
    summary = {
        "n_requested": len(sample),
        "n_ok": len(ok),
        "n_errors": len(errs),
        "exact_match": exact / max(1, len(ok)),
        "normalized_match": nexact / max(1, len(ok)),
        "entity_jaccard_mean": statistics.mean(ent_j) if ent_j else 0,
        "entity_jaccard_median": statistics.median(ent_j) if ent_j else 0,
        "relation_jaccard_mean": statistics.mean(rel_j) if rel_j else 0,
        "entity_precision_vs_bf16": ep,
        "entity_recall_vs_bf16": er,
        "relation_precision_vs_bf16": rp,
        "relation_recall_vs_bf16": rr,
        "parsed_bf16_entities_total": len(bf_e_all),
        "parsed_fp8_entities_total": len(fp_e_all),
        "latency_mean_s": statistics.mean(lats) if lats else 0,
        "latency_p50_s": lats[len(lats) // 2] if lats else 0,
        "latency_p90_s": lats[int(len(lats) * 0.9)] if lats else 0,
        "wall_s": wall,
        "output_tok_per_s": toks / max(1e-9, wall),
        "calls_per_hr_at_conc": len(ok) / max(1e-9, wall) * 3600,
        "concurrency": args.concurrency,
    }

    with open(args.report, "w", encoding="utf-8") as f:
        json.dump({"summary": summary,
                   "errors": [e["error"] for e in errs][:20],
                   "worst_entity_jaccard": sorted(
                       ({"key": r["key"], "j": jaccard(*[
                           parse_records(r["bf16"])[0],
                           parse_records(r["fp8"])[0]])} for r in ok),
                       key=lambda x: x["j"])[:15]},
                  f, indent=2)

    for k, v in summary.items():
        print(f"RESULT|{k}={v:.4f}" if isinstance(v, float) else f"RESULT|{k}={v}",
              flush=True)
    print(f"[replay] report written: {args.report}", flush=True)

    # Go/no-go gate: entity agreement >= 0.97, no error flood, AND the parser
    # actually extracted records — jaccard(empty, empty) = 1.0, so a broken
    # parser would otherwise produce a vacuous PASS (job 49454242).
    gate = (summary["entity_jaccard_mean"] >= 0.97
            and summary["n_errors"] <= len(sample) * 0.05
            and summary["parsed_bf16_entities_total"] > 0
            and summary["parsed_fp8_entities_total"] > 0)
    print(f"RESULT|GATE={'PASS' if gate else 'FAIL'}", flush=True)
    return 0 if gate else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
