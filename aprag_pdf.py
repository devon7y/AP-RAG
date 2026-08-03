"""
aprag_pdf.py — PDF serving helpers for the web app's in-app viewer.

The web viewer opens a cited paper *at the cited page* with the quoted passage
highlighted, so it needs two things from the always-on PC that the Google Drive links
cannot give: byte-range access to the PDF itself (pdf.js fetches only the objects it
needs) and a cheap per-page raster for an instant first paint / hover preview.

This module holds the parts worth isolating and testing:

  * ``safe_pdf_path`` — resolve a caller-supplied filename to a file inside the papers
    directory, rejecting traversal and symlink escapes (this is the security boundary:
    the filename arrives from the browser).
  * ``file_etag`` / ``page_cache_path`` — cache identity. The corpus is *not* immutable
    by filename (the re-OCR project rewrites ~1,000 PDFs in place), so both the HTTP
    validator and the page-cache key derive from the file's mtime+size — a rewritten
    PDF misses cache instead of serving stale bytes forever.
  * ``render_page_image`` — rasterize one page to WebP. PyMuPDF (already this repo's
    PDF library, see ``scripts/audit_ocr.py``) does the rendering; Pillow does the WebP
    encoding, because PyMuPDF's ``tobytes`` supports only png/jpg/pnm/… — not webp.

WebP (not PNG) is deliberate: these pages are mostly photographs of paper (scans) or
antialiased text, where PNG balloons well past a lossy codec at the same readability.

The FastAPI routes and their on-disk cache live in ``query_server.py``.
"""
from __future__ import annotations

import hashlib
import io
import os

#: Rendered-page width bounds (CSS px at 1× — the viewer upscales slightly if needed).
MIN_WIDTH, DEFAULT_WIDTH, MAX_WIDTH = 400, 1200, 2000
#: WebP quality bounds.
MIN_QUALITY, DEFAULT_QUALITY, MAX_QUALITY = 40, 80, 95


def safe_pdf_path(papers_dir: str, filename: str) -> str | None:
    """Absolute path of ``filename`` inside ``papers_dir``, or None if it is not a
    plain ``*.pdf`` basename resolving to an existing regular file in that directory.

    Rejects (a) anything carrying a path separator or ``..``, (b) non-PDF names, and
    (c) links pointing outside the directory — the resolved realpath must still sit
    under the resolved papers directory.
    """
    name = str(filename or "").strip()
    if not name or name != os.path.basename(name):
        return None
    if not name.lower().endswith(".pdf"):
        return None
    if not papers_dir:
        return None

    root = os.path.realpath(papers_dir)
    candidate = os.path.realpath(os.path.join(root, name))
    # Compare with a trailing separator so "/papers_evil" can't pass as "/papers".
    if not (candidate == root or candidate.startswith(root + os.sep)):
        return None
    if not os.path.isfile(candidate):
        return None
    return candidate


def file_signature(stat_result) -> str:
    """Short, stable identity for a file's current bytes (mtime + size)."""
    base = f"{int(stat_result.st_mtime)}-{stat_result.st_size}"
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:12]


def file_etag(stat_result) -> str:
    """Strong HTTP validator for a PDF (quoted, so it is Range/If-Range-usable)."""
    return f'"{file_signature(stat_result)}"'


def clamp_width(value) -> int:
    try:
        w = int(value)
    except (TypeError, ValueError):
        return DEFAULT_WIDTH
    return max(MIN_WIDTH, min(MAX_WIDTH, w))


def clamp_quality(value) -> int:
    try:
        q = int(value)
    except (TypeError, ValueError):
        return DEFAULT_QUALITY
    return max(MIN_QUALITY, min(MAX_QUALITY, q))


def page_cache_path(cache_dir: str, filename: str, page: int, width: int,
                    quality: int, signature: str) -> str:
    """Where one rendered page lives: ``<cache>/<stem>/p<page>_w<width>_q<q>_<sig>.webp``.

    Per-paper subdirectories keep any single directory small (the corpus is ~10k papers
    × dozens of pages). ``signature`` is the source PDF's mtime+size digest, so
    re-OCR'ing a paper invalidates its pages instead of serving stale renders.
    """
    stem = os.path.basename(str(filename))
    if stem.lower().endswith(".pdf"):
        stem = stem[:-4]
    # The stem comes from a manifest basename, but keep the cache path independent of
    # whatever characters it carries.
    safe_stem = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in stem)[:120]
    leaf = f"p{int(page)}_w{int(width)}_q{int(quality)}_{signature}.webp"
    return os.path.join(cache_dir, safe_stem or "_", leaf)


