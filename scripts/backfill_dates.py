#!/usr/bin/env python3
"""backfill_dates.py — add full publication dates (day/month/year) to the APA manifest,
and build records for any corpus PDFs still missing from it.

Companion to ``build_apa_manifest.py`` (which builds the bibliographic records). This
tool adds three fields to every record:

    date            ISO string truncated to known precision: "2024-03-17" | "2024-03" | "2024"
    date_precision  "day" | "month" | "year"
    date_source     "crossref" | "crossref_created" | "arxiv" | "llm_year" | "filename_year"

Semantics: **earliest public appearance** — the min of Crossref published-online /
published-print / issued / posted (preprints), or an arXiv v1 submission day. This is the
axis a recency digest cares about ("when did this work first appear"). The canonical `year`
(from the filename) is never overwritten; when a discovered date's year disagrees with it,
we keep the date but stamp ``date_flag`` for audit.

Every record ends with at least a year-precision date (falling back to the existing `year`),
so nothing is date-less.

Waterfall per record:
  1. DOI present            -> Crossref /works/{doi}, earliest date-parts (+ guarded `created`)
  2. arXiv id / preprint    -> arXiv API <published> (v1 day)
  3. neither, has a `year`  -> year-precision date from the canonical year (source=filename_year)

Subcommands:
    dates    [--limit N]     add/refresh dates on existing manifest records
    records  [--limit N]     build records for corpus PDFs missing from the manifest
                             (Crossref by printed DOI, else arXiv, else LLM), each dated
    report                   coverage histogram by precision and type

State/caches live under data/state/ so runs are resumable.
"""
from __future__ import annotations
import argparse, json, os, re, sys, threading, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_apa_manifest as bam  # noqa: E402  (crossref_to_record, finalize/normalize, schema)

REPO = Path(__file__).resolve().parent.parent
PAPERS = Path("/Users/devon7y/Papers")
MANIFEST = REPO / "data" / "papers_metadata.json"
STATE = REPO / "data" / "state"
CR_CACHE = STATE / ".crossref_date_cache.json"      # doi -> {date,precision,source,cr_year} | null
ARXIV_CACHE = STATE / ".arxiv_cache.json"           # arxiv_id -> {date,doi,title} | null
MAILTO = "devon7y@gmail.com"

DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>)\]]+", re.I)
ARXIV_RE = re.compile(r"arxiv:\s*(\d{4}\.\d{4,5})(v\d+)?", re.I)

# earliest-public-appearance keys, in the order we consider them (we take the min anyway)
CR_DATE_KEYS = ("published-online", "published-print", "issued", "posted", "published")


# ── date helpers ────────────────────────────────────────────────────────────────
def _iso(parts: list[int]) -> tuple[str, str]:
    """(iso_string, precision) from a Crossref date-parts list [Y], [Y,M], or [Y,M,D]."""
    parts = [int(p) for p in parts[:3] if p is not None]
    if not parts:
        return "", ""
    y = parts[0]
    if len(parts) == 1:
        return f"{y:04d}", "year"
    if len(parts) == 2:
        return f"{y:04d}-{parts[1]:02d}", "month"
    return f"{y:04d}-{parts[1]:02d}-{parts[2]:02d}", "day"


def _sortkey(parts: list[int]) -> tuple:
    p = [int(x) for x in parts[:3] if x is not None]
    return tuple(p + [99] * (3 - len(p)))  # missing month/day sort late (year-only is not "earliest day")


def crossref_earliest(msg: dict) -> tuple[str, str]:
    """Earliest (iso, precision) across the publication-date keys; ('','') if none."""
    best = None
    for key in CR_DATE_KEYS:
        dp = (msg.get(key) or {}).get("date-parts") or []
        if dp and dp[0] and dp[0][0]:
            iso, prec = _iso(dp[0])
            sk = _sortkey(dp[0])
            if best is None or sk < best[0]:
                best = (sk, iso, prec)
    return (best[1], best[2]) if best else ("", "")


