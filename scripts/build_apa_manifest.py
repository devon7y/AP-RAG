#!/usr/bin/env python3
"""Build ``papers_metadata.json`` — full APA7 bibliographic records keyed by the
canonical PDF filename — using the OpenAI **Batch API** (50% cheaper) for the LLM step.

This is the data behind the APA7 citations + metadata-filtered search the query server
exposes (see ``apa_citations.py`` / ``aprag_search.py`` / ``query_server.py``). For every
PDF in a corpus directory (named ``Author_Year.pdf`` / ``Author1_Author2_Year.pdf`` /
``Author1_Etal_Year.pdf``):

  1. **Year comes from the filename** — it is canonical and authoritative. Crossref/LLM
     never *set* the year; they only let us **flag** a disagreement (``year_flag``).
  2. **DOI present** → fetch the **full** Crossref record synchronously (free): all
     authors, container, volume, issue, pages, type, subjects, abstract, affiliations.
  3. **No DOI / Crossref miss** → an LLM call via the **Batch API** reads the first pages
     and returns the bibliographic fields *and verifies the filename year*.

Three phases (like ``batch_rename.py``):

    python3 build_apa_manifest.py submit  [DIR]   # Crossref now + submit the LLM batch
    python3 build_apa_manifest.py status  [DIR]   # poll the batch(es)
    python3 build_apa_manifest.py collect [DIR]   # merge batch results → papers_metadata.json

State (batch ids + custom_id→filename map) is saved to ``.apa_manifest_batch[_TAG].json``;
the Crossref portion is written to the manifest at submit time, the LLM portion at collect.
Re-running ``submit`` skips papers already in the manifest unless ``--refresh``.

Default DIR is /Users/devon7y/Papers. Crossref + the Batch API need internet (run on a
machine with outbound access; never a no-internet HPC compute node).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Only stdlib at import time so the pure transforms below are unit-testable without
# `requests`/poppler. Heavy helpers are imported lazily inside the I/O functions.

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>)\]]+", re.IGNORECASE)
_FILENAME_RE = re.compile(r"^.*_(?P<year>\d{4})(?P<dis>[a-z])?\.pdf$", re.IGNORECASE)

OPENAI_FILES_URL = "https://api.openai.com/v1/files"
OPENAI_BATCHES_URL = "https://api.openai.com/v1/batches"
MODEL = "gpt-5-mini"
MAX_BATCH_BYTES = 190_000_000      # OpenAI batch input file limit is 200 MB
MAX_BATCH_REQUESTS = 40_000        # OpenAI batch request limit is 50k

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


def _filename_year(name: str) -> str:
    m = _FILENAME_RE.match(name)
    return m.group("year") if m else ""


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
    """Map a Crossref ``message`` object to our manifest record schema. The ``year``
    here is Crossref's own (used only to verify the filename year in finalize_record)."""
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
        "keywords": [],  # Crossref has no author keywords; the LLM fills these
        "abstract": _strip_jats(msg.get("abstract", "")),
        "subjects": _str_list(msg.get("subject")),
        "affiliations": _affiliations_from_authors(msg.get("author")),
        "source": "crossref",
    }


def llm_result_to_record(res: dict) -> dict | None:
    """Map an LLM extraction result to our record schema (None if not citable).

    The LLM no longer supplies the year — it only reports ``year_on_page`` and whether
    it ``year_matches_filename``; the authoritative year is stamped from the filename in
    finalize_record."""
    if not res or res.get("_error"):
        return None
    if res.get("is_citable_work") is False:
        return None
    return {
        "type": (res.get("type") or "other").strip().lower(),
        "authors": _people(res.get("authors")),
        "editors": _people(res.get("editors")),
        "year_on_page": str(res.get("year_on_page") or "").strip(),
        "year_matches_filename": res.get("year_matches_filename"),
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
    """Stamp the authoritative ``year`` + ``disambig`` from the canonical filename, and
    flag any disagreement with the year Crossref/the LLM saw (``year_flag``)."""
    m = _FILENAME_RE.match(filename)
    fy = m.group("year") if m else ""
    record["disambig"] = (m.group("dis") if m else "") or ""
    document_year = str(record.get("year") or record.get("year_on_page") or "").strip()[:4]
    if fy:
        record["year"] = fy
        if document_year and document_year != fy:
            record["year_flag"] = f"filename={fy}; document={document_year}"
    elif document_year:
        record["year"] = document_year  # no year in filename → fall back to the document
    return record


def has_minimum_fields(record: dict | None) -> bool:
    """Usable if it has at least one author/editor and a year (year is from the filename)."""
    if not record:
        return False
    if not (record.get("authors") or record.get("editors")):
        return False
    return bool(record.get("year"))


# ── LLM extraction schema + prompt (year is VERIFIED, not extracted) ──────────

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
        "year_on_page": {"type": "string"},
        "year_matches_filename": {"type": "boolean"},
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
    "required": ["is_citable_work", "type", "title", "authors", "editors",
                 "year_on_page", "year_matches_filename", "container_title", "volume",
                 "issue", "pages", "publisher", "doi", "keywords", "abstract",
                 "subjects", "affiliations", "confidence"],
}

