#!/usr/bin/env python3
"""Build ``papers_metadata.json`` — full APA7 bibliographic records keyed by the
canonical PDF filename.

This is the data behind the APA7 citations the query server emits (see
``apa_citations.py`` / ``query_server.py``). For every PDF in a corpus directory
(named ``Author_Year.pdf`` / ``Author1_Author2_Year.pdf`` / ``Author1_Etal_Year.pdf``):

  1. Extract a DOI from the first pages. If found, fetch the **full** Crossref
     record (all authors, container, volume, issue, pages, type, publisher) — far
     richer than the ``{family, year}`` that ``verify_pdf_names.py`` caches.
  2. Otherwise (book, chapter, no-DOI item, or a Crossref miss) ask a multimodal
     LLM (gpt-5-mini by default, or gemini-2.5-flash) to read the first pages and
     return the bibliographic fields.

The disambiguation letter is taken from the canonical filename (``Wrathall_2013a``),
which is authoritative once the corpus is renamed.

Both sources are cached so re-running only spends API calls on new papers:
``.crossref_full_cache.json`` (DOI → record) and ``.apa_llm_cache.json``
(content-hash → record). Existing entries in the output manifest are kept unless
``--refresh`` is given.

Output record shape (consumed by ``apa_citations.load_manifest``):

    "Westbury_Hollis_2019.pdf": {
        "type": "article", "authors": [{"family": "...", "given": "..."}],
        "editors": [], "year": "2019", "title": "...",
        "container_title": "...", "volume": "...", "issue": "...",
        "pages": "...", "publisher": "...", "doi": "...",
        "disambig": "", "source": "crossref"
    }

Usage:
    python3 build_apa_manifest.py [DIR] [--out papers_metadata.json]
    python3 build_apa_manifest.py [DIR] --backend gemini
    python3 build_apa_manifest.py [DIR] --files Smith_2020.pdf --refresh
    python3 build_apa_manifest.py [DIR] --no-llm        # Crossref/DOI only

Default DIR is /Users/devon7y/Papers. Crossref + the LLM need internet (run on the
PC or an HPC login node, never a no-internet compute node).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Only stdlib at import time so the pure transforms below are unit-testable without
# `requests`/poppler. Heavy helpers are imported lazily inside the functions/main
# that actually call the network or shell out to poppler.

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>)\]]+", re.IGNORECASE)
_FILENAME_RE = re.compile(r"^.*_(?P<year>\d{4})(?P<dis>[a-z])?\.pdf$", re.IGNORECASE)

# Crossref `type` → our coarse type used by the APA formatter.
_CR_TYPE = {
    "journal-article": "article",
    "proceedings-article": "article",
    "posted-content": "preprint",
    "book-chapter": "chapter",
    "reference-entry": "chapter",
    "book": "book",
    "monograph": "book",
    "edited-book": "book",
    "book-section": "chapter",
    "report": "report",
    "dissertation": "thesis",
}


# ── Pure transforms (no I/O — unit-testable) ──────────────────────────────────


def _map_type(cr_type: str) -> str:
    return _CR_TYPE.get((cr_type or "").strip().lower(), "other")


def _cr_year(msg: dict) -> str:
    for key in ("published-print", "published-online", "issued", "published", "created"):
        parts = (msg.get(key) or {}).get("date-parts") or []
        if parts and parts[0] and parts[0][0]:
            return str(parts[0][0])
    return ""


def _people(items) -> list[dict]:
    out = []
    for p in items or []:
        fam = (p.get("family") or "").strip()
        giv = (p.get("given") or "").strip()
        if fam or giv:
            out.append({"family": fam, "given": giv})
    return out


def _strip_jats(text: str) -> str:
    """Crossref abstracts are JATS XML — strip tags, collapse whitespace, drop a
    leading 'Abstract' label."""
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"^abstract[:\s]*", "", text, flags=re.IGNORECASE).strip()


def _affiliations_from_authors(authors) -> list[str]:
    """Distinct institution names across all authors' Crossref affiliations."""
    out, seen = [], set()
    for a in authors or []:
        for af in a.get("affiliation") or []:
            name = (af.get("name") or "").strip()
            if name and name.lower() not in seen:
                seen.add(name.lower())
                out.append(name)
    return out


def _str_list(items) -> list[str]:
    return [s.strip() for s in (items or []) if isinstance(s, str) and s.strip()]