def crossref_created_year(msg: dict) -> tuple[str, str, int | None]:
    """Full-day `created` date (deposit) + its year — used only as a guarded fallback."""
    dp = (msg.get("created") or {}).get("date-parts") or []
    if dp and dp[0] and dp[0][0]:
        iso, prec = _iso(dp[0])
        return iso, prec, int(dp[0][0])
    return "", "", None


def canonical_year(rec: dict) -> int | None:
    m = re.search(r"\d{4}", str(rec.get("year") or ""))
    return int(m.group(0)) if m else None


# ── network fetchers (threaded, cached) ─────────────────────────────────────────
class Cache:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.data = json.loads(path.read_text()) if path.exists() else {}
        self._dirty = 0

    def get(self, k, default=None):
        with self.lock:
            return self.data.get(k, default)

    def has(self, k):
        with self.lock:
            return k in self.data

    def put(self, k, v):
        with self.lock:
            self.data[k] = v
            self._dirty += 1
            if self._dirty >= 100:
                self._flush_locked()

    def _flush_locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False))
        tmp.replace(self.path)
        self._dirty = 0

    def flush(self):
        with self.lock:
            self._flush_locked()


def fetch_crossref_msg(doi: str) -> dict | None:
    doi = doi.rstrip(".,;)").lower()
    for attempt in range(4):
        try:
            r = requests.get(f"https://api.crossref.org/works/{doi}",
                             params={"mailto": MAILTO},
                             headers={"User-Agent": f"aprag-dates/1.0 (mailto:{MAILTO})"},
                             timeout=25)
            if r.status_code == 200:
                return r.json().get("message", {})
            if r.status_code == 404:
                return None
            if r.status_code in (429, 500, 502, 503):
                time.sleep(2 * (attempt + 1)); continue
            return None
        except requests.RequestException:
            time.sleep(2 * (attempt + 1))
    return None


def crossref_date_for_doi(doi: str, cache: Cache) -> dict | None:
    """{date, precision, source, cr_year} for a DOI, or None if unresolved. Cached."""
    key = doi.rstrip(".,;)").lower()
    if cache.has(key):
        return cache.get(key)
    msg = fetch_crossref_msg(key)
    out = None
    if msg:
        iso, prec = crossref_earliest(msg)
        cr_year = None
        dp = None
        for k in CR_DATE_KEYS:
            d = (msg.get(k) or {}).get("date-parts") or []
            if d and d[0] and d[0][0]:
                cr_year = int(d[0][0]); break
        if iso:
            out = {"date": iso, "precision": prec, "source": "crossref", "cr_year": cr_year}
        else:
            c_iso, c_prec, c_year = crossref_created_year(msg)
            if c_iso:
                out = {"date": c_iso, "precision": c_prec,
                       "source": "crossref_created", "cr_year": c_year}
    cache.put(key, out)
    return out


def fetch_arxiv(aid: str, cache: Cache) -> dict | None:
    """arXiv v1 <published> date (day precision) + the arXiv DOI. Cached."""
    aid = aid.strip()
    if cache.has(aid):
        return cache.get(aid)
    out = None
    for attempt in range(4):
        try:
            r = requests.get("http://export.arxiv.org/api/query",
                             params={"id_list": aid, "max_results": 1}, timeout=25)
            if r.status_code == 200:
                m = re.search(r"<published>(\d{4})-(\d{2})-(\d{2})", r.text)
                if m:
                    y, mo, d = m.groups()
                    out = {"date": f"{y}-{mo}-{d}", "precision": "day",
                           "doi": f"10.48550/arxiv.{aid}"}
                break
            time.sleep(2 * (attempt + 1))
        except requests.RequestException:
            time.sleep(2 * (attempt + 1))
    cache.put(aid, out)
    return out


