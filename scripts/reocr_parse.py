#!/usr/bin/env python3
"""Re-OCR non-digital PDFs with Infinity-Parser2-Pro -> clean markdown (LaTeX
equations, HTML tables). A separate PREREQUISITE step, independent of the RAG
ingest: it only produces <stem>.md text files for the non-digital subset, which
a later ingest can consume instead of the garbled OCR text layer.

Resumable (skips papers whose .md already exists), logs per-paper timing so the
pilot measures real throughput. The InfinityParser2 constructor args are
discovered by introspection so we adapt to the installed package version.

  python3 reocr_parse.py --list LIST.txt --pdf-dir PDFS --out TEXT_OUT [--tp 2]
"""
import argparse, inspect, time
from pathlib import Path


def build_parser(model, tp):
    from infinity_parser2 import InfinityParser2
    sig = inspect.signature(InfinityParser2.__init__).parameters
    kw = {}
    for cand in ("model_name", "model", "model_path"):
        if cand in sig: kw[cand] = model; break
    if "backend" in sig: kw["backend"] = "vllm-engine"
    for cand in ("tensor_parallel_size", "tp_size", "tp"):
        if cand in sig: kw[cand] = tp; break
    for cand in ("gpu_memory_utilization", "gpu_mem_util"):
        if cand in sig: kw[cand] = 0.90; break
    for cand in ("max_model_len", "max_len"):
        if cand in sig: kw[cand] = 65536; break
    print(f"[reocr] InfinityParser2 init params available: {list(sig)}", flush=True)
    print(f"[reocr] using kwargs: {kw}", flush=True)
    return InfinityParser2(**kw)


def to_markdown(result):
    """Normalize the wrapper's return (str / object / dict) to markdown text."""
    if isinstance(result, str):
        return result
    for attr in ("markdown", "md", "text", "content"):
        if hasattr(result, attr):
            v = getattr(result, attr)
            if isinstance(v, str): return v
    if isinstance(result, dict):
        for k in ("markdown", "md", "text", "content"):
            if isinstance(result.get(k), str): return result[k]
    return str(result)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", required=True)
    ap.add_argument("--pdf-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="infly/Infinity-Parser2-Pro")
    ap.add_argument("--tp", type=int, default=2)
    args = ap.parse_args()

    pdfdir, out = Path(args.pdf_dir), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    names = [l.strip() for l in Path(args.list).read_text().splitlines()
             if l.strip() and not l.startswith("#")]
    todo = []
    for n in names:
        stem = Path(n).stem
        if (out / f"{stem}.md").exists():
            continue
        p = pdfdir / (n if n.lower().endswith(".pdf") else f"{n}.pdf")
        if p.exists(): todo.append(p)
        else: print(f"[reocr] MISSING: {p}", flush=True)
    print(f"[reocr] {len(names)} listed; {len(todo)} to parse (rest already done/missing)", flush=True)
    if not todo:
        return

    parser = build_parser(args.model, args.tp)
    t0 = time.time()
    ok = 0
    for i, p in enumerate(todo, 1):
        t = time.time()
        try:
            md = to_markdown(parser.parse(str(p)))
            (out / f"{p.stem}.md").write_text(md)
            ok += 1
            print(f"[reocr] [{i}/{len(todo)}] {p.name}  {len(md)} chars  {time.time()-t:.1f}s", flush=True)
        except Exception as e:
            print(f"[reocr] [{i}/{len(todo)}] ERROR {p.name}: {type(e).__name__}: {e}", flush=True)
    dt = time.time() - t0
    print(f"[reocr] DONE: parsed {ok}/{len(todo)} in {dt:.0f}s "
          f"({dt/max(ok,1):.1f}s/paper)", flush=True)


if __name__ == "__main__":
    main()
