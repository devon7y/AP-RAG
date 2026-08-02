#!/usr/bin/env python3
"""Audit a folder of PDFs for OCR coverage and OCR/text-extraction quality.

Everything is judged in the fidelity the ingest pipeline actually sees: the
pipeline extracts text with pypdf's PdfReader.extract_text (see
pipeline/ingest.py:_extract_pdf_text), so that is what we test. PyMuPDF (fitz)
is used only for word geometry, to build a column-correct reference.

Statuses (priority order, worst wins):
  read_error  pypdf cannot open / parse the file
  no_text     effectively no text layer (needs OCR)
  undecodable text layer present but not mapped to Unicode -> pypdf emits glyph
              codes like /C104 or (cid:84); the pipeline would ingest garbage.
              Fix = OCR (lay down a real text layer).
  low_text    text present but very sparse per page (partial / failed OCR)
  col_jumbled on a confidently-detected 2-column page, the pypdf reading order
              interleaves the two columns (the across-columns OCR/extraction
              bug). Measured by how well the left-column and right-column text
              stay *separated* in the pypdf output: each column's unique char-
              shingles are located in the pypdf string and we compute the AUC
              that a left-column anchor precedes a right-column one. ~1.0 ==
              columns kept separate (good); ~0.5 == fully interleaved (jumbled).
              This is robust to figure/caption/running-head repositioning,
              which confounds a naive full-page order comparison.
  bad_ocr     high non-alpha / replacement-char ratio not explained by glyph
              codes (mojibake / corrupt OCR)
  glued_text  words run together (very low inter-word space ratio); hurts
              chunking/embeddings even though reading order is fine
  ok          usable

The column-jumble metric is space-robust (whitespace stripped) and order-
sensitive (column-separation AUC), so it does NOT fire on merely-missing
spaces -- only on genuine column interleaving. Single-column pages are excluded
by a gutter-straddle gate before the test runs.

Usage:
    python audit_ocr.py /Users/devon7y/Papers --out audit_report.csv
    python audit_ocr.py /Users/devon7y/Papers --sample 300 --seed 7
"""
from __future__ import annotations

import argparse
import csv
import logging
import os
import re
import warnings
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

warnings.filterwarnings("ignore")

# -- tunables (calibrated on a 300-PDF random sample) -------------------------
NO_TEXT_CHARS = 30            # total chars below this -> no_text
MIN_CHARS_PER_PAGE = 100      # below -> low_text (partial/failed OCR)
CID_RATIO_BAD = 0.20          # glyph-code tokens / (glyph + words) above -> undecodable
GARBAGE_BAD = 0.50            # garbage score above -> bad_ocr
SPACE_RATIO_GLUED = 0.055     # inter-word space ratio below -> glued_text
GUTTER_BAND = (0.42, 0.58)    # central width fraction to seek a gutter in
MIN_GUTTER_FRAC = 0.035       # gutter gap must exceed this fraction of width
MIN_SIDE_WORDS = 15           # each column needs this many words
MIN_PAGE_WORDS = 60           # skip sparser pages for the jumble test
MAX_STRADDLE = 0.030          # frac of words crossing the gutter; above -> 1-col
JUMBLE_SEP = 0.30             # page column-separation below this -> jumbled page
MIN_COL_ANCHORS = 12          # each column needs this many matched shingles
SHINGLE_K = 12

WORD_RE = re.compile(r"[a-z0-9]+")
# Undecodable glyph-name tokens pypdf emits when a font has no ToUnicode map:
# letter-prefixed (/C104, /G12) and bare-numeric (/49 /116) forms, plus (cid:NN).
CID_RE = re.compile(r"/[A-Za-z]{0,3}\d{1,4}\b|\(cid:\d+\)")


def _norm_words(text: str) -> list[str]:
    return WORD_RE.findall(text.lower())


def _strip_ws(s: str) -> str:
    return re.sub(r"\s+", "", s.lower())