# ── stamping ────────────────────────────────────────────────────────────────────
def stamp_date(rec: dict, date: str, precision: str, source: str) -> None:
    rec["date"] = date
    rec["date_precision"] = precision
    rec["date_source"] = source
    cy = canonical_year(rec)
    dy = int(date[:4]) if date[:4].isdigit() else None
    if cy and dy and cy != dy:
        rec["date_flag"] = f"date={date}; filename_year={cy}"
    else:
        rec.pop("date_flag", None)


def year_only_fallback(rec: dict) -> bool:
    cy = canonical_year(rec)
    if cy:
        stamp_date(rec, f"{cy:04d}", "year", "filename_year")
        return True
    return False


# ── subcommand: dates ────────────────────────────────────────────────────────────
def cmd_dates(args):
    manifest = json.loads(MANIFEST.read_text())
    cr_cache = Cache(CR_CACHE)
    ax_cache = Cache(ARXIV_CACHE)

    items = [(fn, r) for fn, r in manifest.items() if isinstance(r, dict)]
    if args.refresh:
        todo = items
    else:
        todo = [(fn, r) for fn, r in items if not r.get("date")]
    if args.limit:
        todo = todo[:args.limit]

    doi_items = [(fn, r) for fn, r in todo if (r.get("doi") or "").strip()]
    rest = [(fn, r) for fn, r in todo if not (r.get("doi") or "").strip()]
    print(f"dates: {len(todo)} records to fill "
          f"({len(doi_items)} via DOI, {len(rest)} via arXiv/year-fallback)", flush=True)

    n_cr = n_created = n_ax = n_year = n_none = 0
    lock = threading.Lock()
    done = [0]

    def do_doi(item):
        fn, r = item
        info = crossref_date_for_doi(r["doi"], cr_cache)
        return fn, r, info

    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for fn, r, info in ex.map(do_doi, doi_items):
            if info:
                stamp_date(r, info["date"], info["precision"], info["source"])
                if info["source"] == "crossref":
                    n_cr += 1
                else:
                    n_created += 1
            elif not year_only_fallback(r):
                n_none += 1
            else:
                n_year += 1
            done[0] += 1
            if done[0] % 250 == 0:
                cr_cache.flush()
                print(f"  {done[0]}/{len(todo)}  (crossref={n_cr} created={n_created} "
                      f"year={n_year})", flush=True)

    # arXiv + year fallback for the DOI-less
    def do_rest(item):
        fn, r = item
        aid = ""
        m = re.search(r"10\.48550/arxiv\.(\d{4}\.\d{4,5})", (r.get("doi") or ""), re.I)
        if m:
            aid = m.group(1)
        if aid:
            info = fetch_arxiv(aid, ax_cache)
            if info:
                return fn, r, ("arxiv", info)
        return fn, r, (None, None)

    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for fn, r, (kind, info) in ex.map(do_rest, rest):
            if kind == "arxiv":
                stamp_date(r, info["date"], info["precision"], "arxiv")
                n_ax += 1
            elif year_only_fallback(r):
                n_year += 1
            else:
                n_none += 1
            done[0] += 1

    cr_cache.flush(); ax_cache.flush()
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"\ndates done: crossref={n_cr} created-fallback={n_created} arxiv={n_ax} "
          f"year-only={n_year} unresolved={n_none}", flush=True)
    print(f"manifest -> {MANIFEST}")