PROMPT_TEMPLATE = """You are cataloguing a scholarly PDF library. From the document \
content below, extract the bibliographic facts needed to build a complete APA-7 citation. \
Rules:

- authors: EVERY author of THIS work, in order, each as {{family, given}}. `given` is \
the full given name(s) as printed (e.g. "Chris" or "Geoffrey B."); do not abbreviate to \
initials. For an edited volume with no authors, leave authors empty and fill editors.
- editors: editors of the containing book (for a book chapter) or of an edited volume; \
else empty.
- title: the work's own title (article or chapter or book title).
- container_title: the JOURNAL name for an article, or the BOOK title for a chapter. \
Empty for a whole book.
- volume, issue, pages: as printed ("128", "3", "97-123"); "" if absent.
- publisher: for books/chapters/reports; "" for journal articles.
- doi: the DOI of THIS work if printed; else "".
- year_on_page: the 4-digit publication year of THIS work/edition as printed on the \
document (copyright page/masthead/journal info); "" if you cannot see it.
- year_matches_filename: the filename indicates the year is {year_hint}. Set TRUE if the \
document's publication year matches {year_hint}, FALSE if it clearly differs. If {year_hint} \
is "unknown" or you cannot tell, set TRUE.
- keywords: the author-supplied keywords/index terms if listed; else a few (3-8) topical \
terms you infer from the title/abstract. Lowercase noun phrases.
- abstract: the work's abstract verbatim if present on these pages; else "".
- subjects: 1-4 broad field/discipline labels (e.g. "Cognitive Psychology", "Linguistics").
- affiliations: the distinct institutions/universities of the authors as printed; else [].
- is_citable_work: TRUE for any single scholarly work (article, preprint, thesis, report, \
book chapter, or whole book). FALSE for a table of contents, index, bibliography, \
questionnaire, manual, syllabus, cover sheet, or supplementary file.
- confidence: high/medium/low for your overall extraction.

Return JSON matching the schema."""


# ── PDF helpers ────────────────────────────────────────────────────────────────


def _first_pages_text(path: Path, pages: int = 2) -> str:
    """First-pages text via poppler's pdftotext (layout-preserving)."""
    try:
        out = subprocess.run(
            ["pdftotext", "-f", "1", "-l", str(pages), "-layout", str(path), "-"],
            capture_output=True, timeout=60)
        return out.stdout.decode("utf-8", "ignore")
    except Exception:
        return ""


def _jpegs(path: Path, pages: int = 2, dpi: int = 100) -> list[bytes]:
    """Rasterize the first pages to compact JPEGs (for scanned PDFs in vision mode)."""
    out: list[bytes] = []
    with tempfile.TemporaryDirectory() as td:
        stem = os.path.join(td, "p")
        try:
            subprocess.run(
                ["pdftoppm", "-jpeg", "-jpegopt", "quality=50", "-r", str(dpi),
                 "-f", "1", "-l", str(pages), str(path), stem],
                capture_output=True, timeout=120, check=True,
            )
        except Exception:
            return out
        for f in sorted(Path(td).glob("p*.jpg")):
            out.append(f.read_bytes())
    return out


def _build_request(custom_id: str, path: Path, text: str) -> dict | None:
    """Build one Batch-API chat-completion request (text, else page images)."""
    year_hint = _filename_year(path.name) or "unknown"
    prompt = PROMPT_TEMPLATE.format(year_hint=year_hint)
    if len(text.strip()) >= 200:
        content: list = [{"type": "text", "text": "DOCUMENT TEXT:\n\n" + text[:9000]}]
    else:
        imgs = _jpegs(path)
        if not imgs:
            return None
        content = [{"type": "text", "text": "The document pages are attached as images."}]
        for im in imgs[:2]:
            b64 = base64.b64encode(im).decode()
            content.append({"type": "image_url",
                            "image_url": {"url": "data:image/jpeg;base64," + b64}})
    body = {
        "model": MODEL,
        "messages": [{"role": "system", "content": prompt},
                     {"role": "user", "content": content}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "apa_biblio", "strict": True,
                                            "schema": OPENAI_SCHEMA}},
        "reasoning_effort": "low",
        "max_completion_tokens": 4000,
    }
    return {"custom_id": custom_id, "method": "POST",
            "url": "/v1/chat/completions", "body": body}


