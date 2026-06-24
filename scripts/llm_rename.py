#!/usr/bin/env python3
"""Derive citation-style filenames for PDFs with an LLM, then verify them.

Companion to ``verify_pdf_names.py``. Where the verifier only *flags* bad names
(it can't compute a correct name for a scan or a totally-misnamed file), this
script asks an LLM to read each paper and return the bibliographic facts needed
to build the canonical name:

    Author_YYYY.pdf | Author1_Author2_YYYY.pdf | Author1_Etal_YYYY.pdf

Backends: ``--backend openai`` (default, gpt-5-mini, OPENAI_API_KEY) or
``--backend gemini`` (gemini-2.5-flash, GEMINI_API_KEY). Both are multimodal.

For text-bearing PDFs it sends the first-page *text* (cheap). For scanned PDFs
with no text layer it rasterizes the first two pages with ``pdftoppm`` and sends
them as images, which finally lets us name the "UNVERIFIABLE" scans.

Run-each-paper-ONCE: every result is cached by the file's content hash in
``.llm_rename_cache.json``. Re-running skips cached papers, a rename does not
invalidate the cache (hash is unchanged), and adding new papers later only spends
API calls on the new ones.

The proposed name is then *verified*: for text PDFs the chosen first-author
surname must actually appear on the page; otherwise the file is routed to review
rather than renamed. Output is ``llm_rename_map.tsv`` (apply-able via
verify_pdf_names.py) plus ``llm_review.tsv`` (manual cases: non-papers, low
confidence, duplicates).

Usage:
    python3 llm_rename.py [DIR]                       # dry run, all PDFs (openai)
    python3 llm_rename.py [DIR] --files A.pdf B.pdf   # just these
    python3 llm_rename.py [DIR] --backend gemini      # use Gemini instead
    python3 llm_rename.py [DIR] --apply               # rename on disk after build

Default DIR is /Users/devon7y/Papers.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn  # noqa: E402  (ascii_name, canonical_name, fold, ...)

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

# Gemini wants UPPER-CASE OpenAPI types under generationConfig.responseSchema.
SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "is_citable_work": {"type": "BOOLEAN"},
        "document_kind": {"type": "STRING"},
        "title": {"type": "STRING"},
        "first_author_surname": {"type": "STRING"},
        "second_author_surname": {"type": "STRING"},
        "num_authors": {"type": "INTEGER"},
        "year": {"type": "STRING"},
        "confidence": {"type": "STRING", "enum": ["high", "medium", "low"]},
    },
    "required": ["is_citable_work", "document_kind", "first_author_surname",
                 "num_authors", "year", "confidence"],
}

# OpenAI structured outputs need lower-case JSON Schema, additionalProperties
# false, and (strict mode) EVERY property listed in "required".
OPENAI_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "is_citable_work": {"type": "boolean"},
        "document_kind": {"type": "string"},
        "title": {"type": "string"},
        "first_author_surname": {"type": "string"},
        "second_author_surname": {"type": "string"},
        "num_authors": {"type": "integer"},
        "year": {"type": "string"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["is_citable_work", "document_kind", "title",
                 "first_author_surname", "second_author_surname",
                 "num_authors", "year", "confidence"],
}

# rough USD per 1M (input, output) tokens, for the cost estimate only.
PRICING = {"gpt-5-mini": (0.25, 2.00), "gpt-5.4-mini": (0.75, 4.50)}

PROMPT = """You are cataloguing a scholarly PDF library. From the document \
content below, extract the bibliographic facts needed to build a citation \
filename. Follow these rules exactly:

- CRITICAL: use ONLY the byline of THIS document -- the author line directly \
under the title at the top of the first page. NEVER take an author from the \
reference/bibliography list, an in-text citation, an epigraph, or (in a \
two-column scan where text is interleaved) a DIFFERENT article on the page. If \
the first page is a cover/abstract sheet, use the actual title page's byline.
- first_author_surname: family name of the FIRST listed author (or, for an \
edited volume with no authors, the first editor) ONLY. Not the journal/publisher, \
not a corresponding-author footnote. ASCII, keep internal hyphens (e.g. \
Baron-Cohen) and multi-word surnames glued (e.g. van Santen -> vanSanten), \
drop accents/apostrophes/titles.
- second_author_surname: ONLY if there are exactly two authors; else "".
- num_authors: total number of authors of THIS work.
- year: 4-digit publication year of THIS work. The year is often NOT on the title \
page -- check the copyright page (e.g. "(c) 2009", "First published 2009") and \
journal masthead. For a reprint/translation of a classic, use the year printed \
for THIS edition. If you truly cannot find it, "".
- title: the work's title (short).
- is_citable_work: TRUE for any single scholarly work that should be filed under \
an author -- a journal article, preprint, thesis, report, book CHAPTER, or whole \
BOOK / monograph (books absolutely count). FALSE only for things that are not a \
citable work: a table of contents, index, bibliography, series/half-title page, a \
questionnaire or scale, a software/package manual, a syllabus or homework, a CV, \
a cover sheet, supplementary material, or non-scholarly journalism.
- document_kind: one of journal-article, book-chapter, book, preprint, thesis, \
report, front-matter, form-or-scale, software-manual, supplementary, news, other.
- confidence: high/medium/low for your overall extraction.