# ── subcommand: report ────────────────────────────────────────────────────────────
def cmd_s2(args):
    """Semantic Scholar `publicationDate` — a 4th aggregator. Same day==01 padding as
    OpenAlex, so accept a day only when day!=01; also upgrade a YEAR-only record to MONTH
    when S2 gives a (padded-day) month. Unauthenticated S2 is ~1 rps and flaky -> low
    concurrency + retries + cache."""
    manifest = json.loads(MANIFEST.read_text())
    s2_cache = Cache(STATE / ".s2_cache.json")
    api_key = os.environ.get("S2_API_KEY", "")
    hdr = {"x-api-key": api_key} if api_key else {}
    targets = []
    for fn, r in manifest.items():
        if not isinstance(r, dict) or r.get("date_precision") == "day":
            continue
        cy = canonical_year(r)
        if cy is None or cy < args.since or not (r.get("doi") or "").strip():
            continue
        if s2_cache.has((r["doi"] or "").lower()):
            continue
        targets.append((fn, r))
    if args.limit:
        targets = targets[:args.limit]
    print(f"s2: {len(targets)} non-day records (DOI, >= {args.since})", flush=True)

    def fetch(item):
        fn, r = item
        doi = (r["doi"] or "").lower()
        pub = None
        for attempt in range(4):
            try:
                resp = requests.get(
                    f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}",
                    params={"fields": "publicationDate"}, headers=hdr, timeout=20)
                if resp.status_code == 200:
                    pub = resp.json().get("publicationDate")
                    break
                if resp.status_code in (429, 503):
                    time.sleep(2 * (attempt + 1)); continue
                break
            except requests.RequestException:
                time.sleep(2 * (attempt + 1))
        s2_cache.put(doi, pub)
        return fn, r, pub

    # fetch + cache only (no manifest writes here, so an interrupt loses nothing — the cache
    # is the durable record; the apply pass below is what mutates the manifest).
    done = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for _fn, _r, _pub in ex.map(fetch, targets):
            done += 1
            if done % 300 == 0:
                s2_cache.flush()
                print(f"  {done}/{len(targets)} fetched", flush=True)
    s2_cache.flush()

    # apply every cached S2 date to any non-day record (resumable: also lands dates cached by
    # an earlier interrupted run). day!=01 → day precision; a padded month lifts year→month.
    up_day = up_month = 0
    for _fn, r in manifest.items():
        if not isinstance(r, dict) or r.get("date_precision") == "day":
            continue
        pub = s2_cache.get((r.get("doi") or "").lower())
        if not (isinstance(pub, str) and re.match(r"\d{4}-\d{2}-\d{2}$", pub)):
            continue
        oy, om, od = int(pub[:4]), int(pub[5:7]), int(pub[8:10])
        cur = _parse_ymd(r.get("date"))
        if od != 1 and (cur is None or (oy, om) <= cur):
            stamp_date(r, pub, "day", "s2"); up_day += 1
        elif r.get("date_precision") == "year" and (cur is None or (oy, om) <= cur):
            stamp_date(r, f"{oy:04d}-{om:02d}", "month", "s2"); up_month += 1
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"\ns2 done: {up_day} upgraded to day, {up_month} year->month", flush=True)


def cmd_preprint(args):
    """Exact posting day for preprints via their native APIs: bioRxiv/medRxiv (10.1101 that
    are preprints), OSF/PsyArXiv (10.31234/osf.io/GUID). arXiv is handled by `dates`/records.
    (Most 10.1101 DOIs in this corpus are CSHL *journals*, not preprints — those return
    nothing here and are covered by the aggregator stages.)"""
    manifest = json.loads(MANIFEST.read_text())
    up = 0
    targets = [(fn, r) for fn, r in manifest.items()
               if isinstance(r, dict) and r.get("date_precision") != "day"
               and (r.get("doi") or "").strip()]

    def biorxiv(doi):
        for server in ("biorxiv", "medrxiv"):
            try:
                j = requests.get(f"https://api.biorxiv.org/details/{server}/{doi}",
                                 timeout=20).json()
                coll = j.get("collection") or []
                if coll and coll[0].get("date"):        # collection[0] = v1 (earliest)
                    return coll[0]["date"]
            except Exception:
                pass
        return None

    def osf(doi):
        m = re.search(r"osf\.io/(\w+)", doi) or re.search(r"10\.31234/osf\.io/(\w+)", doi)
        if not m:
            return None
        try:
            j = requests.get(f"https://api.osf.io/v2/preprints/{m.group(1)}/", timeout=20).json()
            dp = (j.get("data") or {}).get("attributes", {}).get("date_published")
            return dp[:10] if dp else None
        except Exception:
            return None

    checked = 0
    for fn, r in targets:
        doi = (r["doi"] or "").lower()
        d = None
        if "10.1101" in doi:
            d = biorxiv(doi.split("10.1101/")[-1] and doi)
        elif "osf.io" in doi or "10.31234" in doi:
            d = osf(doi)
        else:
            continue
        checked += 1
        if d and re.match(r"\d{4}-\d{2}-\d{2}$", d):
            stamp_date(r, d, "day", "preprint"); up += 1
        time.sleep(0.2)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"preprint: checked {checked} bioRxiv/OSF DOIs, upgraded {up} to a posting day",
          flush=True)