def crossref_to_record(msg: dict, doi: str = "") -> dict:
    """Map a Crossref ``message`` object to our manifest record schema."""
    titles = msg.get("title") or []
    containers = msg.get("container-title") or []
    return {
        "type": _map_type(msg.get("type", "")),
        "authors": _people(msg.get("author")),
        "editors": _people(msg.get("editor")),
        "year": _cr_year(msg),
        "title": (titles[0] if titles else "").strip(),
        "container_title": (containers[0] if containers else "").strip(),
        "volume": str(msg.get("volume", "")).strip(),
        "issue": str(msg.get("issue", "")).strip(),
        "pages": str(msg.get("page", "")).strip(),
        "publisher": str(msg.get("publisher", "")).strip(),
        "doi": (doi or msg.get("DOI", "")).strip().lower(),
        # search/filter fields (shared with metadata-filtered search)
        "keywords": [],  # Crossref has no author keywords; the LLM fills these
        "abstract": _strip_jats(msg.get("abstract", "")),
        "subjects": _str_list(msg.get("subject")),
        "affiliations": _affiliations_from_authors(msg.get("author")),
        "source": "crossref",
    }


def llm_result_to_record(res: dict) -> dict | None:
    """Map an LLM extraction result to our record schema (None if not citable)."""
    if not res or res.get("_error"):
        return None
    if res.get("is_citable_work") is False:
        return None
    return {
        "type": (res.get("type") or "other").strip().lower(),
        "authors": _people(res.get("authors")),
        "editors": _people(res.get("editors")),
        "year": str(res.get("year") or "").strip(),
        "title": (res.get("title") or "").strip(),
        "container_title": (res.get("container_title") or "").strip(),
        "volume": str(res.get("volume") or "").strip(),
        "issue": str(res.get("issue") or "").strip(),
        "pages": str(res.get("pages") or "").strip(),
        "publisher": (res.get("publisher") or "").strip(),
        "doi": (res.get("doi") or "").strip().lower(),
        "keywords": _str_list(res.get("keywords")),
        "abstract": (res.get("abstract") or "").strip(),
        "subjects": _str_list(res.get("subjects")),
        "affiliations": _str_list(res.get("affiliations")),
        "source": "llm",
    }


def finalize_record(record: dict, filename: str) -> dict:
    """Stamp the filename-authoritative disambiguation letter and a year fallback."""
    m = _FILENAME_RE.match(filename)
    if m:
        record["disambig"] = m.group("dis") or ""
        if not record.get("year"):
            record["year"] = m.group("year")
    else:
        record.setdefault("disambig", "")
    return record


def has_minimum_fields(record: dict | None) -> bool:
    """A record is usable if it has at least one author/editor and a year."""
    if not record:
        return False
    if not (record.get("authors") or record.get("editors")):
        return False
    return bool(record.get("year"))


# ── LLM extraction schemas + prompt ───────────────────────────────────────────

_PERSON_OAI = {
    "type": "object", "additionalProperties": False,
    "properties": {"family": {"type": "string"}, "given": {"type": "string"}},
    "required": ["family", "given"],
}
OPENAI_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "is_citable_work": {"type": "boolean"},
        "type": {"type": "string",
                 "enum": ["article", "book", "chapter", "report", "thesis",
                          "preprint", "other"]},
        "title": {"type": "string"},
        "authors": {"type": "array", "items": _PERSON_OAI},
        "editors": {"type": "array", "items": _PERSON_OAI},
        "year": {"type": "string"},
        "container_title": {"type": "string"},
        "volume": {"type": "string"},
        "issue": {"type": "string"},
        "pages": {"type": "string"},
        "publisher": {"type": "string"},
        "doi": {"type": "string"},
        "keywords": {"type": "array", "items": {"type": "string"}},
        "abstract": {"type": "string"},
        "subjects": {"type": "array", "items": {"type": "string"}},
        "affiliations": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["is_citable_work", "type", "title", "authors", "editors", "year",
                 "container_title", "volume", "issue", "pages", "publisher", "doi",
                 "keywords", "abstract", "subjects", "affiliations", "confidence"],
}
_PERSON_G = {"type": "OBJECT",
             "properties": {"family": {"type": "STRING"}, "given": {"type": "STRING"}}}
