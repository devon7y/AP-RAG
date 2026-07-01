"""Isolated, column-aware PDF → text extraction for the AP-RAG ingest pipeline.

This module holds the PDF text extraction that used to live inline in
``pipeline.ingest``. It is deliberately **dependency-light** — it imports only
``fitz`` (PyMuPDF), ``pypdf``, ``re`` and stdlib, and (unlike ``pipeline.ingest``)
importing it does *not* require the ingest environment (``WORKDIR`` etc.). That
lets it be run as a throwaway subprocess per PDF.

Why a subprocess? PyMuPDF (MuPDF) and pypdf are native C libraries that can
**segfault** on a malformed PDF. A segfault cannot be caught by a Python
``try/except`` — it kills the whole interpreter. When extraction ran in-process,
a single bad PDF took down the entire ingest run (observed: SIGSEGV/exit 139
during the enqueue of ~9.7k docs). ``pipeline.ingest`` therefore invokes this
module as ``python -m pipeline.pdf_extract <pdf> <out>`` for each PDF, so a
native crash is contained to one document (the parent sees a non-zero/negative
return code and skips that doc) instead of aborting the run.

The extraction logic here is a verbatim move of the previous in-process code, so
output for good PDFs is byte-for-byte identical (important: the LLM response
cache is keyed on chunk content).

Standalone contract::

    python -m pipeline.pdf_extract <pdf_path> <out_txt_path>
      exit 0                 → <out_txt_path> written with UTF-8 text (may be empty)
      exit 3                 → a *handled* Python error (bad/unreadable file)
      killed by signal (rc<0) → native crash in fitz/pypdf on this PDF
"""

import re
import sys
from pathlib import Path

# ── Column-aware extraction tunables (calibrated in scripts/audit_ocr.py over the
# full Westbury corpus; see docs and the OCR-audit memory). ──
_COL_GUTTER_BAND = (0.42, 0.58)   # central width fraction to look for a gutter
_COL_MIN_GUTTER_FRAC = 0.035      # gutter gap must exceed this fraction of width
_COL_MAX_STRADDLE = 0.030         # frac of words crossing the gutter -> 1-column
_COL_MIN_PAGE_WORDS = 40          # below this, trust the native extractor
_COL_MIN_SIDE_WORDS = 15          # each column needs this many words


def _detect_gutter(centers: list[float], width: float):
    """Return the x of the central whitespace gutter of a 2-column page, or None."""
    lo, hi = _COL_GUTTER_BAND[0] * width, _COL_GUTTER_BAND[1] * width
    cs = sorted(centers)
    best, gutter = 0.0, None
    for a, b in zip(cs, cs[1:]):
        if a < lo or b > hi:
            continue
        if b - a > best:
            best, gutter = b - a, (a + b) / 2
    if gutter is None or best < _COL_MIN_GUTTER_FRAC * width:
        return None
    return gutter


