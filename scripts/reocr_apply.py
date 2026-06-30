#!/usr/bin/env python3
"""Write re-OCR'd Markdown back into each PDF as an invisible, extractable text
layer, replacing the garbled OCR text. For each page: rasterize the original
(this drops the bad text layer but keeps the visual) and overlay that page's
clean text invisibly (render_mode=3), so pdftotext/the chunker now extract clean
LaTeX-bearing text while humans still see the scan.

The joined .md is split across pages by paragraph blocks (approximate — page-exact
text wasn't retained; in-text citations are page-less anyway).

  python3 reocr_apply.py --list L --pdf-dir SRC --md-dir MD --out OUT [--dpi 150]
"""
import argparse, signal
from pathlib import Path
import fitz  # pymupdf


class _Timeout(Exception):
    pass


def _on_alarm(signum, frame):
    raise _Timeout()


def split_blocks(md, n):
    blocks = [b for b in md.split("\n\n") if b.strip()]
    groups = [[] for _ in range(max(1, n))]
    if not blocks:
        return ["" for _ in range(n)]
    if len(blocks) <= n:
        for i, b in enumerate(blocks):
            groups[min(i, n - 1)].append(b)
    else:
        target = sum(len(b) for b in blocks) / n
        gi = cur = 0
        for b in blocks:
            groups[gi].append(b); cur += len(b)
            if cur >= target and gi < n - 1:
                gi += 1; cur = 0
    return ["\n\n".join(g) for g in groups]


def fontsize_for(txt):
    n = len(txt)
    return 6 if n < 2500 else 4 if n < 6000 else 3 if n < 12000 else 2


def build(src_pdf, md, out_pdf, dpi):
    src = fitz.open(src_pdf)
    npages = src.page_count
    parts = split_blocks(md, npages)
    out = fitz.open()
    for i in range(npages):
        page = src[i]
        pix = page.get_pixmap(dpi=dpi)
        np = out.new_page(width=page.rect.width, height=page.rect.height)
        np.insert_image(np.rect, pixmap=pix)
        txt = parts[i] if i < len(parts) else ""
        if txt.strip():
            np.insert_textbox(np.rect, txt, fontsize=fontsize_for(txt),
                              fontname="helv", render_mode=3)  # render_mode 3 = invisible
    out.save(out_pdf, garbage=1, deflate=True)   # garbage=1: light cleanup, avoids structure-tree hang
    src.close(); out.close()
    return npages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", required=True)
    ap.add_argument("--pdf-dir", required=True)
    ap.add_argument("--md-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--timeout", type=int, default=90, help="per-paper seconds before skipping a hanging PDF")
    a = ap.parse_args()

    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    names = [l.strip() for l in Path(a.list).read_text().splitlines() if l.strip() and not l.startswith("#")]
    signal.signal(signal.SIGALRM, _on_alarm)
    done = miss = err = 0
    for n in names:
        stem = Path(n).stem
        src = Path(a.pdf_dir) / (n if n.lower().endswith(".pdf") else f"{n}.pdf")
        mdf = Path(a.md_dir) / f"{stem}.md"
        dst = out / f"{stem}.pdf"
        if dst.exists():
            done += 1; continue
        if not src.exists() or not mdf.exists():
            print(f"MISSING {stem} (pdf={src.exists()} md={mdf.exists()})", flush=True); miss += 1; continue
        try:
            signal.alarm(a.timeout)
            build(str(src), mdf.read_text(), str(dst), a.dpi)
            signal.alarm(0)
            done += 1
            if done % 50 == 0:
                print(f"  ...{done} built", flush=True)
        except _Timeout:
            signal.alarm(0)
            print(f"TIMEOUT {stem} (>{a.timeout}s, skipped)", flush=True); err += 1
            dst.unlink(missing_ok=True)
        except Exception as e:
            signal.alarm(0)
            print(f"ERROR {stem}: {type(e).__name__}: {e}", flush=True); err += 1
            dst.unlink(missing_ok=True)
    print(f"built {done} | missing {miss} | errors {err}", flush=True)


if __name__ == "__main__":
    main()