Return JSON matching the schema."""


def file_hash(path: Path) -> str:
    """Fast content fingerprint: sha1(size + first 1 MiB)."""
    h = hashlib.sha1()
    try:
        sz = path.stat().st_size
        h.update(str(sz).encode())
        with open(path, "rb") as f:
            h.update(f.read(1 << 20))
    except OSError:
        return ""
    return h.hexdigest()


def first_pages_text(path: Path, pages: int = 2) -> str:
    try:
        out = subprocess.run(
            ["pdftotext", "-f", "1", "-l", str(pages), "-layout", str(path), "-"],
            capture_output=True, timeout=60).stdout.decode("utf-8", "ignore")
        return out
    except Exception:
        return ""


def first_pages_png(path: Path, pages: int = 2, dpi: int = 150) -> list[bytes]:
    """Rasterize the first pages to PNG bytes (for scanned PDFs)."""
    import tempfile
    imgs: list[bytes] = []
    with tempfile.TemporaryDirectory() as td:
        stem = os.path.join(td, "p")
        try:
            subprocess.run(["pdftoppm", "-png", "-r", str(dpi), "-f", "1",
                            "-l", str(pages), str(path), stem],
                           capture_output=True, timeout=120, check=True)
        except Exception:
            return imgs
        for f in sorted(Path(td).glob("p*.png")):
            imgs.append(f.read_bytes())
    return imgs


def gemini_extract(path: Path, model: str, key: str) -> dict | None:
    """One Gemini call per paper. Text if available, else page images."""
    text = first_pages_text(path, pages=4)
    parts: list[dict]
    if len(text.strip()) >= 200:
        parts = [{"text": PROMPT + "\n\nDOCUMENT TEXT:\n\n" + text[:8000]}]
    else:
        pngs = first_pages_png(path)
        if not pngs:
            return {"is_academic_paper": False, "document_kind": "other",
                    "first_author_surname": "", "num_authors": 0, "year": "",
                    "confidence": "low", "title": "",
                    "_note": "no text and could not rasterize"}
        parts = [{"text": PROMPT + "\n\nThe document pages are attached as images."}]
        for png in pngs[:2]:
            parts.append({"inline_data": {"mime_type": "image/png",
                                          "data": base64.b64encode(png).decode()}})

    body = {"contents": [{"parts": parts}],
            "generationConfig": {"responseMimeType": "application/json",
                                 "responseSchema": SCHEMA, "temperature": 0}}

    delay = 5.0
    for attempt in range(4):
        try:
            r = requests.post(API.format(model=model), params={"key": key},
                              json=body, timeout=120)
        except requests.RequestException:
            time.sleep(delay); delay *= 2.5; continue
        if r.status_code == 200:
            try:
                txt = r.json()["candidates"][0]["content"]["parts"][0]["text"]
                return json.loads(txt)
            except (KeyError, IndexError, ValueError):
                return None
        if r.status_code == 429:        # rate / quota limited
            if attempt == 3:
                raise RuntimeError("RATE_LIMITED")
            time.sleep(delay); delay *= 2.5; continue
        # other errors: surface once, no retry
        return {"_error": f"HTTP {r.status_code}: {r.text[:160]}"}
    return None


def openai_extract(path: Path, model: str, key: str,
                   usage: dict, lock: "threading.Lock",
                   reasoning: str = "low") -> dict | None:
    """One OpenAI chat-completions call per paper (text, else page images)."""
    text = first_pages_text(path, pages=4)
    if len(text.strip()) >= 200:
        content: list = [{"type": "text",
                          "text": "DOCUMENT TEXT:\n\n" + text[:8000]}]
    else:
        pngs = first_pages_png(path)
        if not pngs:
            return {"is_citable_work": False, "document_kind": "other",
                    "title": "", "first_author_surname": "",
                    "second_author_surname": "", "num_authors": 0, "year": "",
                    "confidence": "low", "_note": "no text and no rasterize"}
        content = [{"type": "text",
                    "text": "The document pages are attached as images."}]
        for png in pngs[:2]:
            b64 = base64.b64encode(png).decode()
            content.append({"type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{b64}"}})

    body = {"model": model,
            "messages": [{"role": "system", "content": PROMPT},
                         {"role": "user", "content": content}],
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "biblio", "strict": True,
                                                "schema": OPENAI_SCHEMA}},
            "reasoning_effort": reasoning,
            "max_completion_tokens": 3000}

    delay = 4.0
    for attempt in range(5):
        try:
            r = requests.post(OPENAI_URL, headers={"Authorization": f"Bearer {key}"},
                              json=body, timeout=180)
        except requests.RequestException:
            time.sleep(delay); delay *= 2; continue
        if r.status_code == 200:
            j = r.json()
            u = j.get("usage", {})
            with lock:
                usage["in"] += u.get("prompt_tokens", 0)
                usage["out"] += u.get("completion_tokens", 0)
            msg = j.get("choices", [{}])[0].get("message", {})
            if msg.get("refusal"):
                return {"_error": "refusal: " + str(msg["refusal"])[:120]}
            try:
                return json.loads(msg["content"])
            except (KeyError, TypeError, ValueError):
                return None
        if r.status_code == 429:
            low = r.text.lower()
            if "insufficient_quota" in low or "billing" in low:
                raise RuntimeError(f"QUOTA_EXHAUSTED: {r.text[:200]}")
            if attempt == 4:
                raise RuntimeError("RATE_LIMITED")
            time.sleep(delay); delay *= 2; continue
        if r.status_code >= 500:
            if attempt == 4:
                return {"_error": f"HTTP {r.status_code}"}
            time.sleep(delay); delay *= 2; continue
        return {"_error": f"HTTP {r.status_code}: {r.text[:160]}"}
    return None


# --------------------------------------------------------------------------- #
# Build a canonical name from an LLM result
# --------------------------------------------------------------------------- #
def proposed_name(res: dict) -> tuple[str, str] | None:
    """Return (new_basename, tier) or None if not nameable."""
    if not res or res.get("_error") or not res.get("is_citable_work"):
        return None
    if str(res.get("confidence")) == "low":
        return None
    a1 = vpn.ascii_name(res.get("first_author_surname", ""))
    ym = re.search(r"(1[5-9]\d{2}|20\d{2})", str(res.get("year", "")))
    if not a1 or not ym:
        return None
    year = ym.group(0)
    try:
        n = int(res.get("num_authors") or 0)
    except (TypeError, ValueError):
        n = 0
    a2 = vpn.ascii_name(res.get("second_author_surname", "") or "")
    if n >= 3:
        return (vpn.canonical_name(a1, "Etal", year), "etal")
    if n == 2 and a2:
        return (vpn.canonical_name(a1, a2, year), "two")
    if n == 2 and not a2:
        return (vpn.canonical_name(a1, "Etal", year), "two-noname")
    return (vpn.canonical_name(a1, "", year), "one")


def free_disambiguated(base: str, taken: set[str]) -> str:
    """If base collides, append a/b/c to the year: Smith_2020 -> Smith_2020a."""
    if base.lower() not in taken:
        return base
    m = re.match(r"^(.*_)(\d{4})(\.pdf)$", base) or \
        re.match(r"^(.*_)(\d{4})([a-z])(\.pdf)$", base)
    if not m:
        return base
    stem, year = m.group(1), m.group(2)
    for c in "abcdefghijklmnopqrstuvwxyz":
        cand = f"{stem}{year}{c}.pdf"
        if cand.lower() not in taken:
            return cand
    return base


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("directory", nargs="?", default="/Users/devon7y/Papers")
    ap.add_argument("--backend", choices=["openai", "gemini"], default="openai")
    ap.add_argument("--model", default=None,
                    help="default: gpt-5-mini (openai) / gemini-2.5-flash (gemini)")
    ap.add_argument("--files", nargs="*", help="only these basenames")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--reasoning", choices=["minimal", "low", "medium", "high"],
                    default="low", help="OpenAI reasoning effort (lower = cheaper)")
    ap.add_argument("--limit", type=int, default=0, help="cap number of API calls")
    ap.add_argument("--refresh", action="store_true",
                    help="re-query even cached papers (e.g. upgrade the review "
                         "tail to a stronger --model); usually paired with --files")
    ap.add_argument("--cache", default=".llm_rename_cache.json")
    ap.add_argument("--map-out", default="llm_rename_map.tsv")
    ap.add_argument("--review-out", default="llm_review.tsv")
    ap.add_argument("--apply", action="store_true",
                    help="apply the rename map after building it")
    args = ap.parse_args()

    if not args.model:
        args.model = "gpt-5-mini" if args.backend == "openai" else "gemini-2.5-flash"
    key_var = "OPENAI_API_KEY" if args.backend == "openai" else "GEMINI_API_KEY"
    key = os.environ.get(key_var)
    if not key:
        print(f"error: {key_var} not set", file=sys.stderr)
        return 2
    root = Path(args.directory).expanduser()
    if not root.is_dir():
        print(f"error: {root} not a directory", file=sys.stderr)
        return 2

    cache_path = Path(args.cache)
    cache: dict = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except Exception:
            cache = {}
    lock = threading.Lock()

    def save_cache():
        try:
            cache_path.write_text(json.dumps(cache))
        except Exception:
            pass

    pdfs = sorted(p for p in root.iterdir()
                  if p.is_file() and p.suffix.lower() == ".pdf")
    if args.files:
        want = {f.lower() for f in args.files}
        pdfs = [p for p in pdfs if p.name.lower() in want]

    # map each file to its content hash; reuse cache; queue the uncached
    # (or all, when --refresh forces a re-query, e.g. with a stronger model)
    hashes = {p: file_hash(p) for p in pdfs}
    todo = [p for p in pdfs
            if hashes[p] and (args.refresh or hashes[p] not in cache)]
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(pdfs)} PDFs; {len(pdfs) - len(todo)} cached; "
          f"calling {args.backend} ({args.model}) on {len(todo)} ...",
          file=sys.stderr)

    usage = {"in": 0, "out": 0}

    def extract_one(p: Path):
        if args.backend == "openai":
            return openai_extract(p, args.model, key, usage, lock, args.reasoning)
        return gemini_extract(p, args.model, key)

    done = 0
    quota_msg = ""
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(extract_one, p): p for p in todo}
        for fut in as_completed(futs):
            p = futs[fut]
            try:
                res = fut.result()
            except RuntimeError as e:
                if not quota_msg:
                    quota_msg = str(e)
                continue
            if res is None:
                res = {"_error": "no result"}
            with lock:
                cache[hashes[p]] = {"file": p.name, "result": res,
                                    "backend": args.backend, "model": args.model}
                done += 1
                if done % 25 == 0:
                    save_cache()
                    print(f"  ...{done}/{len(todo)}", file=sys.stderr)
    save_cache()
    if quota_msg:
        if "QUOTA_EXHAUSTED" in quota_msg:
            print(f"\n!! {args.backend} quota/billing exhausted -- {quota_msg}\n"
                  "   Re-running will NOT help until the account is funded; "
                  "cached results are preserved.", file=sys.stderr)
        else:
            print("\n!! hit rate limit; cached what completed. Re-run later to "
                  "continue (cached papers are skipped).", file=sys.stderr)

    # ---- build proposals from cached results ----
    existing = {p.name.lower() for p in pdfs}
    hash_by_name = {p.name: hashes[p] for p in pdfs}
    taken = set(existing)            # names in use, updated as we reserve targets
    auto: list[tuple[str, str, str]] = []        # src, dst, tier
    review: list[tuple[str, str, str, str]] = []  # src, dst, reason, evidence

    for p in pdfs:
        h = hashes.get(p)
        entry = cache.get(h) if h else None
        if not entry:
            continue
        res = entry.get("result", {})
        if res.get("_error"):
            review.append((p.name, "", "llm-error", str(res.get("_error"))))
            continue
        prop = proposed_name(res)
        kind = res.get("document_kind", "")
        title = (res.get("title") or "")[:80]
        if not prop:
            why = "not-a-citable-work" if not res.get("is_citable_work") else \
                  ("low-confidence" if res.get("confidence") == "low"
                   else "incomplete-metadata")
            review.append((p.name, "", why, f"{kind}: {title}"))
            continue
        dst, tier = prop
        if dst.lower() == p.name.lower():
            continue                                   # already correctly named
        # collision handling
        if dst.lower() in taken:
            other_hash = hash_by_name.get(dst)
            if other_hash and other_hash == h:
                review.append((p.name, dst, "duplicate",
                               f"identical content already filed as {dst}"))
                continue
            dst = free_disambiguated(dst, taken)
            tier += "+disambig"
        # verification gate: for text PDFs the author must be on the page
        text = first_pages_text(p)
        verified = True
        if len(text.strip()) >= 200:
            verified = vpn.surname_in_text(
                res.get("first_author_surname", ""), text) != "no"
        vtier = tier if verified else tier + "+UNVERIFIED"
        if not verified:
            review.append((p.name, dst, "llm-author-not-on-page",
                           f"LLM says {res.get('first_author_surname')} "
                           f"{res.get('year')}; not found in text"))
            continue
        taken.add(dst.lower())
        auto.append((p.name, dst, vtier))

    # ---- write outputs ----
    map_path = Path(args.map_out)
    with open(map_path, "w") as f:
        f.write("# old_name\tnew_name\ttier\n")
        f.write(f"# apply: python3 verify_pdf_names.py {root} "
                f"--apply {map_path.name}\n")
        for src, dst, tier in sorted(auto):
            f.write(f"{src}\t{dst}\t{tier}\n")
    review_path = Path(args.review_out)
    with open(review_path, "w") as f:
        f.write("# old_name\tsuggested_new_name\treason\tevidence\n")
        for row in sorted(review):
            f.write("\t".join(row) + "\n")

    print(f"\n=== {args.backend.upper()} RENAME PLAN (nothing changed) ===")
    print(f"  rename map  -> {map_path}  ({len(auto)} files)")
    print(f"  review list -> {review_path}  ({len(review)} files)")
    print(f"  cache       -> {cache_path}  ({len(cache)} papers processed)")
    if usage["in"] or usage["out"]:
        rin, rout = PRICING.get(args.model, (0.0, 0.0))
        cost = usage["in"] / 1e6 * rin + usage["out"] / 1e6 * rout
        print(f"  tokens this run: {usage['in']:,} in / {usage['out']:,} out"
              + (f"  (~${cost:.2f} approx)" if cost else ""))
    if auto:
        print("\n  sample of proposed renames:")
        for src, dst, tier in sorted(auto)[:20]:
            print(f"    {src}  ->  {dst}   [{tier}]")

    if args.apply and auto:
        print("\nApplying ...")
        return vpn.apply_map(map_path, root)
    elif auto:
        print(f"\n  To apply: python3 verify_pdf_names.py {root} "
              f"--apply {map_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
