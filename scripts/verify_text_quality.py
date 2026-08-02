#!/usr/bin/env python3
"""Independent text-quality verification of the corpus, designed to catch what
scripts/audit_ocr.py's own metrics CANNOT (because audit's pymupdf-extractor
jumble check is partly circular).

Two orthogonal, independent signals per doc:

  order_agree  Reading-order agreement between the NEW pipeline extractor
               (PyMuPDF column-aware) and pdftotext (poppler) -- a completely
               different column-detection engine. Char-shingle position
               Spearman of the two stripped streams. ~1.0 == both engines read
               the page the same way (high confidence the order is right);
               low == they disagree, so at least one mis-ordered (3-column
               tables, side-by-side figures, rotated pages, gutter mis-fires).
               Only computed on docs with >=1 confident 2-column page.

  word_valid   Fraction of alpha tokens (len>=3, de-hyphenated) that are real
               dictionary words. Independent of order; catches OCR character
               errors, mojibake, and encoding garble that "looks like letters"
               and slips past the alpha-ratio garbage metric. Scientific prose
               runs ~0.55-0.75 (names/acronyms/jargon are non-dict); genuinely
               garbled text falls well below.

Flags a doc if order_agree < ORDER_MIN (and it has 2-col pages) or
word_valid < VALID_MIN. These are review candidates, not proof of failure.

    python verify_text_quality.py /Users/devon7y/Papers --out verify.csv
"""
from __future__ import annotations

import argparse
import csv
import logging
import os
import re
import subprocess
import warnings
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

warnings.filterwarnings("ignore")

import audit_ocr as A  # same dir; reuse gutter/column/extractor helpers

ORDER_MIN = 0.60
VALID_MIN = 0.45
MAX_PAGES = 15
SHINGLE_K = 12
WORD_RE = re.compile(r"[a-z]{3,}")
_DICT: set[str] | None = None


def _dict() -> set[str]:
    global _DICT
    if _DICT is None:
        try:
            _DICT = {w.strip().lower() for w in open("/usr/share/dict/words")
                     if w.strip()}
        except Exception:
            _DICT = set()
    return _DICT


def _strip(s: str) -> str:
    return re.sub(r"\s+", "", s.lower())


def _shingle_spearman(a_text: str, b_text: str) -> tuple[float | None, int]:
    """Order-sensitive, whitespace-robust agreement of two extractions."""
    a, b = _strip(a_text), _strip(b_text)
    k = SHINGLE_K
    if len(a) < k * 8 or len(b) < k * 8:
        return None, 0

    def uniq(s: str) -> dict[str, int]:
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

    ua, ub = uniq(a), uniq(b)
    common = [(ua[s], ub[s]) for s in ua.keys() & ub.keys()]
    n = len(common)
    if n < 30:
        return None, n
    rx = {v: i for i, v in enumerate(sorted(p[0] for p in common))}
    ry = {v: i for i, v in enumerate(sorted(p[1] for p in common))}
    xs = [rx[p[0]] for p in common]
    ys = [ry[p[1]] for p in common]
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    return (num / (dx * dy) if dx and dy else None), n


def _word_validity(text: str) -> tuple[float, int]:
    d = _dict()
    if not d:
        return -1.0, 0
    # rejoin hyphenated line breaks: "treat- ment" / "treat-\nment" -> "treatment"
    joined = re.sub(r"-\s+", "", text.lower())
    toks = WORD_RE.findall(joined)
    if len(toks) < 40:
        return -1.0, len(toks)
    valid = sum(1 for t in toks if t in d)
    return round(valid / len(toks), 3), len(toks)


def _pdftotext(path: str, lim: int) -> str:
    try:
        return subprocess.run(["pdftotext", "-f", "1", "-l", str(lim), path, "-"],
                              capture_output=True, text=True, timeout=120).stdout
    except Exception:
        return ""


def verify(path: str) -> dict:
    import fitz
    rec = {"file": os.path.basename(path), "pages": 0, "col2": 0,
           "order_agree": "", "n_anchors": "", "word_valid": "", "n_tokens": "",
           "flag": "", "error": ""}
    try:
        with fitz.open(path) as doc:
            n = doc.page_count
            rec["pages"] = n
            lim = min(n, MAX_PAGES)
            new_pages = A._pymupdf_page_texts(doc, lim)
            # count confident 2-column pages
            col2 = 0
            for i in range(lim):
                pg = doc[i]
                W = pg.rect.width
                words = [(w[0], w[1], w[2], w[3], w[4]) for w in pg.get_text("words")
                         if w[4].strip()]
                if W <= 0 or len(words) < A.MIN_PAGE_WORDS:
                    continue
                g = A._detect_gutter([(w[0] + w[2]) / 2 for w in words], W)
                if g is None:
                    continue
                if sum(1 for w in words if w[0] < g < w[2]) / len(words) > A.MAX_STRADDLE:
                    continue
                left = [w for w in words if (w[0] + w[2]) / 2 < g]
                right = [w for w in words if (w[0] + w[2]) / 2 >= g]
                if len(left) >= A.MIN_SIDE_WORDS and len(right) >= A.MIN_SIDE_WORDS:
                    col2 += 1
            rec["col2"] = col2
        new_text = "\n".join(new_pages)
    except Exception as e:
        rec["error"] = f"fitz:{type(e).__name__}"[:80]
        return rec

    wv, nt = _word_validity(new_text)
    rec["word_valid"], rec["n_tokens"] = wv, nt

    flags = []
    if 0 <= wv < VALID_MIN:
        flags.append("low_word_validity")

    # reading-order cross-check only where there ARE columns to get wrong
    if rec["col2"] >= 1:
        pt = _pdftotext(path, min(rec["pages"], MAX_PAGES))
        sp, na = _shingle_spearman(new_text, pt)
        rec["order_agree"] = "" if sp is None else round(sp, 3)
        rec["n_anchors"] = na
        if sp is not None and sp < ORDER_MIN:
            flags.append("order_disagree")
    rec["flag"] = ",".join(flags)
    return rec


def _worker(path):
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    try:
        return verify(path)
    except Exception as e:
        return {"file": os.path.basename(path), "pages": 0, "col2": 0,
                "order_agree": "", "n_anchors": "", "word_valid": "",
                "n_tokens": "", "flag": "crash", "error": f"{type(e).__name__}"[:80]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--out", type=Path, default=Path("verify.csv"))
    ap.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 4) - 2))
    ap.add_argument("--sample", type=int, default=0)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    pdfs = sorted(str(p) for p in args.folder.glob("*.pdf"))
    if args.sample:
        import random
        random.seed(args.seed)
        pdfs = random.sample(pdfs, min(args.sample, len(pdfs)))
    total = len(pdfs)
    print(f"Verifying {total} PDFs (workers={args.workers})", flush=True)

    cols = ["file", "pages", "col2", "order_agree", "n_anchors", "word_valid",
            "n_tokens", "flag", "error"]
    rows, done = [], 0
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for fut in as_completed([ex.submit(_worker, p) for p in pdfs]):
            rows.append(fut.result())
            done += 1
            if done % 500 == 0:
                print(f"  {done}/{total}", flush=True)

    rows.sort(key=lambda r: r["file"])
    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    flagged = [r for r in rows if r["flag"]]
    by = Counter(f for r in flagged for f in r["flag"].split(",") if f)
    print(f"\nDONE {done}/{total}  ->  {args.out}")
    print(f"  flagged: {len(flagged)}")
    for k, v in by.most_common():
        print(f"    {k:<20} {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