def cmd_openalex(args):
    """Upgrade month/year records to DAY precision via OpenAlex `publication_date`, which
    sometimes carries an exact online day Crossref/PubMed lack. OpenAlex PADS an unknown day
    to `-01`, so we accept a day only when it is NOT the 1st (day==01 is ambiguous -> skip),
    and only when it is not LATER than the current month (keep the earliest appearance)."""
    manifest = json.loads(MANIFEST.read_text())
    oa_cache = Cache(STATE / ".openalex_cache.json")   # doi -> "YYYY-MM-DD" | null
    targets = []
    for fn, r in manifest.items():
        if not isinstance(r, dict) or r.get("date_precision") == "day":
            continue
        cy = canonical_year(r)
        if cy is None or cy < args.since or not (r.get("doi") or "").strip():
            continue
        targets.append((fn, r))
    if args.limit:
        targets = targets[:args.limit]
    print(f"openalex: {len(targets)} month/year records (DOI, >= {args.since})", flush=True)

    def fetch(item):
        fn, r = item
        doi = (r["doi"] or "").lower()
        if oa_cache.has(doi):
            return fn, r, oa_cache.get(doi)
        pub = None
        try:
            resp = requests.get(f"https://api.openalex.org/works/https://doi.org/{doi}",
                                params={"mailto": MAILTO}, timeout=20)
            if resp.status_code == 200:
                pub = resp.json().get("publication_date")   # "YYYY-MM-DD"
        except Exception:
            pub = None
        oa_cache.put(doi, pub)
        return fn, r, pub

    up = 0
    done = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for fn, r, pub in ex.map(fetch, targets):
            done += 1
            if pub and re.match(r"\d{4}-\d{2}-\d{2}$", pub):
                oy, om, od = int(pub[:4]), int(pub[5:7]), int(pub[8:10])
                if od != 1:                              # day==01 is OpenAlex padding
                    cur = _parse_ymd(r.get("date"))
                    if cur is None or (oy, om) <= cur:   # not later than current month
                        stamp_date(r, pub, "day", "openalex")
                        up += 1
            if done % 500 == 0:
                oa_cache.flush()
                print(f"  {done}/{len(targets)}  (upgraded={up})", flush=True)
    oa_cache.flush()
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"\nopenalex done: {up} records upgraded to a real (non-padded) day", flush=True)


def _parse_ymd(iso: str | None) -> tuple | None:
    if not iso:
        return None
    m = re.match(r"(\d{4})(?:-(\d{2}))?", iso)
    return (int(m.group(1)), int(m.group(2)) if m.group(2) else 1) if m else None


