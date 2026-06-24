#!/usr/bin/env python3
"""
Chunk-size eval — step 3 (FIR / GPU): chunk → embed → retrieve → score.

Methodology is Chroma's "Evaluating Chunking Strategies for Retrieval":
token-/character-span Recall, Precision, IoU treating chunks as bounding boxes
over the source. Where possible this imports Chroma's OWN code from the installed
``chunking_evaluation`` package — the baseline chunkers (FixedTokenChunker,
RecursiveTokenChunker) and the span locator (rigorous_document_search) — and the
metric formulas are replicated verbatim (see ``_score``). The ONE thing we wrap is
retrieval: we embed with the production **asymmetric Qwen3-Embedding-8B** (queries
get the "Instruct: …" instruction, documents don't; normalize_embeddings=True),
exactly as pipeline/ingest.py + scripts/server.py do, so the numbers reflect how
AP-RAG actually retrieves. The structure-aware scientific chunker (which transforms
text) is located by its per-chunk ``raw_text_without_overlap`` core, so its chunks
tile the document without double-counting.

Inputs : corpus.jsonl (doc_id, text, …), qa.jsonl (qid, doc_id, question, excerpt)
Output : results.json (+ a printed markdown table)

Run on Fir (see slurm/job_chunk_eval.slurm):
    PYTHONPATH=$WORKDIR python -m scripts.chunk_eval.run_eval \
        --corpus corpus.jsonl --qa qa.jsonl --out results.json
"""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Production chunk sizing uses tiktoken (LightRAG's TiktokenTokenizer, gpt-4o-mini).
import tiktoken

from pipeline.scientific_chunker import ChunkerConfig, chunk_document

# ── Embedding: must match scripts/server.py + pipeline/ingest.py EXACTLY ──────
EMBED_MODEL_ID = os.environ.get("EMBED_MODEL_ID", "Qwen/Qwen3-Embedding-8B")
EMBED_TORCH_DTYPE = os.environ.get("EMBED_TORCH_DTYPE", "bfloat16")
EMBED_DEVICE = os.environ.get("EMBED_DEVICE", "cuda")
EMBED_BATCH = int(os.environ.get("EMBED_BATCH", 16))
EMBED_QUERY_INSTRUCTION = os.environ.get(
    "EMBED_QUERY_INSTRUCTION",
    "Given a question about scientific literature, retrieve relevant passages "
    "from academic papers that answer the question",
)
QUERY_PROMPT = f"Instruct: {EMBED_QUERY_INSTRUCTION}\nQuery:"

RETRIEVAL_KS = (5, 10)

# ── Chroma's own code (preferred) with self-contained fallbacks ───────────────
try:
    from chunking_evaluation.utils import rigorous_document_search as _chroma_locate
    _HAVE_CHROMA_LOCATE = True
except Exception:  # noqa: BLE001
    _chroma_locate = None
    _HAVE_CHROMA_LOCATE = False

try:
    from chunking_evaluation.chunking import FixedTokenChunker, RecursiveTokenChunker
    _HAVE_CHROMA_CHUNKERS = True
except Exception:  # noqa: BLE001
    FixedTokenChunker = RecursiveTokenChunker = None
    _HAVE_CHROMA_CHUNKERS = False


def _collapse_ws_with_map(text: str) -> tuple[str, list[int]]:
    """Whitespace-collapsed, lower-cased view of ``text`` + a map from each
    normalized-char index back to its original offset. Lets us locate a piece
    despite whitespace/case differences and recover the ORIGINAL char span."""
    out: list[str] = []
    idx: list[int] = []
    prev_space = False
    for i, ch in enumerate(text):
        if ch.isspace():
            if not prev_space:
                out.append(" ")
                idx.append(i)
                prev_space = True
        else:
            out.append(ch.lower())
            idx.append(i)
            prev_space = False
    return "".join(out), idx


class Locator:
    """Whitespace-/case-robust span finder with a map back to original offsets.

    A deterministic generalization of Chroma's ``rigorous_document_search`` (which
    fuzzy-matches with rapidfuzz). It's needed because the structure-aware
    scientific chunker strips page furniture and re-normalizes whitespace, so its
    chunks are NOT raw substrings of the source. Exact whitespace-collapsed match
    first; for chunks that span a page break (furniture removed mid-chunk), a
    first/last anchor fallback recovers the footprint span. Returns None if the
    piece genuinely can't be located (counted as ``locate_miss_pct``)."""

    def __init__(self, text: str):
        self.norm, self.idx = _collapse_ws_with_map(text)

    def _orig_span(self, npos: int, nlen: int) -> tuple[int, int]:
        return self.idx[npos], self.idx[npos + nlen - 1] + 1

    def locate(self, piece: str) -> tuple[int, int] | None:
        n, _ = _collapse_ws_with_map(piece)
        n = n.strip()
        if not n:
            return None
        pos = self.norm.find(n)
        if pos != -1:
            return self._orig_span(pos, len(n))
        a, b = n[:60], n[-60:]
        ps, pe = self.norm.find(a), self.norm.rfind(b)
        if ps != -1 and pe != -1 and pe + len(b) > ps:
            s, _ = self._orig_span(ps, len(a))
            _, e = self._orig_span(pe, len(b))
            return (s, e) if e > s else None
        return None


# ── Chunkers under test ───────────────────────────────────────────────────────
@dataclass
class ChunkConfig:
    name: str
    kind: str          # "scientific" | "fixed" | "recursive"
    size: int
    overlap: int


def _sci_config(size: int, overlap: int) -> ChunkerConfig:
    # Scale max/min to the production ratios (max 1.25x, min 0.375x of target).
    return ChunkerConfig(
        target_tokens=size,
        max_tokens=int(round(size * 1.25)),
        min_tokens=int(round(size * 0.375)),
        overlap_tokens=overlap,
    )


def _fallback_fixed(text: str, tok, size: int, overlap: int) -> list[str]:
    ids = tok.encode(text)
    step = max(1, size - overlap)
    return [tok.decode(ids[i : i + size]) for i in range(0, len(ids), step) if ids[i : i + size]]


def _fallback_recursive(text: str, tok, size: int, overlap: int) -> list[str]:
    # Separator cascade (paragraph → line → sentence → space), token-bounded.
    seps = ["\n\n", "\n", ". ", " "]

    def split(s: str, depth: int) -> list[str]:
        if len(tok.encode(s)) <= size:
            return [s] if s.strip() else []
        if depth >= len(seps):
            return _fallback_fixed(s, tok, size, overlap)
        parts, out, buf = s.split(seps[depth]), [], ""
        for p in parts:
            cand = (buf + seps[depth] + p) if buf else p
            if len(tok.encode(cand)) <= size:
                buf = cand
            else:
                if buf:
                    out.append(buf)
                    buf = ""
                if len(tok.encode(p)) > size:
                    out.extend(split(p, depth + 1))
                else:
                    buf = p  # carry forward to merge with following parts
        if buf:
            out.append(buf)
        return [c for c in out if c.strip()]

    return split(text, 0)


def chunk_doc(cfg: ChunkConfig, doc_text: str, tok):
    """Return list of (embed_text, core_text) for one document under ``cfg``.

    embed_text is what gets embedded (production-faithful: includes overlap);
    core_text is what locates the chunk's source span (no overlap → tiles cleanly).
    """
    if cfg.kind == "scientific":
        chunks = chunk_document(tok, doc_text, _sci_config(cfg.size, cfg.overlap))
        return [(c["content"], c.get("raw_text_without_overlap", c["content"])) for c in chunks]
    if cfg.kind == "fixed":
        if _HAVE_CHROMA_CHUNKERS:
            strs = FixedTokenChunker(chunk_size=cfg.size, chunk_overlap=cfg.overlap).split_text(doc_text)
        else:
            strs = _fallback_fixed(doc_text, tok, cfg.size, cfg.overlap)
        return [(s, s) for s in strs]
    if cfg.kind == "recursive":
        if _HAVE_CHROMA_CHUNKERS:
            strs = RecursiveTokenChunker(chunk_size=cfg.size, chunk_overlap=cfg.overlap).split_text(doc_text)
        else:
            strs = _fallback_recursive(doc_text, tok, cfg.size, cfg.overlap)
        return [(s, s) for s in strs]
    raise ValueError(cfg.kind)


# ── Chroma metric math (char-range bounding boxes) ────────────────────────────
# golden is a LIST of spans (1 for factual, 2-4 for conceptual); recall/precision/
# IoU are computed over the UNION of golden spans, so a conceptual question rewards
# retrieving the whole evidence set, not one tight excerpt.
def _merge(ranges: list[tuple[int, int]]) -> list[list[int]]:
    if not ranges:
        return []
    ranges = sorted(ranges)
    out = [list(ranges[0])]
    for s, e in ranges[1:]:
        if s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def _union_len(ranges: list[tuple[int, int]]) -> int:
    return sum(e - s for s, e in _merge(ranges))


def _overlap_total(a: list[tuple[int, int]], b: list[tuple[int, int]]) -> int:
    """Total length of the intersection of union(a) and union(b)."""
    A, B = _merge(a), _merge(b)
    i = j = tot = 0
    while i < len(A) and j < len(B):
        lo, hi = max(A[i][0], B[j][0]), min(A[i][1], B[j][1])
        if hi > lo:
            tot += hi - lo
        if A[i][1] < B[j][1]:
            i += 1
        else:
            j += 1
    return tot


def _score(golden_ranges: list[tuple[int, int]], retrieved_ranges: list[tuple[int, int]],
           total_retrieved_chars: int) -> tuple[float, float, float]:
    """Chroma's Recall / Precision / IoU for one query (multi-span golden)."""
    inter = _overlap_total(golden_ranges, retrieved_ranges)
    glen = _union_len(golden_ranges)
    recall = inter / glen if glen else 0.0
    precision = inter / total_retrieved_chars if total_retrieved_chars else 0.0
    iou_denom = total_retrieved_chars + glen - inter
    iou = inter / iou_denom if iou_denom else 0.0
    return recall, precision, iou


# ── Embedding (production-faithful, asymmetric) ───────────────────────────────
_model = None


def get_model():
    global _model
    if _model is None:
        import torch
        from sentence_transformers import SentenceTransformer
        mk = {"torch_dtype": getattr(torch, EMBED_TORCH_DTYPE)}
        hub = Path(os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))) / "hub" / f"models--{EMBED_MODEL_ID.replace('/', '--')}"
        refs = hub / "refs" / "main"
        src = str(hub / "snapshots" / refs.read_text().strip()) if refs.exists() else EMBED_MODEL_ID
        print(f"[embed] loading {EMBED_MODEL_ID} ({EMBED_TORCH_DTYPE}) on {EMBED_DEVICE} from {src}", flush=True)
        _model = SentenceTransformer(src, device=EMBED_DEVICE, model_kwargs=mk)
    return _model


