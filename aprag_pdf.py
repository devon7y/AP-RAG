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