def crossref_full(doi: str, mailto: str, cache: dict, lock: "threading.Lock") -> dict | None:
    """Fetch + cache the full Crossref record for a DOI, mapped to our schema."""
    import requests
    doi = doi.rstrip(".,;").lower()
    with lock:
        if doi in cache:
            return cache[doi]
    try:
        r = requests.get(f"https://api.crossref.org/works/{doi}",
                         params={"mailto": mailto},
                         headers={"User-Agent": f"aprag-apa/1.0 (mailto:{mailto})"},
                         timeout=25)
        rec = crossref_to_record(r.json().get("message", {}), doi) if r.status_code == 200 else None
    except Exception:
        rec = None
    with lock:
        cache[doi] = rec
    return rec


# ── File / state helpers ───────────────────────────────────────────────────────


def _load(path: str) -> dict:
    p = Path(path)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            return {}
    return {}


def _save(path: str, obj) -> None:
    Path(path).write_text(json.dumps(obj, indent=1, ensure_ascii=False))


def _state_path(tag: str | None) -> Path:
    return Path(f".apa_manifest_batch{('_' + tag) if tag else ''}.json")


# ── submit ───────────────────────────────────────────────────────────────────


def submit(args) -> int:
    import requests

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        print("error: OPENAI_API_KEY not set", file=sys.stderr)
        return 2
    headers = {"Authorization": f"Bearer {key}"}
    root = Path(args.directory).expanduser()
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 2

    manifest = _load(args.out)
    cr_cache = _load(args.crossref_cache)
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
          f"processing {len(todo)} ...", file=sys.stderr)

    # Phase A+B: read first pages, resolve DOIs via Crossref (free), queue the rest.
    cr_hits = 0

    def process(p: Path):
        text = _first_pages_text(p, pages=2)
        doi_m = DOI_RE.search(text)
        if doi_m:
            rec = crossref_full(doi_m.group(0).rstrip(".,;)"), args.mailto, cr_cache, lock)
            if rec:
                rec = finalize_record(dict(rec), p.name)
                if has_minimum_fields(rec):
                    return ("crossref", p.name, rec)
        return ("llm", p.name, text, p)

    pending: list[tuple] = []
    done = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for fut in as_completed([ex.submit(process, p) for p in todo]):
            r = fut.result()
            with lock:
                if r[0] == "crossref":
                    manifest[r[1]] = r[2]
                    cr_hits += 1
                else:
                    pending.append((r[1], r[3], r[2]))  # (name, path, text)
                done += 1
                if done % 250 == 0:
                    print(f"  ...scanned {done}/{len(todo)} (crossref {cr_hits})",
                          file=sys.stderr)
    _save(args.out, manifest)
    _save(args.crossref_cache, cr_cache)
    print(f"Crossref resolved {cr_hits}; {len(pending)} need the LLM batch.", file=sys.stderr)

    if not pending:
        print("nothing to batch — manifest is complete from Crossref.", file=sys.stderr)
        _state_path(args.tag).write_text(json.dumps(
            {"batches": [], "map": {}, "dir": str(root), "out": args.out}))
        return 0

    # Phase C: build batch JSONL request lines, chunk by size/count, upload + create.
    cmap: dict[str, str] = {}
    lines: list[str] = []
    for i, (name, path, text) in enumerate(pending):
        cid = f"m{i:06d}"
        req = _build_request(cid, path, text)
        if req is None:
            continue  # unreadable scan; left to the filename fallback at render time
        cmap[cid] = name
        lines.append(json.dumps(req))

    batches: list[str] = []
    chunk: list[str] = []
    chunk_bytes = 0

    def flush(chunk_lines: list[str]) -> None:
        if not chunk_lines:
            return
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as tf:
            tf.write("\n".join(chunk_lines) + "\n")
            tmp = tf.name
        try:
            with open(tmp, "rb") as fh:
                up = requests.post(OPENAI_FILES_URL, headers=headers,
                                   files={"file": (Path(tmp).name, fh)},
                                   data={"purpose": "batch"}, timeout=600)
            up.raise_for_status()
            fid = up.json()["id"]
            b = requests.post(OPENAI_BATCHES_URL, headers=headers,
                              json={"input_file_id": fid,
                                    "endpoint": "/v1/chat/completions",
                                    "completion_window": "24h"}, timeout=60)
            b.raise_for_status()
            batches.append(b.json()["id"])
        finally:
            os.unlink(tmp)

    for line in lines:
        ln = len(line) + 1
        if chunk and (chunk_bytes + ln > MAX_BATCH_BYTES or len(chunk) >= MAX_BATCH_REQUESTS):
            flush(chunk)
            chunk, chunk_bytes = [], 0
        chunk.append(line)
        chunk_bytes += ln
    flush(chunk)

    _state_path(args.tag).write_text(json.dumps(
        {"batches": batches, "map": cmap, "dir": str(root), "out": args.out}))
    print(f"submitted {len(lines)} requests across {len(batches)} batch(es): "
          f"{', '.join(batches)}")
    print(f"check with:  python3 {Path(__file__).name} status"
          + (f" --tag {args.tag}" if args.tag else ""))
    return 0


