#!/usr/bin/env python3
"""Re-OCR client for Infinity-Parser2-Pro served on a vLLM OpenAI endpoint.

Renders each PDF page (pymupdf), smart-resizes it (Qwen-VL convention), and sends
image + PROMPT_DOC2MD to the endpoint, concatenating per-page Markdown (LaTeX
equations, HTML tables) into <stem>.md. Replicates infinity_parser2's vllm_server
backend so it runs in the existing westbury venv (py3.11) with no extra installs.

A separate PREREQUISITE step, independent of the RAG ingest: it only produces clean
.md text the later ingest can consume instead of the garbled OCR layer. Resumable
(skips done .md); logs per-page timing so the pilot measures real throughput.

  python3 reocr_client.py --endpoint http://localhost:PORT/v1 --list L --pdf-dir D --out O
"""
import argparse, base64, io, math, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests
import fitz  # pymupdf
from PIL import Image

# Verbatim from infinity_parser2/prompts.py (PROMPT_DOC2MD): direct Markdown output.
PROMPT_DOC2MD = """
You are an AI assistant specialized in converting PDF images to Markdown format. Please follow these instructions for the conversion:

1. Text Processing:
- Accurately recognize all text content in the PDF image without guessing or inferring.
- Convert the recognized text into Markdown format.
- Maintain the original document structure, including headings, paragraphs, lists, etc.

2. Mathematical Formula Processing:
- Convert all mathematical formulas to LaTeX format.
- Enclose inline formulas with $ $. For example: This is an inline formula $E = mc^2$
- Enclose block formulas with $$ $$. For example: $$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$

3. Table Processing:
- Convert tables to HTML format.

4. Figure Handling:
- Ignore figures content in the PDF image. Do not attempt to describe or convert images.

5. Output Format:
- Ensure the output Markdown document has a clear structure with appropriate line breaks between elements.
- For complex layouts, try to maintain the original document's structure and format as closely as possible.

Please strictly follow these guidelines to ensure accuracy and consistency in the conversion. Your task is to accurately convert the content of the PDF image into Markdown format without adding any extra explanations or comments.
"""


def smart_resize(h, w, factor=32, min_pixels=2048, max_pixels=16777216):
    """Qwen-VL smart_resize: dims to a multiple of `factor`, area within [min,max]."""
    hbar = max(factor, round(h / factor) * factor)
    wbar = max(factor, round(w / factor) * factor)
    if hbar * wbar > max_pixels:
        beta = math.sqrt((h * w) / max_pixels)
        hbar = max(factor, math.floor(h / beta / factor) * factor)
        wbar = max(factor, math.floor(w / beta / factor) * factor)
    elif hbar * wbar < min_pixels:
        beta = math.sqrt(min_pixels / (h * w))
        hbar = math.ceil(h * beta / factor) * factor
        wbar = math.ceil(w * beta / factor) * factor
    return hbar, wbar


def page_to_b64(page, dpi):
    pix = page.get_pixmap(dpi=dpi)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    rh, rw = smart_resize(img.height, img.width)
    img = img.resize((rw, rh))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return base64.b64encode(buf.getvalue()).decode()


def parse_page(endpoint, model, b64, timeout, retries=3):
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
            {"type": "text", "text": PROMPT_DOC2MD},
        ]}],
        "max_tokens": 32768, "temperature": 0.0, "top_p": 1.0,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    last = None
    for attempt in range(retries):
        try:
            r = requests.post(endpoint.rstrip("/") + "/chat/completions", json=body, timeout=timeout)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
        except Exception as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", required=True)            # http://host:port/v1
    ap.add_argument("--model", default="infly/Infinity-Parser2-Pro")
    ap.add_argument("--list", required=True)
    ap.add_argument("--pdf-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dpi", type=int, default=170)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--concurrency", type=int, default=12,
                    help="concurrent page requests per paper (vLLM batches them)")
    a = ap.parse_args()

    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    names = [l.strip() for l in Path(a.list).read_text().splitlines()
             if l.strip() and not l.startswith("#")]
    todo = []
    for n in names:
        if (out / f"{Path(n).stem}.md").exists():
            continue
        p = Path(a.pdf_dir) / (n if n.lower().endswith(".pdf") else f"{n}.pdf")
        todo.append(p) if p.exists() else print(f"MISSING {p}", flush=True)
    print(f"{len(names)} listed; {len(todo)} to parse", flush=True)

    t0 = time.time(); pages = ok = 0
    for i, p in enumerate(todo, 1):
        t = time.time()
        try:
            doc = fitz.open(str(p))
            imgs = [page_to_b64(pg, a.dpi) for pg in doc]   # render all pages (CPU)
            npg = len(imgs); doc.close()
            parts = [None] * npg                            # send pages concurrently (vLLM batches)
            with ThreadPoolExecutor(max_workers=max(1, min(a.concurrency, npg))) as ex:
                futs = {ex.submit(parse_page, a.endpoint, a.model, imgs[k], a.timeout): k
                        for k in range(npg)}
                for fut in as_completed(futs):
                    parts[futs[fut]] = fut.result()
            md = "\n\n".join(parts)
            (out / f"{p.stem}.md").write_text(md)
            pages += npg; ok += 1
            print(f"[{i}/{len(todo)}] {p.name}  {npg}pg  {len(md)}ch  {time.time()-t:.1f}s "
                  f"({(time.time()-t)/max(npg,1):.1f}s/pg)", flush=True)
        except Exception as e:
            print(f"[{i}/{len(todo)}] ERROR {p.name}: {type(e).__name__}: {e}", flush=True)
    dt = time.time() - t0
    print(f"DONE: {ok}/{len(todo)} papers, {pages} pages in {dt:.0f}s "
          f"({dt/max(pages,1):.1f}s/page)", flush=True)


if __name__ == "__main__":
    main()