def _garbage_score(text: str) -> float:
    stripped = "".join(text.split())
    if not stripped:
        return 1.0
    alpha = sum(c.isalpha() for c in stripped)
    repl = text.count("�")
    alpha_ratio = alpha / len(stripped)
    repl_ratio = repl / len(stripped)
    return min(max(0.0, (0.55 - alpha_ratio) / 0.55) * 0.7 + min(repl_ratio * 20, 1.0) * 0.3, 1.0)


def _uniq_shingles(s: str, k: int = SHINGLE_K) -> dict[str, int]:
    """Char k-grams that occur exactly once in s -> their position."""
    seen: dict[str, int] = {}
    dup: set[str] = set()
    for i in range(len(s) - k + 1):
        sh = s[i:i + k]
        if sh in seen:
            dup.add(sh)
        else:
            seen[sh] = i
    for sh in dup:
        seen.pop(sh, None)
    return seen


def _column_separation(left_text: str, right_text: str,
                       act_text: str) -> tuple[float | None, int]:
    """Locate each column's unique char-shingles inside the pypdf output and
    measure how separated the two columns stay. Returns (sep, n_anchors) where
    sep is 2*|AUC-0.5|: ~1.0 == columns stay in separate runs (correct reading
    order); ~0.0 == columns interleaved line-by-line (jumbled). Whitespace-
    insensitive (robust to missing spaces); a moved caption/figure only nudges
    a few anchors so it does not collapse the score."""
    act = _strip_ws(act_text)
    if len(act) < SHINGLE_K * 8:
        return None, 0
    a = _uniq_shingles(act)
    refl, refr = _uniq_shingles(_strip_ws(left_text)), _uniq_shingles(_strip_ws(right_text))
    only_l = refl.keys() - refr.keys()
    only_r = refr.keys() - refl.keys()
    lpos = sorted(a[sh] for sh in only_l if sh in a)
    rpos = sorted(a[sh] for sh in only_r if sh in a)
    if len(lpos) < MIN_COL_ANCHORS or len(rpos) < MIN_COL_ANCHORS:
        return None, min(len(lpos), len(rpos))
    # AUC that a left anchor precedes a right anchor, via rank sum (O(n log n))
    merged = sorted([(p, 0) for p in lpos] + [(p, 1) for p in rpos])
    rank_sum_l = sum(i for i, (_, lab) in enumerate(merged) if lab == 0)
    nl, nr = len(lpos), len(rpos)
    auc = (rank_sum_l - nl * (nl - 1) / 2) / (nl * nr)
    return abs(auc - 0.5) * 2, nl + nr