def embed(texts: list[str], is_query: bool) -> np.ndarray:
    m = get_model()
    vecs = m.encode(
        texts,
        prompt=QUERY_PROMPT if is_query else None,
        normalize_embeddings=True,
        batch_size=EMBED_BATCH,
        show_progress_bar=False,
    )
    return np.asarray(vecs, dtype=np.float32)


# ── Eval driver ───────────────────────────────────────────────────────────────
def build_grid() -> list[ChunkConfig]:
    short = {"scientific": "sci", "fixed": "fix", "recursive": "rec"}
    # Fine sweep over small sizes (the previous run pointed below 512), 3 chunker
    # types each at a light 10% overlap.
    sizes = [128, 192, 256, 320, 384, 512]
    grid: list[ChunkConfig] = []
    for sz in sizes:
        ov = round(sz * 0.10)
        for kind in ("scientific", "fixed", "recursive"):
            grid.append(ChunkConfig(f"{short[kind]}-{sz}", kind, sz, ov))
    # Overlap sweep at 256 for the scientific and fixed chunkers.
    for kind in ("scientific", "fixed"):
        for ov in (0, 64, 128):
            grid.append(ChunkConfig(f"{short[kind]}-256-ov{ov}", kind, 256, ov))
    return grid


def run(corpus_path: Path, qa_path: Path, out_path: Path) -> int:
    # split("\n") not splitlines(): the latter also breaks on U+2028/U+2029/U+0085,
    # which can survive literally inside the PDF text and shred JSON records.
    docs = {d["doc_id"]: d for d in (json.loads(l) for l in corpus_path.read_text().split("\n") if l.strip())}
    qa = [json.loads(l) for l in qa_path.read_text().split("\n") if l.strip()]
    qa = [q for q in qa if q["doc_id"] in docs]
    print(f"[load] {len(docs)} docs, {len(qa)} questions", flush=True)
    print(f"[chroma] official chunkers={_HAVE_CHROMA_CHUNKERS} "
          f"(locator: normalized; rigorous_document_search available={_HAVE_CHROMA_LOCATE})", flush=True)

    tok = tiktoken.encoding_for_model("gpt-4o-mini")
    locators = {doc_id: Locator(d["text"]) for doc_id, d in docs.items()}

    # Golden spans (located once). Each question carries 1+ verbatim excerpts;
    # factual needs ≥1 locatable span, conceptual ≥2 (union = the evidence set).
    golden: dict[int, list[tuple[int, int]]] = {}
    for q in qa:
        loc = locators[q["doc_id"]]
        sps = [s for s in (loc.locate(ex) for ex in q["excerpts"]) if s]
        if len(sps) >= (2 if q.get("type") == "conceptual" else 1):
            golden[q["qid"]] = sps
    qa = [q for q in qa if q["qid"] in golden]
    q_type = {q["qid"]: q.get("type", "factual") for q in qa}
    n_fact = sum(1 for q in qa if q_type[q["qid"]] == "factual")
    n_conc = len(qa) - n_fact
    print(f"[load] {len(qa)} questions with locatable golden "
          f"({n_fact} factual, {n_conc} conceptual)", flush=True)

    # Questions embedded once (asymmetric: query instruction), reused across configs.
    q_vecs = embed([q["question"] for q in qa], is_query=True)
    qid_order = [q["qid"] for q in qa]
    q_doc = {q["qid"]: q["doc_id"] for q in qa}

    results = []
    for cfg in build_grid():
        t0 = time.time()
        texts, cores, cdoc = [], [], []
        for doc_id, d in docs.items():
            for embed_text, core in chunk_doc(cfg, d["text"], tok):
                texts.append(embed_text)
                cores.append(core)
                cdoc.append(doc_id)
        # Locate each chunk's source span via its core text.
        spans, miss = [], 0
        for doc_id, core in zip(cdoc, cores):
            sp = locators[doc_id].locate(core)
            if sp is None:
                miss += 1
            spans.append(sp)
        chunk_tokens = [len(tok.encode(t)) for t in texts]
        c_vecs = embed(texts, is_query=False)  # documents: no instruction

        TYPES = ("factual", "conceptual", "all")
        buckets = {k: {t: {"recall": [], "precision": [], "iou": []} for t in TYPES} for k in RETRIEVAL_KS}
        sims_all = c_vecs @ q_vecs.T  # (n_chunks, n_q) cosine (normalized)
        for j, qid in enumerate(qid_order):
            order = np.argsort(-sims_all[:, j])
            typ = q_type[qid]
            for k in RETRIEVAL_KS:
                top = order[:k]
                tot_chars = sum(len(texts[i]) for i in top)
                same = [spans[i] for i in top if cdoc[i] == q_doc[qid] and spans[i] is not None]
                r, p, iou = _score(golden[qid], same, tot_chars)
                for t in (typ, "all"):
                    buckets[k][t]["recall"].append(r)
                    buckets[k][t]["precision"].append(p)
                    buckets[k][t]["iou"].append(iou)

        def _agg(d):
            return {m: (round(float(np.mean(d[m])), 4) if d[m] else None) for m in d}
        metrics = {f"@{k}": {t: _agg(buckets[k][t]) for t in TYPES} for k in RETRIEVAL_KS}
        row = {
            "config": cfg.name, "kind": cfg.kind, "size": cfg.size, "overlap": cfg.overlap,
            "n_chunks": len(texts),
            "mean_chunk_tokens": round(float(np.mean(chunk_tokens)), 1),
            "locate_miss_pct": round(100 * miss / max(1, len(texts)), 1),
            "metrics": metrics,
            "seconds": round(time.time() - t0, 1),
        }
        results.append(row)
        a10 = metrics["@10"]["all"]
        rf = metrics["@5"]["factual"]["recall"] or 0.0
        rc = metrics["@5"]["conceptual"]["recall"] or 0.0
        print(f"[{cfg.name:<14}] chunks={row['n_chunks']:<5} tok={row['mean_chunk_tokens']:<6} "
              f"R@10all={a10['recall']:.3f} R@5fact={rf:.3f} R@5conc={rc:.3f} "
              f"IoU@5all={metrics['@5']['all']['iou']:.3f} ({row['seconds']}s)", flush=True)

    out = {
        "embed_model": EMBED_MODEL_ID, "dtype": EMBED_TORCH_DTYPE,
        "query_instruction": EMBED_QUERY_INSTRUCTION,
        "n_docs": len(docs), "n_questions": len(qa),
        "n_factual": n_fact, "n_conceptual": n_conc,
        "chroma_official": {"locator": _HAVE_CHROMA_LOCATE, "chunkers": _HAVE_CHROMA_CHUNKERS},
        "retrieval_ks": list(RETRIEVAL_KS),
        "results": results,
    }
    out_path.write_text(json.dumps(out, indent=2))
    print(f"\n[done] wrote {out_path}")

    # Markdown summary: factual vs conceptual recall side by side (the whole point
    # of this run), sorted by kind then size.
    def g(m, t, mn):
        v = m[t][mn]
        return f"{v:.3f}" if v is not None else "—"
    print("\n| config | kind | mtok | nchunk | Rfact@5 | Rconc@5 | Rall@5 | IoUall@5 | Rall@10 |")
    print("|---|---|---|---|---|---|---|---|---|")
    for r in sorted(results, key=lambda x: (x["kind"], x["size"], x["overlap"])):
        m5, m10 = r["metrics"]["@5"], r["metrics"]["@10"]
        print(f"| {r['config']} | {r['kind']} | {r['mean_chunk_tokens']} | {r['n_chunks']} | "
              f"{g(m5,'factual','recall')} | {g(m5,'conceptual','recall')} | {g(m5,'all','recall')} | "
              f"{g(m5,'all','iou')} | {g(m10,'all','recall')} |")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--corpus", required=True, type=Path)
    ap.add_argument("--qa", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    return run(args.corpus, args.qa, args.out)


if __name__ == "__main__":
    raise SystemExit(main())