GEMINI_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "is_citable_work": {"type": "BOOLEAN"},
        "type": {"type": "STRING"},
        "title": {"type": "STRING"},
        "authors": {"type": "ARRAY", "items": _PERSON_G},
        "editors": {"type": "ARRAY", "items": _PERSON_G},
        "year": {"type": "STRING"},
        "container_title": {"type": "STRING"},
        "volume": {"type": "STRING"},
        "issue": {"type": "STRING"},
        "pages": {"type": "STRING"},
        "publisher": {"type": "STRING"},
        "doi": {"type": "STRING"},
        "keywords": {"type": "ARRAY", "items": {"type": "STRING"}},
        "abstract": {"type": "STRING"},
        "subjects": {"type": "ARRAY", "items": {"type": "STRING"}},
        "affiliations": {"type": "ARRAY", "items": {"type": "STRING"}},
        "confidence": {"type": "STRING", "enum": ["high", "medium", "low"]},
    },
    "required": ["is_citable_work", "type", "title", "authors", "year", "confidence"],
}

PROMPT = """You are cataloguing a scholarly PDF library. From the document content \
below, extract the bibliographic facts needed to build a complete APA-7 citation. \
Rules:

- authors: EVERY author of THIS work, in order, each as {family, given}. `given` \
is the full given name(s) as printed (e.g. "Chris" or "Geoffrey B."); do not \
abbreviate to initials. For an edited volume with no authors, leave authors empty \
and fill editors instead.
- editors: editors of the containing book (for a book chapter) or of an edited \
volume; else empty.
- year: 4-digit publication year of THIS work/edition. Often on the copyright page \
or journal masthead, not the title page. If truly absent, "".
- title: the work's own title (article or chapter or book title).
- container_title: the JOURNAL name for an article, or the BOOK title for a chapter. \
Empty for a whole book.
- volume, issue, pages: as printed ("128", "3", "97-123"); "" if absent.
- publisher: for books/chapters/reports; "" for journal articles.
- doi: the DOI of THIS work if printed; else "".
- type: one of article, book, chapter, report, thesis, preprint, other.
- keywords: the author-supplied keywords/index terms if listed; else a few (3-8) \
topical terms you infer from the title/abstract. Lowercase noun phrases.
- abstract: the work's abstract verbatim if present on these pages; else "".
- subjects: 1-4 broad field/discipline labels (e.g. "Cognitive Psychology", \
"Linguistics", "Neuroscience").
- affiliations: the distinct institutions/universities of the authors as printed; \
else [].
- is_citable_work: TRUE for any single scholarly work (article, preprint, thesis, \
report, book chapter, or whole book). FALSE for a table of contents, index, \
bibliography, questionnaire, manual, syllabus, cover sheet, or supplementary file.
- confidence: high/medium/low for your overall extraction.

Return JSON matching the schema."""


def _openai_call(path: Path, model: str, key: str, reasoning: str,
                 usage: dict, lock: "threading.Lock"):
    import time

    import requests
    from llm_rename import first_pages_text, first_pages_png

    text = first_pages_text(path, pages=4)
    if len(text.strip()) >= 200:
        content = [{"type": "text", "text": "DOCUMENT TEXT:\n\n" + text[:9000]}]
    else:
        import base64
        pngs = first_pages_png(path)
        if not pngs:
            return {"_error": "no text and could not rasterize"}
        content = [{"type": "text", "text": "The document pages are attached as images."}]
        for png in pngs[:2]:
            b64 = base64.b64encode(png).decode()
            content.append({"type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{b64}"}})

    body = {"model": model,
            "messages": [{"role": "system", "content": PROMPT},
                         {"role": "user", "content": content}],
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "apa_biblio", "strict": True,
                                                "schema": OPENAI_SCHEMA}},
            "reasoning_effort": reasoning,
            "max_completion_tokens": 4000}
    delay = 4.0
    for attempt in range(5):
        try:
            r = requests.post("https://api.openai.com/v1/chat/completions",
                              headers={"Authorization": f"Bearer {key}"},
                              json=body, timeout=180)
        except requests.RequestException:
            time.sleep(delay)
            delay *= 2
            continue
        if r.status_code == 200:
            j = r.json()
            u = j.get("usage", {})
            with lock:
                usage["in"] += u.get("prompt_tokens", 0)
                usage["out"] += u.get("completion_tokens", 0)
            msg = j.get("choices", [{}])[0].get("message", {})
            if msg.get("refusal"):
                return {"_error": "refusal"}
            try:
                return json.loads(msg["content"])
            except (KeyError, TypeError, ValueError):
                return {"_error": "unparseable response"}
        if r.status_code == 429:
            low = r.text.lower()
            if "insufficient_quota" in low or "billing" in low:
                raise RuntimeError(f"QUOTA_EXHAUSTED: {r.text[:160]}")
            if attempt == 4:
                raise RuntimeError("RATE_LIMITED")
            time.sleep(delay)
            delay *= 2
            continue
        if r.status_code >= 500:
            if attempt == 4:
                return {"_error": f"HTTP {r.status_code}"}
            time.sleep(delay)
            delay *= 2
            continue
        return {"_error": f"HTTP {r.status_code}: {r.text[:140]}"}
    return {"_error": "no result"}