def _column_order(words: list[tuple]) -> str:
    """words: (x0,y0,x1,y1,text). Group into lines by y, top->bottom, words
    left->right within line. Robust per-column reading order."""
    if not words:
        return ""
    ws = sorted(words, key=lambda w: w[1])
    heights = sorted(w[3] - w[1] for w in ws)
    h = heights[len(heights) // 2] or 8.0
    tol = max(h * 0.6, 3.0)
    lines: list[list[tuple]] = [[ws[0]]]
    cur_y = ws[0][1]
    for w in ws[1:]:
        if abs(w[1] - cur_y) > tol:
            lines.append([])
            cur_y = w[1]
        lines[-1].append(w)
    return " ".join(w[4] for ln in lines for w in sorted(ln, key=lambda w: w[0]))


def _detect_gutter(centers: list[float], width: float) -> float | None:
    lo, hi = GUTTER_BAND[0] * width, GUTTER_BAND[1] * width
    cs = sorted(centers)
    best, gutter = 0.0, None
    for a, b in zip(cs, cs[1:]):
        if a < lo or b > hi:
            continue
        if b - a > best:
            best, gutter = b - a, (a + b) / 2
    if gutter is None or best < MIN_GUTTER_FRAC * width:
        return None
    return gutter


def _pymupdf_page_texts(doc, lim: int) -> list[str]:
    """Per-page text the way pipeline/ingest.py's column-aware _extract_pdf_text
    produces it: native order for single-column pages, whole-left-then-whole-
    right for confident 2-column pages. Lets the audit certify what the *new*
    pipeline ingests, not what old pypdf did."""
    out: list[str] = []
    for i in range(min(lim, doc.page_count)):
        pg = doc[i]
        W = pg.rect.width
        words = [(w[0], w[1], w[2], w[3], w[4]) for w in pg.get_text("words")
                 if w[4].strip()]
        if W <= 0 or len(words) < MIN_PAGE_WORDS:
            out.append(pg.get_text("text"))
            continue
        gutter = _detect_gutter([(w[0] + w[2]) / 2 for w in words], W)
        placed = False
        if gutter is not None and sum(1 for w in words if w[0] < gutter < w[2]) / len(words) <= MAX_STRADDLE:
            left = [w for w in words if (w[0] + w[2]) / 2 < gutter]
            right = [w for w in words if (w[0] + w[2]) / 2 >= gutter]
            if len(left) >= MIN_SIDE_WORDS and len(right) >= MIN_SIDE_WORDS:
                out.append(_column_order(left) + "\n" + _column_order(right))
                placed = True
        if not placed:
            out.append(pg.get_text("text"))
    return out


def analyze(pdf_path: str, max_pages: int, extractor: str = "pypdf") -> dict:
    import fitz

    rec = {
        "file": os.path.basename(pdf_path), "pages": 0, "chars": 0,
        "chars_per_page": 0.0, "status": "ok", "garbage": 0.0, "cid_ratio": 0.0,
        "space_ratio": 0.0, "col2_pages": 0, "jumbled_pages": 0,
        "jumble_frac": 0.0, "worst_sep": "", "worst_page": "", "error": "",
    }
    try:
        if extractor == "pymupdf":
            with fitz.open(pdf_path) as _doc:
                n = _doc.page_count
                rec["pages"] = n
                lim = n if max_pages <= 0 else min(n, max_pages)
                page_texts = _pymupdf_page_texts(_doc, lim)
        else:
            import pypdf
            reader = pypdf.PdfReader(pdf_path)
            n = len(reader.pages)
            rec["pages"] = n
            lim = n if max_pages <= 0 else min(n, max_pages)
            page_texts = []
            for i in range(lim):
                try:
                    page_texts.append(reader.pages[i].extract_text() or "")
                except Exception:
                    page_texts.append("")
    except Exception as e:
        rec["status"] = "read_error"
        rec["error"] = f"{extractor}:{type(e).__name__}:{e}"[:150]
        return rec

    full = "\n".join(page_texts)
    body = full.strip()
    rec["chars"] = len(body)
    scanned = max(len(page_texts), 1)
    rec["chars_per_page"] = round(rec["chars"] / scanned, 1)
    if body:
        rec["space_ratio"] = round(sum(c == " " for c in full) / len(full), 3)

    # glyph-code (undecodable) ratio
    cid = len(CID_RE.findall(full))
    words_no_cid = len(_norm_words(CID_RE.sub(" ", full)))
    rec["cid_ratio"] = round(cid / max(cid + words_no_cid, 1), 3)
    rec["garbage"] = round(_garbage_score(full), 3)

    # ---- status: text presence / decodability / quality (worst wins) ----
    if rec["chars"] < NO_TEXT_CHARS:
        rec["status"] = "no_text"
        return rec
    if rec["cid_ratio"] >= CID_RATIO_BAD:
        rec["status"] = "undecodable"
    elif rec["chars_per_page"] < MIN_CHARS_PER_PAGE:
        rec["status"] = "low_text"
    elif rec["garbage"] > GARBAGE_BAD:
        rec["status"] = "bad_ocr"

    # ---- column-jumble test (geometry vs pypdf reading order) ----
    try:
        doc = fitz.open(pdf_path)
        worst = 2.0
        for i in range(min(lim, doc.page_count)):
            pg = doc[i]
            W = pg.rect.width
            if W <= 0:
                continue
            words = [(w[0], w[1], w[2], w[3], w[4]) for w in pg.get_text("words")
                     if w[4].strip()]
            if len(words) < MIN_PAGE_WORDS:
                continue
            centers = [(w[0] + w[2]) / 2 for w in words]
            gutter = _detect_gutter(centers, W)
            if gutter is None:
                continue
            straddle = sum(1 for w in words if w[0] < gutter < w[2])
            if straddle / len(words) > MAX_STRADDLE:
                continue  # single-column page with a coincidental center gap
            left = [w for w in words if (w[0] + w[2]) / 2 < gutter]
            right = [w for w in words if (w[0] + w[2]) / 2 >= gutter]
            if len(left) < MIN_SIDE_WORDS or len(right) < MIN_SIDE_WORDS:
                continue
            sep, na = _column_separation(_column_order(left), _column_order(right),
                                         page_texts[i] if i < len(page_texts) else "")
            if sep is None:
                continue
            rec["col2_pages"] += 1
            if sep < JUMBLE_SEP:
                rec["jumbled_pages"] += 1
            if sep < worst:
                worst = sep
                rec["worst_page"] = i
        doc.close()
        if rec["col2_pages"]:
            rec["jumble_frac"] = round(rec["jumbled_pages"] / rec["col2_pages"], 3)
            rec["worst_sep"] = round(worst, 3)
            if rec["jumbled_pages"] >= 1 and rec["status"] in ("ok", "low_text", "glued_text"):
                rec["status"] = "col_jumbled"
    except Exception as e:
        rec["error"] = (rec["error"] + f" fitz:{type(e).__name__}")[:150]

    # ---- glued text (lowest priority quality flag) ----
    if rec["status"] == "ok" and body and rec["space_ratio"] < SPACE_RATIO_GLUED:
        rec["status"] = "glued_text"
    return rec


def _worker(args):
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    path, max_pages, extractor = args
    try:
        return analyze(path, max_pages, extractor)
    except Exception as e:
        return {"file": os.path.basename(path), "pages": 0, "chars": 0,
                "chars_per_page": 0.0, "status": "crash", "garbage": 0.0,
                "cid_ratio": 0.0, "space_ratio": 0.0, "col2_pages": 0,
                "jumbled_pages": 0, "jumble_frac": 0.0, "worst_sep": "",
                "worst_page": "", "error": f"{type(e).__name__}:{e}"[:150]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--out", type=Path, default=Path("audit_report.csv"))
    ap.add_argument("--max-pages", type=int, default=8, help="pages/PDF (0=all)")
    ap.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--extractor", choices=["pypdf", "pymupdf"], default="pypdf",
                    help="pypdf = what the OLD pipeline saw; pymupdf = the NEW "
                         "column-aware extractor (certify post-fix corpus)")
    args = ap.parse_args()

    pdfs = sorted(str(p) for p in args.folder.glob("*.pdf"))
    if args.sample:
        import random
        random.seed(args.seed)
        pdfs = random.sample(pdfs, min(args.sample, len(pdfs)))
    total = len(pdfs)
    print(f"Auditing {total} PDFs (max_pages={args.max_pages}, workers={args.workers}, "
          f"extractor={args.extractor})", flush=True)

    cols = ["file", "pages", "chars", "chars_per_page", "status", "garbage",
            "cid_ratio", "space_ratio", "col2_pages", "jumbled_pages",
            "jumble_frac", "worst_sep", "worst_page", "error"]
    rows: list[dict] = []
    done = 0
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futs = [ex.submit(_worker, (p, args.max_pages, args.extractor)) for p in pdfs]
        for fut in as_completed(futs):
            rows.append(fut.result())
            done += 1
            if done % 250 == 0:
                print(f"  {done}/{total}", flush=True)

    rows.sort(key=lambda r: r["file"])
    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    by_status = Counter(r["status"] for r in rows)
    print(f"\nDONE {done}/{total}  ->  {args.out}")
    for s, c in sorted(by_status.items(), key=lambda x: -x[1]):
        print(f"  {s:<14} {c}")
    print(f"  flagged (non-ok): {sum(1 for r in rows if r['status'] != 'ok')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
