"""
fetch_openalex.py — the citation layer for the Research Trends dashboard.

The manifest carries the citation *of* each paper (authors/year/title/journal/DOI —
what apa_citations.py renders). It carries nothing about how often each paper *has
been cited*, or what each paper cites: build_apa_manifest.py deliberately ignores
reference sections when extracting, and the chunker strips them (CHUNK_EXCLUDE_REFS).
This script fills that gap from OpenAlex, keyed on the manifest's DOIs.

Three things come back that we cannot derive locally:

  cited_by_count    impact per paper
  counts_by_year    *when* those citations arrived — what makes sleeping beauties
                    (old papers cited heavily only recently) detectable at all
  referenced_works  each paper's reference list; intersected with the corpus it
                    yields an internal citation network — who builds on whom inside
                    the library

Plus a per-term year histogram over OpenAlex's whole index, which is the world
baseline the dashboard needs to separate a real trend from a collection artifact.
That correction matters here: collected output peaks in the 2000s and falls after, so
the corpus's own curve understates anything recent.

Age-fairness: raw citation counts mostly measure how long a paper has existed. Every
per-paper number is therefore also reported as a within-year percentile against the
rest of the corpus published that year, and topic-level impact uses the percentile.

Usage
-----
    python scripts/fetch_openalex.py                     # full run
    python scripts/fetch_openalex.py --limit 500         # smoke test
    python scripts/fetch_openalex.py --skip-baseline     # citations only

Writes:
    data/openalex_raw.json                 per-paper cache (re-runs are incremental)
    web/public/data/citations.json         the dashboard payload (small, browser-served)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MANIFEST = ROOT / "data" / "papers_metadata.json"
RAW_CACHE = ROOT / "data" / "openalex_raw.json"
BASELINE_CACHE = ROOT / "data" / "openalex_baseline.json"
OUT = ROOT / "web" / "public" / "data" / "citations.json"

API = "https://api.openalex.org/works"
# The polite pool: identifying yourself gets a documented rate limit and priority
# over the anonymous pool. OpenAlex asks for this rather than a key.
MAILTO = os.environ.get("OPENALEX_MAILTO", "devon7y@gmail.com")

DOI_BATCH = 50          # OpenAlex's cap for an OR filter
REQUEST_PAUSE = 0.11    # ~9 req/s, inside the 10 req/s polite-pool limit
MAX_RETRIES = 4

BASELINE_TERMS = 90     # terms to fetch a world curve for (one request each)
BASELINE_MIN_YEAR = 1960

SLEEPING_MIN_AGE = 15   # years old before a paper can qualify
SLEEPING_MIN_CITES = 40
SLEEPING_RECENT_SPAN = 5
SLEEPING_MIN_SHARE = 0.35


def log(msg: str) -> None:
    print(msg, flush=True)


def get_json(url: str) -> dict | None:
    """GET with retry/backoff. Returns None when the resource is genuinely absent."""
    for attempt in range(MAX_RETRIES):
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": f"AP-RAG trends ({MAILTO})",
                              "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if exc.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES - 1:
                wait = 2 ** attempt
                log(f"    HTTP {exc.code}; retrying in {wait}s")
                time.sleep(wait)
                continue
            log(f"    HTTP {exc.code} — giving up on this request")
            return None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt < MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
                continue
            log(f"    request failed: {exc}")
            return None
    return None


def normalize_doi(raw: str) -> str:
    doi = str(raw or "").strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
    return doi.strip()


def record_year(record: dict) -> int | None:
    for key in ("year", "issued_year"):
        value = record.get(key)
        if value in (None, ""):
            continue
        try:
            year = int(str(value)[:4])
        except (TypeError, ValueError):
            continue
        if 1800 <= year <= 2100:
            return year
    return None


# ── Fetch ─────────────────────────────────────────────────────────────────────

SELECT = "id,doi,publication_year,cited_by_count,counts_by_year,referenced_works,title"


def fetch_batch(batch: list[str], cache: dict) -> tuple[bool, int]:
    """Fetch one OR-filtered batch. Returns (request succeeded, works matched).

    A single malformed DOI poisons the whole filter and OpenAlex answers 400 for the
    batch, so a failed batch is split and retried down to single DOIs. This isolates
    the bad one instead of losing its 49 well-formed neighbours.
    """
    params = urllib.parse.urlencode({
        "filter": "doi:" + "|".join(batch),
        "select": SELECT,
        "per-page": max(len(batch), 1),
        "mailto": MAILTO,
    })
    payload = get_json(f"{API}?{params}")

    if payload is None:
        if len(batch) == 1:
            return False, 0
        half = len(batch) // 2
        time.sleep(REQUEST_PAUSE)
        ok_a, n_a = fetch_batch(batch[:half], cache)
        time.sleep(REQUEST_PAUSE)
        ok_b, n_b = fetch_batch(batch[half:], cache)
        return (ok_a and ok_b), n_a + n_b

    matched = 0
    for work in payload.get("results") or []:
        doi = normalize_doi(work.get("doi") or "")
        if not doi:
            continue
        matched += 1
        cache[doi] = {
            "id": work.get("id"),
            "year": work.get("publication_year"),
            "cited": work.get("cited_by_count") or 0,
            "byYear": {str(c["year"]): c["cited_by_count"]
                       for c in (work.get("counts_by_year") or [])},
            "refs": work.get("referenced_works") or [],
        }
    # Negative-cache the misses so a re-run does not retry every DOI OpenAlex simply
    # does not index — but ONLY when the request itself succeeded. Blacklisting on a
    # transient failure would silently drop those papers from every future run.
    for doi in batch:
        cache.setdefault(doi, None)
    return True, matched


def fetch_works(dois: list[str], cache: dict) -> dict:
    """Fetch every DOI not already cached, 50 per request."""
    pending = [d for d in dois if d not in cache]
    if not pending:
        log(f"  all {len(dois)} DOIs already cached")
        return cache

    log(f"  {len(pending)} DOIs to fetch ({len(dois) - len(pending)} cached), "
        f"{math.ceil(len(pending) / DOI_BATCH)} requests")
    failed = 0
    for start in range(0, len(pending), DOI_BATCH):
        batch = pending[start:start + DOI_BATCH]
        ok, matched = fetch_batch(batch, cache)
        if not ok:
            failed += 1
        done = min(start + DOI_BATCH, len(pending))
        if (start // DOI_BATCH) % 10 == 0 or done == len(pending):
            log(f"    {done}/{len(pending)} — {matched}/{len(batch)} matched in last batch")
        time.sleep(REQUEST_PAUSE)
    if failed:
        log(f"  {failed} batches failed outright — re-run to retry them "
            "(failures are not cached)")
    return cache


def fetch_baseline(terms: list[str]) -> dict:
    """World-wide papers-per-year for each term, from OpenAlex's whole index.

    One request per term: a title/abstract search grouped by publication year. This
    is the denominator the corpus cannot supply — it says whether a rise in the
    library reflects a rise in the field.
    """
    out: dict[str, dict[str, int]] = {}
    log(f"  {len(terms)} baseline requests")
    for index, term in enumerate(terms):
        params = urllib.parse.urlencode({
            "filter": f"title_and_abstract.search:{term}",
            "group_by": "publication_year",
            "per-page": 200,
            "mailto": MAILTO,
        })
        payload = get_json(f"{API}?{params}")
        if payload:
            curve = {}
            for group in payload.get("group_by") or []:
                try:
                    year = int(group.get("key"))
                except (TypeError, ValueError):
                    continue
                if year >= BASELINE_MIN_YEAR:
                    curve[str(year)] = group.get("count", 0)
            if curve:
                out[term] = dict(sorted(curve.items()))
        if index % 20 == 0 or index == len(terms) - 1:
            log(f"    {index + 1}/{len(terms)}")
        time.sleep(REQUEST_PAUSE)
    return out


# ── Aggregation ───────────────────────────────────────────────────────────────

def percentile_by_year(papers: list[dict]) -> None:
    """Stamp each paper with its within-year citation percentile.

    A 1998 paper with 200 citations and a 2023 paper with 20 are not comparable on
    raw counts — the older one has had 25 more years to accumulate them. Ranking
    within the publication year removes almost all of that, and it is what every
    topic-level impact number below is built on.
    """
    by_year: dict[int, list[dict]] = defaultdict(list)
    for paper in papers:
        if paper["year"]:
            by_year[paper["year"]].append(paper)
    for cohort in by_year.values():
        cohort.sort(key=lambda p: p["cited"])
        n = len(cohort)
        for rank, paper in enumerate(cohort):
            paper["pct"] = round(100 * rank / (n - 1), 1) if n > 1 else 50.0


def build_payload(manifest: dict, cache: dict, baseline: dict) -> dict:
    """Fold the raw OpenAlex records into the small payload the browser gets."""
    papers: list[dict] = []
    by_openalex_id: dict[str, str] = {}

    for filename, record in manifest.items():
        if not isinstance(record, dict):
            continue
        doi = normalize_doi(record.get("doi") or "")
        entry = cache.get(doi) if doi else None
        if not entry:
            continue
        year = record_year(record) or entry.get("year")
        paper = {
            "file": filename,
            "title": (record.get("title") or "").strip()[:160],
            "year": year,
            "cited": entry["cited"],
            "byYear": entry["byYear"],
            "refs": entry["refs"],
            "keywords": [str(k).lower() for k in (record.get("keywords") or [])],
            "subjects": [str(s).lower() for s in (record.get("subjects") or [])],
        }
        papers.append(paper)
        if entry.get("id"):
            by_openalex_id[entry["id"]] = filename

    percentile_by_year(papers)
    max_year = max((p["year"] for p in papers if p["year"]), default=0)

    # ── Internal citation network: references that land inside the corpus.
    incoming: Counter = Counter()
    edges = 0
    for paper in papers:
        for ref in paper["refs"]:
            target = by_openalex_id.get(ref)
            if target and target != paper["file"]:
                incoming[target] += 1
                edges += 1
    by_file = {p["file"]: p for p in papers}
    internal = [
        {"file": f, "title": by_file[f]["title"], "year": by_file[f]["year"],
         "inCorpus": n, "cited": by_file[f]["cited"]}
        for f, n in incoming.most_common(25) if f in by_file
    ]

    # ── Sleeping beauties: old work whose citations arrived recently.
    sleeping = []
    recent_lo = max_year - SLEEPING_RECENT_SPAN + 1
    for paper in papers:
        if not paper["year"] or paper["year"] > max_year - SLEEPING_MIN_AGE:
            continue
        if paper["cited"] < SLEEPING_MIN_CITES:
            continue
        recent = sum(n for y, n in paper["byYear"].items() if int(y) >= recent_lo)
        share = recent / paper["cited"] if paper["cited"] else 0
        if share < SLEEPING_MIN_SHARE:
            continue
        sleeping.append({
            "file": paper["file"], "title": paper["title"], "year": paper["year"],
            "cited": paper["cited"], "recent": recent,
            "share": round(share * 100, 1),
            "score": round(share * math.log10(paper["cited"]), 3),
        })
    sleeping.sort(key=lambda s: -s["score"])

    # ── Most-cited, overall and per decade (decades keep old giants from crowding
    # out everything published since).
    ranked = sorted(papers, key=lambda p: -p["cited"])
    top = [{"file": p["file"], "title": p["title"], "year": p["year"],
            "cited": p["cited"], "pct": p.get("pct")} for p in ranked[:25]]
    per_decade: dict[str, list] = {}
    by_decade: dict[int, list] = defaultdict(list)
    for paper in papers:
        if paper["year"]:
            by_decade[(paper["year"] // 10) * 10].append(paper)
    for decade, cohort in sorted(by_decade.items()):
        if len(cohort) < 8:
            continue
        cohort.sort(key=lambda p: -p["cited"])
        per_decade[str(decade)] = [
            {"file": p["file"], "title": p["title"], "year": p["year"],
             "cited": p["cited"]} for p in cohort[:5]
        ]

    # ── Topic impact, on percentiles rather than raw counts.
    topic: dict[str, list] = {}
    for dim in ("keywords", "subjects"):
        buckets: dict[str, list[dict]] = defaultdict(list)
        for paper in papers:
            for term in set(paper[dim]):
                buckets[term].append(paper)
        rows = []
        for term, group in buckets.items():
            scored = [p for p in group if p.get("pct") is not None]
            if len(scored) < 8:
                continue
            scored.sort(key=lambda p: -p["cited"])
            rows.append({
                "term": term,
                "papers": len(group),
                "meanPct": round(sum(p["pct"] for p in scored) / len(scored), 1),
                "medianCited": sorted(p["cited"] for p in group)[len(group) // 2],
                "totalCited": sum(p["cited"] for p in group),
                "top": {"file": scored[0]["file"], "title": scored[0]["title"],
                        "cited": scored[0]["cited"]},
            })
        rows.sort(key=lambda r: -r["meanPct"])
        topic[dim] = rows[:40]

    # ── Citations arriving per year, corpus-wide: the library's living footprint.
    arrivals: Counter = Counter()
    for paper in papers:
        for year, n in paper["byYear"].items():
            arrivals[year] += n

    covered = len(papers)
    return {
        "generated": time.strftime("%Y-%m-%d"),
        "coverage": {
            "matched": covered,
            "manifest": len(manifest),
            "withDoi": sum(1 for r in manifest.values()
                           if isinstance(r, dict) and r.get("doi")),
            "totalCitations": sum(p["cited"] for p in papers),
            "internalEdges": edges,
        },
        "top": top,
        "perDecade": per_decade,
        "sleeping": sleeping[:20],
        "internal": internal,
        "topic": topic,
        "arrivals": {y: n for y, n in sorted(arrivals.items())},
        "baseline": baseline,
    }


def pick_baseline_terms(manifest: dict) -> list[str]:
    """The heaviest keywords and subjects — the terms most likely to be charted."""
    counts: Counter = Counter()
    for record in manifest.values():
        if not isinstance(record, dict):
            continue
        for term in (record.get("keywords") or []):
            counts[str(term).strip().lower()] += 1
        for term in (record.get("subjects") or []):
            counts[str(term).strip().lower()] += 1
    return [t for t, n in counts.most_common(BASELINE_TERMS) if t and n >= 10]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=0,
                        help="only fetch the first N DOIs (smoke test)")
    parser.add_argument("--skip-baseline", action="store_true",
                        help="skip the world-baseline requests")
    parser.add_argument("--refresh", action="store_true",
                        help="ignore the cache and refetch everything")
    args = parser.parse_args()

    if not MANIFEST.exists():
        log(f"manifest not found: {MANIFEST}")
        return 1
    log(f"loading {MANIFEST}")
    manifest = json.loads(MANIFEST.read_text())

    dois: list[str] = []
    seen: set[str] = set()
    for record in manifest.values():
        if not isinstance(record, dict):
            continue
        doi = normalize_doi(record.get("doi") or "")
        if doi and doi not in seen:
            seen.add(doi)
            dois.append(doi)
    if args.limit:
        dois = dois[:args.limit]
    log(f"{len(dois)} distinct DOIs across {len(manifest)} records")

    cache: dict = {}
    if RAW_CACHE.exists() and not args.refresh:
        cache = json.loads(RAW_CACHE.read_text())
        log(f"loaded cache: {len(cache)} entries")

    log("fetching works...")
    cache = fetch_works(dois, cache)
    RAW_CACHE.write_text(json.dumps(cache, separators=(",", ":")))
    matched = sum(1 for v in cache.values() if v)
    log(f"  cached {len(cache)} DOIs, {matched} matched in OpenAlex")

    # Cached separately from the per-paper records: --skip-baseline must reuse the
    # last good curves, not silently ship a payload with the baseline emptied out.
    baseline: dict = {}
    if BASELINE_CACHE.exists():
        baseline = json.loads(BASELINE_CACHE.read_text())
    if args.skip_baseline:
        log(f"skipping baseline fetch (reusing {len(baseline)} cached curves)")
    else:
        log("fetching world baseline...")
        fetched = fetch_baseline(pick_baseline_terms(manifest))
        if fetched:
            baseline = fetched
            BASELINE_CACHE.write_text(json.dumps(baseline, separators=(",", ":")))
        log(f"  {len(baseline)} baseline curves")

    log("aggregating...")
    payload = build_payload(manifest, cache, baseline)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))

    cov = payload["coverage"]
    log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")
    log(f"  {cov['matched']}/{cov['manifest']} papers with citation data "
        f"({cov['totalCitations']:,} citations)")
    log(f"  {cov['internalEdges']:,} internal citation edges")
    log(f"  {len(payload['sleeping'])} sleeping beauties, "
        f"{len(payload['internal'])} internally-cited papers")
    if payload["top"]:
        log(f"  most cited: {payload['top'][0]['cited']:,} — {payload['top'][0]['title'][:70]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