def cmd_pubmed(args):
    """Upgrade month/year-precision records to DAY precision via PubMed's electronic
    publication date (ArticleDate[Electronic] / epublish). For biomed/psych/neuro corpora
    PubMed frequently has the exact epub day when Crossref only stored the month — and it
    is the authoritative earliest electronic appearance. DOI -> PMID (esearch) -> efetch."""
    import xml.etree.ElementTree as ET
    manifest = json.loads(MANIFEST.read_text())
    pm_cache = Cache(STATE / ".pubmed_cache.json")   # doi -> {date,precision} | null
    tool = {"tool": "aprag", "email": MAILTO}
    api_key = os.environ.get("NCBI_API_KEY", "")
    if api_key:
        tool["api_key"] = api_key
    rate = 0.11 if api_key else 0.34                 # 10/s with key, 3/s without

    targets = []
    for fn, r in manifest.items():
        if not isinstance(r, dict):
            continue
        if r.get("date_precision") == "day":
            continue
        cy = canonical_year(r)
        if cy is None or cy < args.since:
            continue
        if not (r.get("doi") or "").strip():
            continue
        if pm_cache.has((r["doi"] or "").lower()):
            continue
        targets.append((fn, r))
    if args.limit:
        targets = targets[:args.limit]
    print(f"pubmed: {len(targets)} month/year records (DOI, >= {args.since}) to look up "
          f"({'with' if api_key else 'no'} API key, {1/rate:.0f}/s)", flush=True)

    # phase 1: DOI -> PMID via esearch (rate-limited, cached)
    doi_pmid = {}
    for i, (fn, r) in enumerate(targets):
        doi = (r["doi"] or "").lower()
        try:
            resp = requests.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
                                params={"db": "pubmed", "term": f"{doi}[DOI]",
                                        "retmode": "json", **tool}, timeout=20)
            ids = resp.json().get("esearchresult", {}).get("idlist", [])
            if ids:
                doi_pmid[doi] = ids[0]
            else:
                pm_cache.put(doi, None)   # not in PubMed
        except Exception:
            pass
        time.sleep(rate)
        if (i + 1) % 200 == 0:
            print(f"  esearch {i+1}/{len(targets)}  ({len(doi_pmid)} PMIDs)", flush=True)

    # phase 2: efetch PMIDs in batches -> electronic date, mapped back by DOI
    pmid_doi = {v: k for k, v in doi_pmid.items()}
    pmids = list(pmid_doi)
    print(f"  efetch {len(pmids)} PMIDs...", flush=True)

    def parse_article(art) -> tuple[str, str, str] | None:
        # returns (doi, iso, precision) using the electronic ArticleDate, else epublish
        doi = ""
        for aid in art.iter("ArticleId"):
            if aid.get("IdType") == "doi":
                doi = (aid.text or "").lower()
        best = None
        for ad in art.iter("ArticleDate"):
            if ad.get("DateType") == "Electronic":
                y, mo, d = ad.findtext("Year"), ad.findtext("Month"), ad.findtext("Day")
                if y and mo and d:
                    best = (f"{int(y):04d}-{int(mo):02d}-{int(d):02d}", "day")
        if not best:
            for pd in art.iter("PubMedPubDate"):
                if pd.get("PubStatus") == "epublish":
                    y, mo, d = pd.findtext("Year"), pd.findtext("Month"), pd.findtext("Day")
                    if y and mo and d:
                        best = (f"{int(y):04d}-{int(mo):02d}-{int(d):02d}", "day")
        return (doi, best[0], best[1]) if (doi and best) else None

    date_by_doi = {}
    for j in range(0, len(pmids), 200):
        batch = pmids[j:j + 200]
        try:
            f = requests.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
                             params={"db": "pubmed", "id": ",".join(batch),
                                     "rettype": "xml", **tool}, timeout=60).text
            root = ET.fromstring(f)
            for art in root.iter("PubmedArticle"):
                got = parse_article(art)
                if got:
                    date_by_doi[got[0]] = (got[1], got[2])
        except Exception as e:
            print(f"  efetch batch {j} error: {e}", flush=True)
        time.sleep(rate)

    # cache EVERY looked-up DOI so re-runs skip it: dated ones get the date, DOIs that
    # resolved a PMID but had no epub date get None (checked, nothing there).
    for doi, (iso, prec) in date_by_doi.items():
        pm_cache.put(doi, {"date": iso, "precision": prec})
    for doi in doi_pmid:                       # had a PMID
        if doi not in date_by_doi and not pm_cache.has(doi):
            pm_cache.put(doi, None)
    pm_cache.flush()

    # apply every cached PubMed epub date to any non-day record with that DOI (resumable:
    # this also lands dates cached by an earlier interrupted run)
    up = 0
    for fn, r in manifest.items():
        if not isinstance(r, dict) or r.get("date_precision") == "day":
            continue
        info = pm_cache.get((r.get("doi") or "").lower())
        if isinstance(info, dict) and info.get("date"):
            stamp_date(r, info["date"], info["precision"], "pubmed")
            up += 1
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"\npubmed done: {up} records upgraded to a PubMed epub date "
          f"({len(doi_pmid)} newly resolved this run)", flush=True)