def _gemini_call(path: Path, model: str, key: str):
    import base64
    import time
    import requests
    from llm_rename import first_pages_text, first_pages_png

    text = first_pages_text(path, pages=4)
    if len(text.strip()) >= 200:
        parts = [{"text": PROMPT + "\n\nDOCUMENT TEXT:\n\n" + text[:9000]}]
    else:
        pngs = first_pages_png(path)
        if not pngs:
            return {"_error": "no text and could not rasterize"}
        parts = [{"text": PROMPT + "\n\nThe document pages are attached as images."}]
        for png in pngs[:2]:
            parts.append({"inline_data": {"mime_type": "image/png",
                                          "data": base64.b64encode(png).decode()}})
    body = {"contents": [{"parts": parts}],
            "generationConfig": {"responseMimeType": "application/json",
                                 "responseSchema": GEMINI_SCHEMA, "temperature": 0}}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    delay = 5.0
    for attempt in range(4):
        try:
            r = requests.post(url, params={"key": key}, json=body, timeout=120)
        except requests.RequestException:
            time.sleep(delay)
            delay *= 2.5
            continue
        if r.status_code == 200:
            try:
                txt = r.json()["candidates"][0]["content"]["parts"][0]["text"]
                return json.loads(txt)
            except (KeyError, IndexError, ValueError):
                return {"_error": "unparseable response"}
        if r.status_code == 429:
            if attempt == 3:
                raise RuntimeError("RATE_LIMITED")
            time.sleep(delay)
            delay *= 2.5
            continue
        return {"_error": f"HTTP {r.status_code}: {r.text[:140]}"}
    return {"_error": "no result"}


# ── Crossref (full record) ────────────────────────────────────────────────────