#: How many opening words of a passage to search for, longest first. Long phrases are
#: precise but brittle (ligatures, hyphenation, column order); short ones always match
#: something. Trying in order gets the best available anchor.
LOCATE_WORD_TIERS = (14, 10, 7, 5)
#: Extra phrases from later in the passage, searched on the matched page only, so the
#: highlight covers the whole quoted span rather than just its first line.
LOCATE_EXTRA_PHRASES = 6


def normalize_quote(text: str) -> str:
    """Collapse whitespace — chunk text carries PDF line breaks that never match."""
    return " ".join(str(text or "").split())


def _phrase_tiers(words: list[str]) -> list[str]:
    """Opening phrases to try, longest first, de-duplicated."""
    seen: set[str] = set()
    out: list[str] = []
    for n in LOCATE_WORD_TIERS:
        n = min(n, len(words))
        if n < 3:
            continue
        phrase = " ".join(words[:n])
        if phrase not in seen:
            seen.add(phrase)
            out.append(phrase)
    return out


def locate_quote(pdf_path: str, quote: str, hint_page: int | None = None) -> dict:
    """Find which page a passage sits on, and where on that page it is.

    This is how the viewer opens at the *cited* page: the corpus store carries no
    per-chunk page numbers (and no re-ingest is planned), so the page is recovered from
    the PDF itself by searching for the passage text. Returns fractional rectangles
    (0-1, top-left origin) so the client can scale them to whatever size it renders at.

    ``{"page": None, "rects": []}`` means "no text match" — a scanned page, or text the
    extractor mangled. That is a normal outcome, not an error: the caller falls back to
    opening the paper at page 1 with no highlight.
    """
    import pymupdf

    words = normalize_quote(quote).split()
    result: dict = {"page": None, "rects": [], "page_count": 0, "matched": ""}
    if len(words) < 3:
        return result

    try:
        doc = pymupdf.open(pdf_path)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"cannot open PDF: {exc}") from exc

    try:
        if getattr(doc, "needs_pass", False) and not doc.authenticate(""):
            raise RuntimeError("PDF is password-protected")
        count = doc.page_count
        result["page_count"] = count
        if count == 0:
            return result

        # Search the hinted page first when we have one, then the rest in order.
        order = list(range(count))
        if hint_page and 1 <= hint_page <= count:
            order.remove(hint_page - 1)
            order.insert(0, hint_page - 1)

        for phrase in _phrase_tiers(words):
            for index in order:
                page = doc[index]
                hits = page.search_for(phrase)
                if not hits:
                    continue

                rect = page.rect
                width = rect.width or 1.0
                height = rect.height or 1.0
                spans = list(hits)

                # Extend the highlight across the rest of the passage, but only on this
                # page — a passage that runs onto the next page just highlights its head.
                step = max(1, len(words) // (LOCATE_EXTRA_PHRASES + 1))
                for start in range(step, len(words) - 2, step):
                    tail = " ".join(words[start:start + 6])
                    if len(tail.split()) < 3:
                        break
                    spans.extend(page.search_for(tail))
                    if len(spans) > 60:
                        break

                result["page"] = index + 1
                result["matched"] = phrase
                result["rects"] = [
                    [round(r.x0 / width, 5), round(r.y0 / height, 5),
                     round(r.x1 / width, 5), round(r.y1 / height, 5)]
                    for r in spans
                    if r.x1 > r.x0 and r.y1 > r.y0
                ]
                return result
        return result
    finally:
        doc.close()


def render_page_image(pdf_path: str, page: int, width: int = DEFAULT_WIDTH,
                      quality: int = DEFAULT_QUALITY) -> tuple[bytes, int, int]:
    """Rasterize a single 1-based page to WebP bytes.

    Returns ``(webp_bytes, page_count, rendered_page)`` — the page is clamped into
    range, so a stale page locator yields the nearest real page rather than an error.
    Raises RuntimeError when the PDF cannot be opened (corrupt or password-protected).
    """
    import pymupdf  # heavy; imported lazily so the module stays import-safe
    from PIL import Image

    try:
        doc = pymupdf.open(pdf_path)
    except Exception as exc:  # noqa: BLE001 — surfaced as a 422 by the caller
        raise RuntimeError(f"cannot open PDF: {exc}") from exc

    try:
        if getattr(doc, "needs_pass", False) and not doc.authenticate(""):
            raise RuntimeError("PDF is password-protected")
        count = doc.page_count
        if count <= 0:
            raise RuntimeError("PDF has no pages")
        index = max(0, min(count - 1, int(page) - 1))
        pdf_page = doc[index]
        rect = pdf_page.rect
        zoom = (width / rect.width) if rect.width else 1.0
        pix = pdf_page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=int(quality), method=4)
        return buf.getvalue(), count, index + 1
    finally:
        doc.close()