def _words_to_lines(words: list) -> list[str]:
    """words: (x0,y0,x1,y1,text,...). Group into visual lines (top->bottom),
    words left->right within a line; one line-string per line (newline-joinable)."""
    ws = sorted(words, key=lambda w: (w[1], w[0]))
    heights = sorted(w[3] - w[1] for w in ws)
    h = heights[len(heights) // 2] or 8.0
    tol = max(h * 0.6, 3.0)
    lines, cur, cur_y = [], [ws[0]], ws[0][1]
    for w in ws[1:]:
        if abs(w[1] - cur_y) > tol:
            lines.append(cur)
            cur, cur_y = [], w[1]
        cur.append(w)
    lines.append(cur)
    return [" ".join(w[4] for w in sorted(ln, key=lambda w: w[0])) for ln in lines]


_LINENO_MIN_COL = 8           # isolated marginal integers needed to call it a line-number column
_LINENO_MARGIN_FRAC = 0.15    # cluster center must sit within this fraction of either page edge


def _strip_line_number_column(words, W):
    """Drop a marginal column of manuscript line numbers without touching inline
    numbers. Detect the COLUMN, never judge a number by its value: a line number is
    an integer that is the only word on its text line; when >= _LINENO_MIN_COL such
    integers cluster tightly at a near-constant marginal x with values increasing
    down the page, that whole column is line numbering. Inline numbers ('value 17',
    'R2 = 0.92') share their line with words and are never matched. Returns
    (filtered_words, n_dropped)."""
    counts = {}
    for w in words:
        k = (w[5], w[6])                         # (block, line) per PyMuPDF word
        counts[k] = counts.get(k, 0) + 1
    isolated = [w for w in words if w[4].isdigit() and counts[(w[5], w[6])] == 1]
    if len(isolated) < _LINENO_MIN_COL:
        return words, 0
    isolated.sort(key=lambda w: (w[0] + w[2]) / 2)
    clusters, cur = [], [isolated[0]]            # greedily group by x-center (within 20pt)
    for w in isolated[1:]:
        if (w[0] + w[2]) / 2 - (cur[-1][0] + cur[-1][2]) / 2 <= 20:
            cur.append(w)
        else:
            clusters.append(cur)
            cur = [w]
    clusters.append(cur)
    drop = set()
    for members in clusters:
        if len(members) < _LINENO_MIN_COL:
            continue
        cx = sum((m[0] + m[2]) / 2 for m in members) / len(members)
        if not (cx < _LINENO_MARGIN_FRAC * W or cx > (1 - _LINENO_MARGIN_FRAC) * W):
            continue                             # not at a margin -> not line numbers
        seq = [int(m[4]) for m in sorted(members, key=lambda m: m[1])]   # ordered top→bottom
        if sum(b >= a for a, b in zip(seq, seq[1:])) >= 0.7 * (len(seq) - 1):  # mostly increasing
            drop.update(id(m) for m in members)
    if not drop:
        return words, 0
    return [w for w in words if id(w) not in drop], len(drop)


def _page_text_columnaware(page) -> str:
    """One page → text in correct reading order. Native extraction for single-
    column pages; for a confidently-detected 2-column page, emit the whole left
    column then the whole right column (the across-columns jumble that pypdf's
    extractor introduces). Line breaks are preserved so the chunker can still
    strip running heads / detect section headings."""
    W = page.rect.width
    words = [w for w in page.get_text("words") if w[4].strip()]
    if W <= 0 or len(words) < _COL_MIN_PAGE_WORDS:
        return page.get_text("text")
    words, n_lineno = _strip_line_number_column(words, W)  # drop marginal line-number column
    gutter = _detect_gutter([(w[0] + w[2]) / 2 for w in words], W)
    if gutter is not None:
        straddle = sum(1 for w in words if w[0] < gutter < w[2]) / len(words)
        if straddle <= _COL_MAX_STRADDLE:
            left = [w for w in words if (w[0] + w[2]) / 2 < gutter]
            right = [w for w in words if (w[0] + w[2]) / 2 >= gutter]
            if len(left) >= _COL_MIN_SIDE_WORDS and len(right) >= _COL_MIN_SIDE_WORDS:
                return "\n".join(_words_to_lines(left) + _words_to_lines(right))
    if n_lineno:  # stripped line numbers -> rebuild from filtered words (native get_text keeps them)
        return "\n".join(_words_to_lines(words))
    return page.get_text("text")  # single-column / unconfident: native order


# Visibility for the PyMuPDF→pypdf fallback. pypdf emits glyph-name artifacts
# (/uniFB01) and mojibake, so a SILENT fallback quietly corrupts chunks. Probe fitz
# once at import (a missing module degrades the entire run) and warn+count per file.
try:
    import fitz as _fitz_probe  # noqa: F401
    del _fitz_probe
except Exception:
    print("[extract] CRITICAL: PyMuPDF (fitz) is not importable — every PDF will use "
          "the pypdf fallback, which produces /uniFB01 glyph names and mojibake. "
          "Install pymupdf in the ingest env before running.", flush=True)
_PYPDF_FALLBACKS = 0


def extract_pdf_text(pdf_path: Path) -> str:
    """Synchronous PDF → text (page boundaries preserved as form-feeds for the
    chunker). CPU-bound and pure-Python, so callers run it in _IO_EXECUTOR (Fix 2a)
    to keep it off the event loop.

    Primary path is PyMuPDF with column-aware reading order: pypdf's
    extract_text interleaves the two columns of many 2-column papers (the
    across-columns "jumble"), corrupting every downstream chunk. PyMuPDF reads
    columns correctly and also recovers text from files pypdf chokes on. Falls
    back to pypdf if PyMuPDF is unavailable, so ingest never hard-fails on it."""
    global _PYPDF_FALLBACKS
    text = None
    try:
        import fitz  # PyMuPDF

        with fitz.open(str(pdf_path)) as doc:
            page_texts = [_page_text_columnaware(p).strip() for p in doc]
        text = "\n\f\n".join(p for p in page_texts if p).strip()
    except Exception as exc:
        text = None  # fall through to pypdf
        _PYPDF_FALLBACKS += 1
        print(f"[extract] WARNING: PyMuPDF failed on {pdf_path.name} "
              f"({type(exc).__name__}: {exc}); using pypdf fallback — expect "
              f"/uniFB01 glyph names / mojibake [pypdf fallback #{_PYPDF_FALLBACKS}]",
              flush=True)

    if not text:
        from pypdf import PdfReader

        reader = PdfReader(str(pdf_path))
        page_texts = [(page.extract_text() or "").strip() for page in reader.pages]
        text = "\n\f\n".join(page for page in page_texts if page).strip()

    text = text.replace("<|endofprompt|>", "")
    # Drop C0 control characters (e.g. \x03 that some odd title-page fonts emit)
    # but keep \t \n \r and the \f page separator the chunker relies on.
    text = re.sub(r"[\x00-\x08\x0b\x0e-\x1f]", "", text)
    # Strip unpaired Unicode surrogates (e.g. \ud835 from mathematical-alphanumeric
    # glyphs that some PDFs extract as lone surrogates). They are the only code
    # points UTF-8 cannot encode, so leaving them in crashes the md5 doc_id,
    # apipeline_enqueue, embedding, and JSON KV writes downstream. "ignore" drops
    # only those surrogates and preserves all real text.
    return text.encode("utf-8", "ignore").decode("utf-8")


def _main(argv: list[str]) -> int:
    """python -m pipeline.pdf_extract <pdf_path> <out_txt_path>."""
    if len(argv) != 2:
        print("usage: python -m pipeline.pdf_extract <pdf_path> <out_txt_path>",
              file=sys.stderr, flush=True)
        return 2
    pdf_path, out_path = Path(argv[0]), Path(argv[1])
    text = extract_pdf_text(pdf_path)  # may segfault natively → parent sees signal death
    out_path.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(_main(sys.argv[1:]))
    except Exception as exc:  # a *handled* Python error — distinct from a native crash
        print(f"[pdf_extract] handled error on {sys.argv[1:]}: "
              f"{type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        sys.exit(3)