def crossref_full(doi: str, mailto: str, cache: dict) -> dict | None:
    """Fetch + cache the full Crossref record for a DOI, mapped to our schema."""
    import requests
    doi = doi.rstrip(".,;").lower()
    if doi in cache:
        return cache[doi]
    try:
        r = requests.get(f"https://api.crossref.org/works/{doi}",
                         params={"mailto": mailto},
                         headers={"User-Agent": f"aprag-apa/1.0 (mailto:{mailto})"},
                         timeout=25)
        if r.status_code != 200:
            cache[doi] = None
            return None
        rec = crossref_to_record(r.json().get("message", {}), doi)
        cache[doi] = rec
        return rec
    except Exception:
        cache[doi] = None
        return None


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("directory", nargs="?", default="/Users/devon7y/Papers")
    ap.add_argument("--out", default="papers_metadata.json")
    ap.add_argument("--backend", choices=["openai", "gemini"], default="openai")
    ap.add_argument("--model", default=None,
                    help="default: gpt-5-mini (openai) / gemini-2.5-flash (gemini)")
    ap.add_argument("--files", nargs="*", help="only these basenames")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--reasoning", choices=["minimal", "low", "medium", "high"],
                    default="low", help="OpenAI reasoning effort")
    ap.add_argument("--limit", type=int, default=0, help="cap number of papers processed")
    ap.add_argument("--refresh", action="store_true",
                    help="rebuild even papers already present in the output manifest")
    ap.add_argument("--no-llm", action="store_true",
                    help="Crossref/DOI only; leave non-DOI papers to the filename fallback")
    ap.add_argument("--mailto", default=os.environ.get("CROSSREF_MAILTO", "devon7y@gmail.com"))
    ap.add_argument("--crossref-cache", default=".crossref_full_cache.json")
    ap.add_argument("--llm-cache", default=".apa_llm_cache.json")
    args = ap.parse_args()

    # llm_rename lives next to this script; reuse its PDF helpers.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from llm_rename import file_hash, first_pages_text  # noqa: F401  (lazy import)

    if not args.model:
        args.model = "gpt-5-mini" if args.backend == "openai" else "gemini-2.5-flash"
    key = None
    if not args.no_llm:
        key_var = "OPENAI_API_KEY" if args.backend == "openai" else "GEMINI_API_KEY"
        key = os.environ.get(key_var)
        if not key:
            print(f"warning: {key_var} not set — running Crossref/DOI only "
                  "(non-DOI papers will use the filename fallback)", file=sys.stderr)
            args.no_llm = True

    root = Path(args.directory).expanduser()
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 2

    def _load(path):
        p = Path(path)
        if p.exists():
            try:
                return json.loads(p.read_text())
            except Exception:
                return {}
        return {}

    manifest = _load(args.out)
    cr_cache = _load(args.crossref_cache)
    llm_cache = _load(args.llm_cache)
    lock = threading.Lock()

    pdfs = sorted(p for p in root.iterdir()
                  if p.is_file() and p.suffix.lower() == ".pdf")
    if args.files:
        want = {f.lower() for f in args.files}
        pdfs = [p for p in pdfs if p.name.lower() in want]
    todo = [p for p in pdfs if args.refresh or p.name not in manifest]
    if args.limit:
        todo = todo[: args.limit]

    print(f"{len(pdfs)} PDFs; {len(pdfs) - len(todo)} already in manifest; "
          f"building {len(todo)} "
          f"({'Crossref only' if args.no_llm else args.backend + ' + Crossref'}) ...",
          file=sys.stderr)

    usage = {"in": 0, "out": 0}

    def build_one(p: Path) -> dict:
        # 1. DOI → full Crossref
        text = first_pages_text(p, pages=2)
        doi_m = DOI_RE.search(text)
        if doi_m:
            rec = crossref_full(doi_m.group(0).rstrip(".,;)"), args.mailto, cr_cache)
            if has_minimum_fields(rec):
                return finalize_record(dict(rec), p.name)
        # 2. LLM (content-hash cached)
        if not args.no_llm:
            h = file_hash(p)
            with lock:
                cached = llm_cache.get(h) if h else None
            if cached is None:
                if args.backend == "openai":
                    res = _openai_call(p, args.model, key, args.reasoning, usage, lock)
                else:
                    res = _gemini_call(p, args.model, key)
                if h:
                    with lock:
                        llm_cache[h] = res
            else:
                res = cached
            rec = llm_result_to_record(res)
            if has_minimum_fields(rec):
                return finalize_record(rec, p.name)
        # 3. nothing usable → leave to the filename fallback at render time
        return {}

    done = 0
    quota = ""
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(build_one, p): p for p in todo}
        for fut in as_completed(futs):
            p = futs[fut]
            try:
                rec = fut.result()
            except RuntimeError as e:
                quota = quota or str(e)
                continue
            if rec:
                with lock:
                    manifest[p.name] = rec
            done += 1
            if done % 25 == 0:
                Path(args.out).write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
                Path(args.crossref_cache).write_text(json.dumps(cr_cache))
                Path(args.llm_cache).write_text(json.dumps(llm_cache, ensure_ascii=False))
                print(f"  ...{done}/{len(todo)}", file=sys.stderr)

    Path(args.out).write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    Path(args.crossref_cache).write_text(json.dumps(cr_cache))
    Path(args.llm_cache).write_text(json.dumps(llm_cache, ensure_ascii=False))

    n_cr = sum(1 for r in manifest.values() if r.get("source") == "crossref")
    n_llm = sum(1 for r in manifest.values() if r.get("source") == "llm")
    print(f"\n=== manifest: {args.out} ({len(manifest)} records: "
          f"{n_cr} crossref, {n_llm} llm) ===", file=sys.stderr)
    if usage["in"] or usage["out"]:
        print(f"  tokens this run: {usage['in']:,} in / {usage['out']:,} out",
              file=sys.stderr)
    if quota:
        print(f"\n!! {quota} — cached what completed; re-run to continue.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