# ── status ───────────────────────────────────────────────────────────────────


def _batch_info(batch_id: str, headers: dict) -> dict:
    import requests
    return requests.get(f"{OPENAI_BATCHES_URL}/{batch_id}", headers=headers, timeout=30).json()


def status(args) -> int:
    key = os.environ.get("OPENAI_API_KEY")
    headers = {"Authorization": f"Bearer {key}"}
    st = _load(str(_state_path(args.tag)))
    if not st.get("batches"):
        print("no batches in state (Crossref-only run, or not submitted yet).")
        return 0
    all_done = True
    for bid in st["batches"]:
        j = _batch_info(bid, headers)
        rc = j.get("request_counts", {})
        print(f"{bid}  {j.get('status')}  "
              f"completed={rc.get('completed')}/{rc.get('total')} failed={rc.get('failed')}")
        if j.get("status") != "completed":
            all_done = False
    print("ALL COMPLETE — run `collect`." if all_done else "not all complete yet.")
    return 0


# ── collect ──────────────────────────────────────────────────────────────────


def collect(args) -> int:
    import requests
    key = os.environ.get("OPENAI_API_KEY")
    headers = {"Authorization": f"Bearer {key}"}
    st = _load(str(_state_path(args.tag)))
    cmap = st.get("map", {})
    out_path = st.get("out", args.out)
    manifest = _load(out_path)

    if not st.get("batches"):
        print("no batches to collect (Crossref-only run).")
        return 0

    usage = {"in": 0, "out": 0}
    n_llm = 0
    flags = 0
    for bid in st["batches"]:
        j = _batch_info(bid, headers)
        if j.get("status") != "completed":
            print(f"{bid} is {j.get('status')}, not completed — aborting.", file=sys.stderr)
            return 1
        out = requests.get(f"{OPENAI_FILES_URL}/{j['output_file_id']}/content",
                           headers=headers, timeout=600).text
        for line in out.splitlines():
            if not line.strip():
                continue
            o = json.loads(line)
            name = cmap.get(o["custom_id"])
            if not name:
                continue
            try:
                body = o["response"]["body"]
                u = body.get("usage", {})
                usage["in"] += u.get("prompt_tokens", 0)
                usage["out"] += u.get("completion_tokens", 0)
                res = json.loads(body["choices"][0]["message"]["content"])
            except Exception:
                res = None
            rec = llm_result_to_record(res)
            if rec:
                rec = finalize_record(rec, name)
                if has_minimum_fields(rec):
                    manifest[name] = rec
                    n_llm += 1
                    if rec.get("year_flag"):
                        flags += 1

    _save(out_path, manifest)
    cost = (usage["in"] / 1e6 * 0.25 + usage["out"] / 1e6 * 2.0) * 0.5  # 50% batch discount
    n_cr = sum(1 for r in manifest.values() if r.get("source") == "crossref")
    print(f"\n=== manifest: {out_path} ({len(manifest)} records: {n_cr} crossref, "
          f"{n_llm} llm this collect) ===")
    print(f"  year mismatches flagged (year_flag): {flags}")
    print(f"  batch tokens: {usage['in']:,} in / {usage['out']:,} out  (~${cost:.2f} w/ batch discount)")
    return 0


# ── Main ──────────────────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["submit", "status", "collect"])
    ap.add_argument("directory", nargs="?", default="/Users/devon7y/Papers")
    ap.add_argument("--out", default="papers_metadata.json")
    ap.add_argument("--files", nargs="*", help="only these basenames")
    ap.add_argument("--jobs", type=int, default=12)
    ap.add_argument("--limit", type=int, default=0, help="cap number of papers processed")
    ap.add_argument("--refresh", action="store_true",
                    help="rebuild even papers already present in the output manifest")
    ap.add_argument("--mailto", default=os.environ.get("CROSSREF_MAILTO", "devon7y@gmail.com"))
    ap.add_argument("--crossref-cache", default=".crossref_full_cache.json")
    ap.add_argument("--tag", help="namespace for the batch state file (for a 2nd pass)")
    args = ap.parse_args()

    if args.cmd == "submit":
        return submit(args)
    if args.cmd == "status":
        return status(args)
    return collect(args)


if __name__ == "__main__":
    raise SystemExit(main())
