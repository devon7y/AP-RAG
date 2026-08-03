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
import re

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
#: something. Trying in order gets the best available anchor — this only finds the PAGE;
#: the highlighted span itself comes from word-level alignment (see _align_words).
LOCATE_WORD_TIERS = (14, 10, 7, 5)
#: A passage often runs past a page break; follow it this many pages forward.
LOCATE_MAX_CONTINUATION_PAGES = 3
#: Alignment gives up once this share of the passage has failed to match, which keeps a
#: wrong anchor from painting half the page.
LOCATE_MAX_MISS_RATIO = 0.34


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


_WORD_CHARS = re.compile(r"[^a-z0-9]+")


def _norm_word(word: str) -> str:
    """Compare words by their letters alone — punctuation, quotes and ligature damage
    differ between the chunk text and the PDF's own text layer."""
    return _WORD_CHARS.sub("", str(word).lower())


def _align_words(page_words: list[str], target: list[str], start_at: int = 0
                 ) -> tuple[int, int, int, int]:
    """Align a passage against a page's words and return the contiguous run it covers.

    Returns ``(start_index, end_index, matched, target_consumed)``; ``start_index > end_index``
    means no usable alignment. The walk tolerates small disagreements — a word broken by
    hyphenation, a dropped ligature, a stray header word — because the goal is the SPAN,
    not an exact transcript: everything between the first and last matching word gets
    highlighted, which is what makes the highlight read as one selected passage instead
    of a scatter of matched fragments.
    """
    best = (0, -1, 0, 0)
    if not (page_words and target):
        return best

    first, second = target[0], target[1] if len(target) > 1 else None
    # Candidate starts: prefer the ones whose next word also matches (a cheap gate that
    # skips incidental single-word hits), but fall back to bare first-word matches —
    # some text layers reorder or drop the second word, and requiring the pair outright
    # made those passages unfindable.
    starts = [i for i in range(start_at, len(page_words)) if page_words[i] == first]
    gated = [
        i for i in starts
        if not second or (i + 1 < len(page_words) and page_words[i + 1] == second)
    ]
    for start in (gated or starts):

        ti = pi = 0
        matched = misses = 0
        last_hit = start
        while ti < len(target) and start + pi < len(page_words):
            page_word = page_words[start + pi]
            if page_word == target[ti]:
                matched += 1
                last_hit = start + pi
                ti += 1
                pi += 1
                continue
            # A word the page lacks (hyphenated across lines, or dropped).
            if ti + 1 < len(target) and page_word == target[ti + 1]:
                ti += 1
                continue
            # A word the page has but the passage doesn't (running head, line number).
            if start + pi + 1 < len(page_words) and page_words[start + pi + 1] == target[ti]:
                pi += 1
                continue
            misses += 1
            ti += 1
            pi += 1
            if misses > max(4, int(LOCATE_MAX_MISS_RATIO * (matched + misses))):
                break

        if matched > best[2]:
            best = (start, last_hit, matched, ti)
    return best


def _page_tokens(words_on_page: list[tuple]) -> tuple[list[str], list[int]]:
    """A page's comparable word tokens, plus each one's index in the raw word list.

    Symbols that carry no letters or digits — the standalone ``=`` and ``−`` of
    "z = −0.30, P = 0.767" — normalize to nothing. They are dropped from BOTH sides of
    the comparison rather than left in as empty strings: a run of two of them used to
    desync the alignment (it can step over one stray word, not two), which is how a
    statistics-heavy page failed to match at all.
    """
    tokens: list[str] = []
    index_map: list[int] = []
    for i, word in enumerate(words_on_page):
        normalized = _norm_word(word[4])
        if normalized:
            tokens.append(normalized)
            index_map.append(i)
    return tokens, index_map


def _merge_line_rects(words: list[tuple], start: int, end: int) -> list[list[float]]:
    """Union the matched words into one rectangle per text line, so the highlight looks
    like a selected passage rather than a box around every individual word."""
    lines: dict[tuple, list[float]] = {}
    order: list[tuple] = []
    for x0, y0, x1, y1, _w, block, line, _n in words[start:end + 1]:
        key = (block, line)
        box = lines.get(key)
        if box is None:
            lines[key] = [x0, y0, x1, y1]
            order.append(key)
        else:
            box[0] = min(box[0], x0)
            box[1] = min(box[1], y0)
            box[2] = max(box[2], x1)
            box[3] = max(box[3], y1)
    return [lines[k] for k in order]


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
    result: dict = {"page": None, "rects": [], "spans": [], "page_count": 0,
                    "matched": ""}
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

        target = [w for w in (_norm_word(w) for w in words) if w]
        if not target:
            return result

        # Which pages are worth aligning against? Phrase search usually pins the page in
        # a few milliseconds; it fails on some text layers even when the words are all
        # there, so an empty result falls back to considering every page.
        phrase_used = ""
        pages_to_try: list[int] = []
        for phrase in _phrase_tiers(words):
            for index in order:
                if doc[index].search_for(phrase):
                    pages_to_try = [index]
                    phrase_used = phrase
                    break
            if pages_to_try:
                break
        if not pages_to_try:
            pages_to_try = order

        # A passage must actually be *mostly* here to be worth highlighting: a couple of
        # coincidentally shared words is how a wrong page wins and a single stray line
        # gets painted, which is worse than admitting the passage wasn't found. The bar
        # scales with the passage — a short quote must match nearly all of its words,
        # while a long one only needs a solid run (it may be clipped by a page break) —
        # and can never exceed the number of words there are to match.
        ratio = 0.6 if len(target) < 12 else 0.25
        floor = min(len(target), max(3, min(int(ratio * len(target)), 20)))

        # Word-level alignment gives the CONTIGUOUS run the passage covers. (Searching
        # sampled phrases instead produced a scatter of disconnected fragments — a
        # passage is one continuous stretch of page.)
        best_matched = 0
        best_page: int | None = None
        for index in pages_to_try:
            tokens, _map = _page_tokens(doc[index].get_text("words"))
            _start, end, matched, _consumed = _align_words(tokens, target)
            if end >= 0 and matched > best_matched:
                best_matched = matched
                best_page = index
        if best_page is None or best_matched < floor:
            return result

        spans: list[dict] = []
        remaining = target
        page_index = best_page
        for _ in range(LOCATE_MAX_CONTINUATION_PAGES + 1):
            if not remaining or page_index >= count:
                break
            current = doc[page_index]
            words_on_page = current.get_text("words")
            tokens, index_map = _page_tokens(words_on_page)
            start, end, matched, consumed = _align_words(tokens, remaining)
            if end < start or matched < 3:
                break

            rect = current.rect
            width = rect.width or 1.0
            height = rect.height or 1.0
            spans.append({
                "page": page_index + 1,
                "rects": [
                    [round(x0 / width, 5), round(y0 / height, 5),
                     round(x1 / width, 5), round(y1 / height, 5)]
                    # Token indices map back to the raw word list for rect merging.
                    for x0, y0, x1, y1 in _merge_line_rects(
                        words_on_page, index_map[start], index_map[end])
                    if x1 > x0 and y1 > y0
                ],
            })

            remaining = remaining[consumed:]
            # Only follow onto the next page when the passage really ran out of page —
            # otherwise it simply ended here.
            if len(remaining) < 5 or end < len(tokens) - 3:
                break
            page_index += 1

        if not spans:
            return result
        result["page"] = spans[0]["page"]
        result["rects"] = spans[0]["rects"]
        result["spans"] = spans
        result["matched"] = phrase_used or " ".join(words[:8])
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
