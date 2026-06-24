#!/usr/bin/env python3
"""
Chunk-size eval — step 2 (LOCAL): generate a synthetic QA set from the corpus.

Two question types, so the eval isn't biased toward chunkers that win at pinpoint
lookup:

  - factual    : answerable by ONE short verbatim excerpt (favors tight chunks).
  - conceptual : requires synthesizing 2-4 verbatim excerpts from DIFFERENT parts
                 of the paper (favors chunkers that keep related evidence together
                 / retrieve a good spread). The golden answer is the UNION of those
                 excerpts; recall@k then rewards retrieving the whole evidence set.

Every excerpt is verbatim-validated (whitespace-normalized substring of the
source) so downstream scoring can locate it for ANY chunker. Runs LOCALLY so the
OPENAI_API_KEY never leaves the Mac.

Usage:
    python scripts/chunk_eval/gen_questions.py \
        --corpus scripts/chunk_eval/corpus.jsonl \
        --out    scripts/chunk_eval/qa.jsonl \
        --factual-per-doc 3 --conceptual-per-doc 2 --model gpt-5-mini

Output: one JSON object per line:
    {qid, doc_id, type: "factual"|"conceptual", question, excerpts: [str, ...]}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

_WS = re.compile(r"\s+")


def _norm(s: str) -> str:
    return _WS.sub(" ", s).strip().lower()


def _sys_prompt(n_fact: int, n_conc: int) -> str:
    return (
        "You build retrieval-evaluation sets for a scientific-paper RAG system. "
        "Given ONE paper's text, write two kinds of questions a researcher might ask. "
        f"({n_fact}) FACTUAL questions: each answerable by ONE short verbatim excerpt "
        "(1-3 sentences, <= 60 words) copied EXACTLY from the paper. "
        f"({n_conc}) CONCEPTUAL questions: each requires SYNTHESIZING information from "
        "MULTIPLE parts of the paper; supply 2-4 short verbatim excerpts copied EXACTLY "
        "from DIFFERENT parts/sections that TOGETHER support the answer. "
        "Rules for ALL excerpts: copy CHARACTER-FOR-CHARACTER from the text — preserve "
        "exact wording, punctuation, spacing, capitalization and hyphenation; do NOT "
        "fix typos, paraphrase, summarize, join non-adjacent sentences, or use ellipses. "
        "Prefer substantive content (methods, results, findings, definitions, claims, "
        "comparisons); NEVER use the references list, author/affiliation lines, page "
        "headers/footers, or the table of contents. Questions must be answerable from "
        "their excerpt(s) alone and must NOT mention 'the paper'/'this study'. "
        "Return strict JSON: "
        '{"factual": [{"question": "...", "excerpt": "..."}], '
        '"conceptual": [{"question": "...", "excerpts": ["...", "..."]}]}'
    )


def gen_for_doc(client, model, text, n_fact, n_conc, max_words):
    words = text.split()
    if len(words) > max_words:
        text = " ".join(words[:max_words])
    kwargs = dict(
        model=model,
        messages=[
            {"role": "system", "content": _sys_prompt(n_fact, n_conc)},
            {"role": "user", "content": f"Write {n_fact} factual and {n_conc} "
             f"conceptual question(s) from this paper:\n\n{text}"},
        ],
        response_format={"type": "json_object"},
    )
    # gpt-5 / o-series reasoning models only accept the default temperature, and
    # default to heavy reasoning that makes full-paper prompts very slow — cap it
    # ("low" is plenty for verbatim excerpt extraction).
    if model.startswith("gpt-5") or model.startswith("o"):
        kwargs["reasoning_effort"] = "medium"  # better verbatim-copy fidelity
    else:
        kwargs["temperature"] = 0.4
    resp = client.chat.completions.create(**kwargs)
    return json.loads(resp.choices[0].message.content)


def _valid_excerpts(items, doc_norm, lo, hi):
    """Keep only verbatim excerpts within the word-count window."""
    out = []
    for ex in items:
        ex = (ex or "").strip()
        wc = len(ex.split())
        if lo <= wc <= hi and _norm(ex) in doc_norm:
            out.append(ex)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--corpus", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--factual-per-doc", type=int, default=3)
    ap.add_argument("--conceptual-per-doc", type=int, default=3)
    ap.add_argument("--model", default=os.environ.get("QA_GEN_MODEL", "gpt-5-mini"))
    ap.add_argument("--workers", type=int, default=8, help="concurrent API calls")
    ap.add_argument("--max-words", type=int, default=9000)
    ap.add_argument("--min-excerpt-words", type=int, default=5)
    ap.add_argument("--max-excerpt-words", type=int, default=70)
    args = ap.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("OPENAI_API_KEY is not set", file=sys.stderr)
        return 1
    try:
        from openai import OpenAI
    except ImportError:
        print("pip install openai", file=sys.stderr)
        return 1

    # Per-request timeout + retries: a single stalled call must not hang the whole
    # run (reasoning models occasionally hold a connection open indefinitely).
    client = OpenAI(timeout=120.0, max_retries=4)
    # split("\n") not splitlines(): the latter breaks on U+2028/U+2029/U+0085 that
    # can survive literally inside PDF text, shredding JSON records.
    docs = [json.loads(line) for line in args.corpus.read_text().split("\n") if line.strip()]
    print(f"Generating {args.factual_per_doc} factual + {args.conceptual_per_doc} "
          f"conceptual per doc for {len(docs)} docs with {args.model}…", flush=True)

    qid = 0
    kept_f = kept_c = drop_f = drop_c = errors = 0
    lo, hi = args.min_excerpt_words, args.max_excerpt_words
    args.out.parent.mkdir(parents=True, exist_ok=True)

    # API calls run concurrently (latency-bound); validation + writing happen
    # afterward in the main thread (no shared-state races).
    from concurrent.futures import ThreadPoolExecutor, as_completed
    gathered = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(gen_for_doc, client, args.model, doc["text"],
                            args.factual_per_doc, args.conceptual_per_doc, args.max_words): doc
                for doc in docs}
        for i, fut in enumerate(as_completed(futs), 1):
            doc = futs[fut]
            try:
                gathered.append((doc, fut.result()))
            except Exception as e:  # noqa: BLE001
                errors += 1
                print(f"  [{i}/{len(docs)}] {doc['doc_id'][:38]}: ERROR {type(e).__name__}: {e}", flush=True)
                continue
            print(f"  [{i}/{len(docs)}] {doc['doc_id'][:38]}: received", flush=True)

    with args.out.open("w") as f:
        for doc, data in gathered:
            doc_norm = _norm(doc["text"])
            for p in (data.get("factual") or []):
                q = (p.get("question") or "").strip()
                exs = _valid_excerpts([p.get("excerpt")], doc_norm, lo, hi)
                if q and exs:
                    f.write(json.dumps({"qid": qid, "doc_id": doc["doc_id"], "type": "factual",
                                        "question": q, "excerpts": exs}, ensure_ascii=False) + "\n")
                    qid += 1; kept_f += 1
                else:
                    drop_f += 1
            for p in (data.get("conceptual") or []):
                q = (p.get("question") or "").strip()
                exs = _valid_excerpts(p.get("excerpts") or [], doc_norm, lo, hi)
                if q and len(exs) >= 2:  # conceptual needs ≥2 verbatim supporting spans
                    f.write(json.dumps({"qid": qid, "doc_id": doc["doc_id"], "type": "conceptual",
                                        "question": q, "excerpts": exs}, ensure_ascii=False) + "\n")
                    qid += 1; kept_c += 1
                else:
                    drop_c += 1

    print(f"\nWrote {kept_f + kept_c} questions ({kept_f} factual, {kept_c} conceptual) → {args.out}")
    print(f"  dropped: factual {drop_f}, conceptual {drop_c}; doc errors: {errors}")
    return 0 if (kept_f + kept_c) else 1


if __name__ == "__main__":
    raise SystemExit(main())
