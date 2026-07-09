#!/usr/bin/env python3
"""fix_arxiv_journals.py — normalize arXiv records' venue + subject metadata.

The manifest's arXiv records carry junk container_titles harvested from PDFs
("arXiv preprint arXiv:2603.10771", "arXiv:2601.11432v1 [cs.CL]", bare "arXiv").
This script uses the arXiv API (export.arxiv.org) to normalize them:

  container_title  ->  "arXiv <primary_category>"   e.g. "arXiv cs.CL"
                       (subcategory-level venues; journal filtering is substring-based,
                       so "arXiv cs" matches every cs.* paper)
  subjects         +=  every category + its top-level archive   e.g. cs.CL, cs, stat.ML, stat

Rules:
  * container_title is rewritten ONLY when the current value is arXiv-junk (starts
    with "arxiv", case-insensitive) — real venues (ICML/ICLR proceedings with an
    arXiv DOI) are never overwritten, though their subjects are still enriched.
  * Records with no extractable arXiv id (bare "arXiv", no DOI): container_title is
    normalized to plain "arXiv"; no API call.
  * titles/authors/dates are never touched.

Dry-run by default; --apply writes the manifest in place. API results cached under
data/state/ so reruns are free.

    python scripts/fix_arxiv_journals.py [--apply]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
MANIFEST = REPO / "data" / "papers_metadata.json"
CACHE = REPO / "data" / "state" / ".arxiv_cat_cache.json"

API = "http://export.arxiv.org/api/query"
BATCH = 50          # ids per API request
SLEEP = 3           # seconds between requests (arXiv API etiquette)

ATOM = "{http://www.w3.org/2005/Atom}"
ARX = "{http://arxiv.org/schemas/atom}"

# new-style 2 (2601.11432, optional vN) or old-style (quant-ph/9603026, cs/0501001)
ID_RE = re.compile(r"\b(\d{4}\.\d{4,5})(?:v\d+)?\b|\b([a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?\b")
ARXIV_CT_RE = re.compile(r"^\s*arxiv\b", re.I)
ARXIV_DOI_RE = re.compile(r"^10\.48550/arxiv\.(.+)$", re.I)


def extract_id(record: dict) -> str | None:
    """The record's arXiv id, from its DOI (10.48550/arXiv.<id>) or from the junk
    container_title string. Version suffix stripped."""
    doi = (record.get("doi") or "").strip()
    m = ARXIV_DOI_RE.match(doi)
    if m:
        return re.sub(r"v\d+$", "", m.group(1).strip())
    m = ID_RE.search(record.get("container_title") or "")
    if m:
        return m.group(1) or m.group(2)
    return None


def is_arxiv_record(record: dict) -> bool:
    ct = record.get("container_title") or ""
    doi = (record.get("doi") or "").lower()
    return bool(ARXIV_CT_RE.search(ct) or doi.startswith("10.48550/"))


def fetch_categories(ids: list[str]) -> dict[str, dict]:
    """arXiv API lookup: id -> {"primary": "cs.CL", "categories": [...]}. Batched."""
    out: dict[str, dict] = {}
    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        try:
            r = requests.get(API, params={"id_list": ",".join(chunk),
                                          "max_results": len(chunk)}, timeout=60)
            r.raise_for_status()
        except requests.RequestException as exc:
            print(f"  batch {i // BATCH + 1} failed: {exc}", flush=True)
            continue
        root = ET.fromstring(r.text)
        for entry in root.findall(f"{ATOM}entry"):
            eid = (entry.findtext(f"{ATOM}id") or "")
            m = ID_RE.search(eid)
            if not m:
                continue
            key = m.group(1) or m.group(2)
            primary = entry.find(f"{ARX}primary_category")
            cats = [c.get("term") for c in entry.findall(f"{ATOM}category") if c.get("term")]
            # arXiv sometimes tags non-arXiv taxonomies (e.g. ACM classes) — keep only
            # things shaped like arXiv categories (archive or archive.Sub).
            cats = [c for c in cats if re.fullmatch(r"[a-z-]+(\.[A-Za-z-]{2,})?", c)]
            out[key] = {
                "primary": (primary.get("term") if primary is not None else None) or
                           (cats[0] if cats else None),
                "categories": cats,
            }
        print(f"  batch {i // BATCH + 1}: {len(out)} ids resolved so far", flush=True)
        if i + BATCH < len(ids):
            time.sleep(SLEEP)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the manifest in place")
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    targets = {fn: r for fn, r in manifest.items()
               if isinstance(r, dict) and is_arxiv_record(r)}
    with_id = {fn: extract_id(r) for fn, r in targets.items()}
    ids = sorted({i for i in with_id.values() if i})
    print(f"{len(targets)} arXiv-ish records, {len(ids)} distinct arXiv ids\n", flush=True)

    cache: dict = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    missing = [i for i in ids if i not in cache]
    if missing:
        print(f"querying arXiv API for {len(missing)} ids…", flush=True)
        cache.update(fetch_categories(missing))
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(json.dumps(cache, indent=1))

    rewrote_ct = enriched = normalized = unresolved = 0
    for fn, rec in sorted(targets.items()):
        ct = rec.get("container_title") or ""
        junk_ct = not ct.strip() or bool(ARXIV_CT_RE.search(ct))
        aid = with_id[fn]
        info = cache.get(aid) if aid else None

        if info and info.get("primary"):
            primary, cats = info["primary"], info.get("categories") or []
            new_subjects = list(rec.get("subjects") or [])
            for c in dict.fromkeys(cats + [primary]):
                for s in (c, c.split(".")[0]):
                    if s and s not in new_subjects:
                        new_subjects.append(s)
            changes = []
            if junk_ct and ct != f"arXiv {primary}":
                changes.append(f"journal {ct!r} -> 'arXiv {primary}'")
                rec["container_title"] = f"arXiv {primary}"
                rewrote_ct += 1
            if new_subjects != (rec.get("subjects") or []):
                added = [s for s in new_subjects if s not in (rec.get("subjects") or [])]
                changes.append(f"subjects += {added}")
                rec["subjects"] = new_subjects
                enriched += 1
            if changes:
                print(f"FIX   {fn}: " + "; ".join(changes), flush=True)
        elif junk_ct and ct.strip() != "arXiv":
            print(f"PLAIN {fn}: journal {ct!r} -> 'arXiv' (no id/categories)", flush=True)
            rec["container_title"] = "arXiv"
            normalized += 1
        elif aid and not info:
            print(f"MISS  {fn}: id {aid} not resolved by the API", flush=True)
            unresolved += 1

    print(f"\nvenue rewritten: {rewrote_ct} | subjects enriched: {enriched} | "
          f"normalized to plain 'arXiv': {normalized} | unresolved: {unresolved}", flush=True)
    if args.apply:
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                            encoding="utf-8")
        print(f"wrote {MANIFEST}", flush=True)
    else:
        print("dry run — rerun with --apply to write", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