def cmd_bibmatch(args):
    """Upgrade year-only records: Crossref bibliographic search (title+author) -> real date
    + DOI. Targets the DOI era (>= --since) where hit rates are high. Reuses the date cache."""
    from backfill_records import biblio_match_date
    manifest = json.loads(MANIFEST.read_text())
    cr_cache = Cache(CR_CACHE)
    todo = []
    for fn, r in manifest.items():
        if not isinstance(r, dict):
            continue
        if r.get("date_source") != "filename_year":
            continue
        cy = canonical_year(r)
        if cy is None or cy < args.since:
            continue
        if len((r.get("title") or "").strip()) < 12:
            continue
        todo.append((fn, r))
    if args.limit:
        todo = todo[:args.limit]
    print(f"bibmatch: {len(todo)} year-only records since {args.since} with a title", flush=True)

    n_hit = n_doi = 0
    done = [0]
    lock = threading.Lock()

    def do(item):
        fn, r = item
        au = r.get("authors") or r.get("editors") or []
        surn = au[0].get("family", "") if au else ""
        info = biblio_match_date(r.get("title", ""), surn, cr_cache)
        return fn, r, info

    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for fn, r, info in ex.map(do, todo):
            if info and info.get("date"):
                stamp_date(r, info["date"], info["precision"], "crossref")
                n_hit += 1
                if info.get("doi") and not (r.get("doi") or "").strip():
                    r["doi"] = info["doi"]; n_doi += 1
            done[0] += 1
            if done[0] % 200 == 0:
                cr_cache.flush()
                print(f"  {done[0]}/{len(todo)}  (upgraded={n_hit} doi-added={n_doi})", flush=True)

    cr_cache.flush()
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"\nbibmatch done: upgraded {n_hit}/{len(todo)} to a real date "
          f"({n_doi} DOIs backfilled)", flush=True)


