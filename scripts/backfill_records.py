#!/usr/bin/env python3
"""backfill_records.py — build APA manifest records for corpus PDFs missing from the
manifest, each stamped with a publication date. Invoked as ``backfill_dates.py records``.

Routing per missing PDF:
  1. printed DOI     -> Crossref full record + earliest date
  2. arXiv id        -> LLM record (reads the PDF) + arXiv v1 date + arXiv DOI
  3. neither         -> LLM record; date via Crossref bibliographic match (title+author),
                        else year-precision date from the filename year

The record shape matches build_apa_manifest exactly (reuses its mapping/normalize/finalize).
Resumable: per-file results cached in data/state/.new_records_cache.json.
"""
from __future__ import annotations
import base64, json, os, re, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_apa_manifest as bam
import backfill_dates as bd

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
MODEL = "gpt-5-mini"
NEW_CACHE = bd.STATE / ".new_records_cache.json"
DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>)\]]+", re.I)
ARXIV_RE = re.compile(r"arxiv:\s*(\d{4}\.\d{4,5})(v\d+)?", re.I)


def pdf_text(path: Path, pages: int = 4) -> str:
    try:
        return subprocess.run(["pdftotext", "-f", "1", "-l", str(pages), "-layout",
                               str(path), "-"], capture_output=True, timeout=90
                              ).stdout.decode("utf-8", "ignore")
    except Exception:
        return ""


def pdf_pngs(path: Path, pages: int = 2) -> list[bytes]:
    import tempfile
    out = []
    with tempfile.TemporaryDirectory() as td:
        try:
            subprocess.run(["pdftoppm", "-png", "-r", "100", "-f", "1", "-l", str(pages),
                            str(path), f"{td}/p"], capture_output=True, timeout=90)
            for p in sorted(Path(td).glob("p*.png")):
                out.append(p.read_bytes())
        except Exception:
            pass
    return out


def openai_record(path: Path, year_hint: str, author_hint: str, key: str,
                  usage: dict, lock) -> dict | None:
    """Synchronous gpt-5-mini extraction of full bib facts (bam.OPENAI_SCHEMA)."""
    text = pdf_text(path, pages=4)
    if len(text.strip()) >= 200:
        content = [{"type": "text", "text": "DOCUMENT TEXT:\n\n" + text[:9000]}]
    else:
        pngs = pdf_pngs(path)
        if not pngs:
            return None
        content = [{"type": "text", "text": "The document pages are attached as images."}]
        for png in pngs[:2]:
            content.append({"type": "image_url", "image_url": {
                "url": "data:image/png;base64," + base64.b64encode(png).decode()}})
    prompt = bam.PROMPT_DEEP_TEMPLATE.format(author_hint=author_hint or "unknown",
                                             year_hint=year_hint or "unknown")
    body = {"model": MODEL,
            "messages": [{"role": "system", "content": prompt},
                         {"role": "user", "content": content}],
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "biblio", "strict": True, "schema": bam.OPENAI_SCHEMA}},
            "reasoning_effort": "low", "max_completion_tokens": 4000}
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
            try:
                return json.loads(msg["content"])
            except Exception:
                return None
        if r.status_code == 429 and ("insufficient_quota" in r.text.lower()
                                     or "billing" in r.text.lower()):
            raise RuntimeError("QUOTA_EXHAUSTED")
        time.sleep(delay); delay *= 2
    return None


def biblio_match_date(title: str, author: str, cr_cache: bd.Cache) -> dict | None:
    """Crossref bibliographic search -> earliest date + DOI, if a confident match."""
    if len(title) < 12:
        return None
    key = "bib::" + re.sub(r"\s+", " ", title.lower())[:80] + "|" + (author or "").lower()
    if cr_cache.has(key):
        return cr_cache.get(key)
    out = None
    try:
        params = {"query.bibliographic": title, "rows": 3, "mailto": bd.MAILTO}
        if author:
            params["query.author"] = author
        r = requests.get("https://api.crossref.org/works", params=params,
                         headers={"User-Agent": f"aprag-dates/1.0 (mailto:{bd.MAILTO})"},
                         timeout=25)
        if r.status_code == 200:
            for it in r.json().get("message", {}).get("items", []):
                ct = (it.get("title") or [""])[0]
                from rapidfuzz import fuzz
                if ct and fuzz.token_set_ratio(title.lower(), ct.lower()) >= 90:
                    iso, prec = bd.crossref_earliest(it)
                    if iso:
                        out = {"date": iso, "precision": prec, "doi": (it.get("DOI") or "").lower()}
                        break
    except Exception:
        out = None
    cr_cache.put(key, out)
    return out