def cmd_report(args):
    from collections import Counter
    manifest = json.loads(MANIFEST.read_text())
    recs = [r for r in manifest.values() if isinstance(r, dict)]
    prec = Counter(r.get("date_precision", "(none)") for r in recs)
    src = Counter(r.get("date_source", "(none)") for r in recs)
    flags = sum(1 for r in recs if r.get("date_flag"))
    print(f"manifest records: {len(recs)}")
    print("date precision:")
    for k in ("day", "month", "year", "(none)"):
        print(f"  {k:8} {prec.get(k, 0):5d}  ({100*prec.get(k,0)/len(recs):.1f}%)")
    print("date source:")
    for k, c in src.most_common():
        print(f"  {k:18} {c}")
    print(f"date_flag (year disagrees with filename): {flags}")
    # precision by decade
    dec = Counter()
    for r in recs:
        y = canonical_year(r)
        if y:
            dec[(y // 10 * 10, r.get("date_precision", "none"))] += 1
    print("precision by decade (day / month / year):")
    for d in sorted({k[0] for k in dec}):
        print(f"  {d}s: {dec.get((d,'day'),0):4d} / {dec.get((d,'month'),0):4d} / "
              f"{dec.get((d,'year'),0):4d}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pd = sub.add_parser("dates"); pd.add_argument("--limit", type=int, default=0)
    pd.add_argument("--jobs", type=int, default=10); pd.add_argument("--refresh", action="store_true")
    pr = sub.add_parser("records"); pr.add_argument("--limit", type=int, default=0)
    pr.add_argument("--jobs", type=int, default=8)
    pb = sub.add_parser("bibmatch"); pb.add_argument("--limit", type=int, default=0)
    pb.add_argument("--jobs", type=int, default=10); pb.add_argument("--since", type=int, default=2000)
    pp = sub.add_parser("pubmed"); pp.add_argument("--limit", type=int, default=0)
    pp.add_argument("--since", type=int, default=1996)
    po = sub.add_parser("openalex"); po.add_argument("--limit", type=int, default=0)
    po.add_argument("--jobs", type=int, default=8); po.add_argument("--since", type=int, default=1996)
    p2 = sub.add_parser("s2"); p2.add_argument("--limit", type=int, default=0)
    p2.add_argument("--jobs", type=int, default=4); p2.add_argument("--since", type=int, default=1996)
    sub.add_parser("preprint")
    pa = sub.add_parser("all", help="run the whole date pipeline in order (idempotent, cached)")
    pa.add_argument("--since", type=int, default=1990)
    sub.add_parser("report")
    args = ap.parse_args()
    if args.cmd == "dates":
        return cmd_dates(args)
    if args.cmd == "records":
        from backfill_records import cmd_records  # split out for readability
        return cmd_records(args)
    if args.cmd == "bibmatch":
        return cmd_bibmatch(args)
    if args.cmd == "pubmed":
        return cmd_pubmed(args)
    if args.cmd == "openalex":
        return cmd_openalex(args)
    if args.cmd == "s2":
        return cmd_s2(args)
    if args.cmd == "preprint":
        return cmd_preprint(args)
    if args.cmd == "all":
        return cmd_all(args)
    if args.cmd == "report":
        return cmd_report(args)
    return 0


def cmd_all(args):
    """Full reproducible date pipeline. Every stage is idempotent (only touches records that
    are still non-day) and cached (re-queries only DOIs/titles not seen before), so this is
    safe to re-run after adding papers — it does just the new work. The gpt-5-mini Batch pass
    (backfill_dates_llm.py submit/collect) is async and run separately; do it after this if
    you want to squeeze day-precision from PDFs the aggregators missed."""
    from types import SimpleNamespace
    since = args.since
    log("[1/7] records — build APA records for new corpus PDFs")
    from backfill_records import cmd_records
    cmd_records(SimpleNamespace(limit=0, jobs=8))
    log("[2/7] dates — Crossref-by-DOI + arXiv + year fallback")
    cmd_dates(SimpleNamespace(limit=0, jobs=12, refresh=False))
    log("[3/7] bibmatch — Crossref title/author search for no-DOI records")
    cmd_bibmatch(SimpleNamespace(limit=0, jobs=10, since=since))
    log("[4/7] pubmed — electronic (epub) publication day")
    cmd_pubmed(SimpleNamespace(limit=0, since=max(since, 1996)))
    log("[5/7] openalex — publication_date (day!=01)")
    cmd_openalex(SimpleNamespace(limit=0, jobs=8, since=max(since, 1996)))
    log("[6/7] s2 — Semantic Scholar (day!=01, year->month)")
    cmd_s2(SimpleNamespace(limit=0, jobs=4, since=max(since, 1996)))
    log("[7/7] preprint — bioRxiv/OSF posting day")
    cmd_preprint(SimpleNamespace())
    print("\n=== pipeline complete ===")
    cmd_report(SimpleNamespace())
    return 0


def log(msg):
    print(f"\n### {msg}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