def cmd_records(args):
    manifest = json.loads(bd.MANIFEST.read_text())
    papers = sorted(p.name for p in bd.PAPERS.iterdir() if p.suffix.lower() == ".pdf")
    missing = [n for n in papers if n not in manifest]
    if args.limit:
        missing = missing[:args.limit]
    print(f"records: {len(missing)} corpus PDFs missing from the manifest", flush=True)

    key = os.environ.get("OPENAI_API_KEY", "")
    cache = json.loads(NEW_CACHE.read_text()) if NEW_CACHE.exists() else {}
    cr_cache = bd.Cache(bd.CR_CACHE)
    ax_cache = bd.Cache(bd.ARXIV_CACHE)
    usage = {"in": 0, "out": 0}
    lock = threading.Lock()

    counts = {"crossref": 0, "arxiv": 0, "llm": 0, "llm_year": 0, "skip_noncitable": 0, "fail": 0}

    def build(name: str) -> dict | None:
        if name in cache:
            return cache[name]
        path = bd.PAPERS / name
        text = pdf_text(path, pages=3)
        doi_m = DOI_RE.search(text)
        ax_m = ARXIV_RE.search(text)
        m = bam._FILENAME_RE.match(name) if hasattr(bam, "_FILENAME_RE") else None
        year_hint = bam._filename_year(name) or "unknown"
        author_hint = bam._filename_author(name) or "unknown"

        rec = None; src = None
        # 1. DOI -> Crossref full record
        if doi_m:
            doi = doi_m.group(0).rstrip(".,;)").lower()
            # eLife (and similar) print a component DOI like 10.7554/elife.11305.001 that
            # resolves to a sub-part ("Abstract"); strip a trailing .00N component suffix.
            doi = re.sub(r"\.\d{3}$", "", doi)
            msg = bd.fetch_crossref_msg(doi)
            # A truncated DOI (e.g. PNAS "10.1073/pnas." split across a line) resolves to the
            # JOURNAL record, which has no authors. Discard author-less stubs -> fall to LLM.
            if msg and not (msg.get("author") or msg.get("editor")):
                msg = None
            if msg:
                rec = bam.crossref_to_record(msg, doi)
                iso, prec = bd.crossref_earliest(msg)
                if not iso:
                    c_iso, c_prec, _ = bd.crossref_created_year(msg)
                    iso, prec, dsrc = c_iso, c_prec, "crossref_created"
                else:
                    dsrc = "crossref"
                rec["_date"] = (iso, prec, dsrc)
                src = "crossref"
        # 2/3. LLM extraction
        if rec is None:
            res = openai_record(path, year_hint, author_hint, key, usage, lock)
            if res is None:
                return {"_fail": "llm-none"}
            if not res.get("is_citable_work"):
                return {"_noncitable": res.get("type", "")}
            rec = bam.llm_result_to_record(res)
            if rec is None:
                return {"_noncitable": "no-min-fields"}
            src = "llm"
            # date: arxiv -> bibliographic match -> year-only
            aid = ax_m.group(1) if ax_m else ""
            date_set = False
            if aid:
                info = bd.fetch_arxiv(aid, ax_cache)
                if info:
                    rec["_date"] = (info["date"], "day", "arxiv")
                    if not rec.get("doi"):
                        rec["doi"] = info["doi"]
                    date_set = True; src = "arxiv"
            if not date_set:
                title = rec.get("title", "")
                au = rec.get("authors") or rec.get("editors") or []
                asurn = au[0].get("family", "") if au else ""
                info = biblio_match_date(title, asurn, cr_cache)
                if info:
                    rec["_date"] = (info["date"], info["precision"], "crossref")
                    if not rec.get("doi") and info.get("doi"):
                        rec["doi"] = info["doi"]
                    date_set = True

        rec = bam.finalize_record(rec, name)
        rec = bam.normalize_record(rec)
        if not bam.has_minimum_fields(rec):
            return {"_noncitable": "no-min-fields"}
        rec["source"] = rec.get("source") or src
        return {"_rec": rec}

    results = {}
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        from concurrent.futures import as_completed
        futs = {ex.submit(build, n): n for n in missing if n not in cache}
        done = 0
        for fut in as_completed(futs):
            n = futs[fut]
            try:
                out = fut.result()
            except RuntimeError as e:
                print(f"  ABORT: {e}", flush=True); break
            cache[n] = out
            done += 1
            if done % 25 == 0:
                NEW_CACHE.write_text(json.dumps(cache, ensure_ascii=False))
                cr_cache.flush()
                print(f"  {done}/{len(missing)} built  (~${(usage['in']*0.25+usage['out']*2)/1e6:.2f})",
                      flush=True)
    NEW_CACHE.write_text(json.dumps(cache, ensure_ascii=False))
    cr_cache.flush(); ax_cache.flush()

    # merge into manifest
    added = 0
    for n in missing:
        out = cache.get(n) or {}
        if "_rec" in out:
            rec = out["_rec"]
            if "_date" in rec:
                iso, prec, dsrc = rec.pop("_date")
                if iso:
                    bd.stamp_date(rec, iso, prec, dsrc)
                    counts[dsrc if dsrc in counts else "crossref"] += 1
            if not rec.get("date"):
                bd.year_only_fallback(rec) and counts.__setitem__("llm_year", counts["llm_year"]+1)
            manifest[n] = rec
            added += 1
        elif "_noncitable" in out:
            counts["skip_noncitable"] += 1
        elif "_fail" in out:
            counts["fail"] += 1

    bd.MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"\nrecords done: added {added} to manifest", flush=True)
    print(f"  by source: {counts}")
    print(f"  tokens: {usage['in']} in / {usage['out']} out "
          f"(~${(usage['in']*0.25+usage['out']*2)/1e6:.2f})")
    print(f"  non-citable skipped: {counts['skip_noncitable']}, failures: {counts['fail']}")
    return 0
