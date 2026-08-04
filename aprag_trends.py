"""
aprag_trends.py — corpus trend aggregation for the Research Trends dashboard.

Pure helpers over the APA manifest (no RAG objects, no I/O), imported by
``query_server.py`` and cached there for the server lifetime. Two entry points:

    compute_trends(manifest)             the dashboard's overview payload
    trend_detail(manifest, dim, term)    one term's neighbourhood, owners, papers

Two properties of this corpus drive the design, and both are worth stating because
they make the naive version of this page misleading:

1. **It is a library, not a census.** Collected output peaks in the 2000s and falls
   after (3,387 papers in the 2000s, 2,717 in the 2010s, 1,325 so far in the 2020s).
   Raw counts therefore make *every* term look like it is dying. Everything
   comparative here is a share of that year's collected output, and the raw counts
   are carried alongside only so the caller can show both.

2. **Keyword vocabulary is uncontrolled.** 16.6k distinct keywords, 72% of them
   appearing exactly once, with `memory` / `episodic memory` / `recognition memory`
   all competing. Terms are folded case-insensitively and each dimension is capped
   to its heaviest terms; `subjects` (1k distinct) is the better-behaved dimension,
   and the semantic cluster trends (built offline from chunk embeddings) sidestep the
   vocabulary problem entirely.
"""

from __future__ import annotations

import datetime
import math
import re
from collections import Counter, defaultdict

# Terms kept per dimension, heaviest first. Affiliations and types are new
# dimensions; both are normalised below before counting.
DIM_CAPS = {
    "keywords": 300,
    "subjects": 200,
    "journals": 200,
    "authors": 300,
    "affiliations": 200,
    "types": 20,
}

# Windows for every then-vs-now comparison: the last full decade of the corpus
# against the decade before it.
RECENT_SPAN = 10
BASE_SPAN = 10

MIN_YEAR = 1800
MAX_YEAR = 2100

# A term must clear this to be scored for rising/fading or bursts — below it the
# share deltas are noise.
MIN_TOTAL_FOR_SCORING = 8
# Newcomers are held to a lower bar (they cannot have accumulated much yet).
MIN_TOTAL_FOR_NEWCOMER = 4
NEWCOMER_MAX_AGE = 15

# Lead/lag search: only over the corpus's dense era, where a year's counts mean
# something.
LEADLAG_MIN_YEAR = 1985
LEADLAG_TERMS = 120
LEADLAG_MAX_LAG = 8
LEADLAG_MIN_R = 0.55


# ── Field normalisation ───────────────────────────────────────────────────────

_INSTITUTION_HINTS = (
    "universit", "college", "institute", "institut", "school", "hospital",
    "academy", "laborator", "laboratoire", "center", "centre", "max planck",
    "cnrs", "mrc ", "nih", "museum", "foundation", "polytechnic", "ecole",
    "école", "faculty",
)

# Segments that are never the institution itself.
# Matched with startswith, so a genuine institution that merely *contains* one of
# these ("London School of Economics", "Max Planck Institute") is unaffected.
_UNIT_PREFIXES = (
    "department", "dept", "division", "program", "programme", "unit", "section",
    "group", "chair", "school of", "faculty of", "centre for", "center for",
    "laboratory", "laboratoire", "graduate school", "research group",
    "institute of psychology",  # too generic on its own
)

_COUNTRY_TAIL = re.compile(
    r",\s*(usa|u\.s\.a\.|united states|uk|u\.k\.|united kingdom|canada|germany|"
    r"france|italy|spain|netherlands|belgium|australia|japan|china|israel|sweden|"
    r"norway|denmark|finland|switzerland|austria|poland|brazil|india|"
    r"new zealand|scotland|england|wales|ireland|portugal|greece|"
    r"czech republic|hungary|russia|south korea|korea|singapore|mexico|"
    r"argentina|chile|turkey|south africa)\.?\s*$",
    re.IGNORECASE,
)

_ABBREV = (
    (re.compile(r"\bUniv\.?\b", re.IGNORECASE), "University"),
    (re.compile(r"\bInst\.?\b", re.IGNORECASE), "Institute"),
    (re.compile(r"\bDept\.?\b", re.IGNORECASE), "Department"),
    (re.compile(r"\bU\.\s*of\b", re.IGNORECASE), "University of"),
)

# Multi-campus systems, where the campus is the institution. Without this every UC
# collapses into one 453-paper "University of California" that is not a place anyone
# works: the campus name sits in the segment *after* the one matching an institution
# hint ("University of California, San Diego").
_MULTI_CAMPUS = (
    "university of california", "state university of new york",
    "university of texas", "university of illinois", "university of wisconsin",
    "university of massachusetts", "university of colorado",
    "university of missouri", "university of nebraska", "university of maryland",
    "university of washington", "university of north carolina",
    "university of south florida", "indiana university", "purdue university",
    "rutgers university", "texas a&m university", "pennsylvania state university",
    "city university of new york",
)

# Two-letter state/province codes and similar noise that must never be mistaken for
# a campus qualifier.
_NOT_A_CAMPUS = re.compile(r"^([A-Z]{2}|\d{4,}|[A-Z]?\d[\w\s-]*)$")

# arXiv category codes leak into `subjects` from preprint metadata. Left raw they
# rank as separate terms ("cs", "cs.CL", "cs.AI") and crowd out the readable subject
# vocabulary — three of the top six subject bursts were codes.
_ARXIV_SUBJECTS = {
    "cs": "Computer Science",
    "cs.ai": "Artificial Intelligence",
    "cs.cl": "Computation and Language",
    "cs.lg": "Machine Learning",
    "cs.hc": "Human-Computer Interaction",
    "cs.cv": "Computer Vision",
    "cs.ne": "Neural and Evolutionary Computing",
    "cs.cy": "Computers and Society",
    "cs.cr": "Cryptography and Security",
    "cs.si": "Social and Information Networks",
    "cs.ir": "Information Retrieval",
    "cs.gt": "Game Theory",
    "cs.ma": "Multiagent Systems",
    "stat": "Statistics",
    "stat.ml": "Machine Learning",
    "stat.me": "Statistical Methodology",
    "stat.ap": "Applied Statistics",
    "math": "Mathematics",
    "math.dg": "Differential Geometry",
    "q-bio": "Quantitative Biology",
    "q-bio.nc": "Neurons and Cognition",
}


def normalize_subject(raw) -> str:
    """Expand arXiv category codes; leave every other subject as printed."""
    text = str(raw or "").strip()
    if not text:
        return ""
    return _ARXIV_SUBJECTS.get(text.lower(), text)


_TYPE_LABELS = {
    "article": "Journal article",
    "article-journal": "Journal article",
    "preprint": "Preprint",
    "posted-content": "Preprint",
    "chapter": "Book chapter",
    "book": "Book",
    "report": "Report",
    "thesis": "Thesis",
    "paper-conference": "Conference paper",
    "other": "Other",
}


def normalize_affiliation(raw) -> str:
    """Reduce a free-text affiliation to its institution.

    The manifest stores affiliations exactly as printed, so ``University of Alberta``
    and ``Department of Psychology, University of Alberta`` are distinct strings —
    12.3k of them across the corpus. Without this the dimension is unusable: the
    real institutions are split across a dozen spellings each and none of them
    reaches the cap.

    Strategy: drop a trailing country, split on commas, and keep the first segment
    that looks like an institution (and is not a department/division). Falls back to
    the longest segment so nothing is silently dropped.
    """
    if isinstance(raw, dict):
        raw = raw.get("name") or raw.get("institution") or raw.get("value") or ""
    text = str(raw or "").strip()
    if not text:
        return ""
    for pattern, replacement in _ABBREV:
        text = pattern.sub(replacement, text)
    text = _COUNTRY_TAIL.sub("", text).strip(" .,;")
    if not text:
        return ""

    segments = [s.strip(" .,;") for s in text.split(",")]
    segments = [s for s in segments if s]
    if not segments:
        return ""

    def is_unit(seg: str) -> bool:
        low = seg.lower()
        return any(low.startswith(p) for p in _UNIT_PREFIXES)

    for index, seg in enumerate(segments):
        low = seg.lower()
        if any(h in low for h in _INSTITUTION_HINTS) and not is_unit(seg):
            cleaned = re.sub(r"\s+", " ", seg).strip()
            # "The University of X" and "University of X" are the same place.
            cleaned = re.sub(r"^the\s+", "", cleaned, flags=re.IGNORECASE)
            # Multi-campus systems carry the campus in the next segment.
            if cleaned.lower() in _MULTI_CAMPUS and index + 1 < len(segments):
                campus = re.sub(r"\s+", " ", segments[index + 1]).strip()
                if (campus and len(campus.split()) <= 3
                        and not _NOT_A_CAMPUS.match(campus)
                        and not any(h in campus.lower() for h in _INSTITUTION_HINTS)):
                    return f"{cleaned}, {campus}"
            return cleaned

    longest = max(segments, key=len)
    if len(longest) < 4 or is_unit(longest):
        return ""
    return re.sub(r"\s+", " ", longest).strip()


def normalize_type(raw) -> str:
    """Map a CSL type onto a display label (``article`` → ``Journal article``)."""
    key = str(raw or "").strip().lower()
    if not key:
        return ""
    return _TYPE_LABELS.get(key, key.replace("-", " ").capitalize())


def record_year(record: dict) -> int | None:
    """Publication year, tolerant of the manifest's mixed year/date shapes."""
    for key in ("year", "issued_year"):
        value = record.get(key)
        if value in (None, ""):
            continue
        try:
            year = int(str(value)[:4])
        except (TypeError, ValueError):
            continue
        if MIN_YEAR <= year <= MAX_YEAR:
            return year
    date = str(record.get("date") or "")
    match = re.match(r"(\d{4})", date)
    if match:
        year = int(match.group(1))
        if MIN_YEAR <= year <= MAX_YEAR:
            return year
    return None


def record_terms(record: dict) -> dict[str, list[str]]:
    """Every dimension's terms for one record, already normalised."""
    authors = []
    for author in (record.get("authors") or []):
        if isinstance(author, dict):
            family = (author.get("family") or "").strip()
        else:
            family = str(author or "").strip()
        if family:
            authors.append(family)

    affiliations = []
    for affiliation in (record.get("affiliations") or []):
        name = normalize_affiliation(affiliation)
        if name:
            affiliations.append(name)

    journal = str(record.get("container_title") or "").strip()
    kind = normalize_type(record.get("type"))
    return {
        "keywords": [str(k).strip() for k in (record.get("keywords") or []) if str(k).strip()],
        "subjects": sorted({
            s for s in (normalize_subject(v) for v in (record.get("subjects") or []))
            if s
        }),
        "journals": [journal] if journal else [],
        "authors": authors,
        "affiliations": sorted(set(affiliations)),
        "types": [kind] if kind else [],
    }


# ── Per-term statistics ───────────────────────────────────────────────────────

def _term_stats(counts: dict[int, int]) -> dict:
    """First/peak/median/last year for one term's year histogram.

    The median is the year at which half the term's papers had appeared — a "topic
    age" that separates a long-running staple from a recent arrival with the same
    total.
    """
    if not counts:
        return {}
    years = sorted(counts)
    total = sum(counts.values())
    peak_year = max(years, key=lambda y: (counts[y], y))
    running = 0
    median_year = years[0]
    for year in years:
        running += counts[year]
        if running >= total / 2:
            median_year = year
            break
    return {
        "first": years[0],
        "last": years[-1],
        "peak": peak_year,
        "peakN": counts[peak_year],
        "median": median_year,
    }


def _window_sum(counts: dict[int, int], lo: int, hi: int) -> int:
    return sum(n for y, n in counts.items() if lo <= y <= hi)


def _burst(counts: dict[int, int], corpus: dict[int, int], total: int,
           corpus_total: int, window: int = 3) -> dict | None:
    """Strongest 3-year concentration of a term relative to its own baseline.

    A Poisson surprise score: over a window the corpus collected ``n_w`` papers, so a
    term with ``total`` papers overall is expected to appear ``total * n_w /
    corpus_total`` times there. The z-score of the excess, ``(observed - expected) /
    sqrt(expected)``, is the burst weight.

    This is what the decade-delta in the rising/fading columns cannot see: a term
    that spiked hard for three years and settled back averages out flat there, but
    scores high here.
    """
    if total < MIN_TOTAL_FOR_SCORING or corpus_total <= 0 or not counts:
        return None
    years = sorted(corpus)
    if not years:
        return None
    last = years[-1]
    best = None
    for start in years:
        end = start + window - 1
        if end > last:
            # A window running past the corpus would be reported as e.g. "2025–2027"
            # while only covering the two years that exist.
            break
        expected_papers = _window_sum(corpus, start, end)
        if expected_papers <= 0:
            continue
        expected = total * expected_papers / corpus_total
        if expected < 1.0:
            continue
        observed = _window_sum(counts, start, end)
        if observed <= expected:
            continue
        score = (observed - expected) / math.sqrt(expected)
        if best is None or score > best["z"]:
            best = {"from": start, "to": end, "n": observed,
                    "expected": round(expected, 1), "z": round(score, 2)}
    return best


# ── Lead / lag ────────────────────────────────────────────────────────────────

def _pearson(a: list[float], b: list[float]) -> float:
    """Pearson r over exactly the slices given.

    Computed on the slices rather than on a globally standardised series: a lagged
    comparison only overlaps on a sub-range, and a sub-range of a globally z-scored
    series has neither zero mean nor unit variance, so the "correlation" is not
    bounded by 1 (the first cut of this reported r = 1.01).
    """
    n = len(a)
    if n < 8:
        return 0.0
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    var_a = sum((x - mean_a) ** 2 for x in a)
    var_b = sum((x - mean_b) ** 2 for x in b)
    if var_a <= 1e-12 or var_b <= 1e-12:
        return 0.0
    cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n))
    return cov / math.sqrt(var_a * var_b)


def _smooth(values: list[float], window: int = 3) -> list[float]:
    half = window // 2
    out = []
    for i in range(len(values)):
        lo = max(0, i - half)
        hi = min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def _overlapping(a: str, b: str) -> bool:
    """True for pairs whose relationship is lexical rather than temporal.

    ``memory`` leading ``episodic memory`` is a vocabulary artefact, not a finding,
    and those pairs otherwise dominate the results.
    """
    la, lb = a.lower(), b.lower()
    if la in lb or lb in la:
        return True
    wa = set(re.findall(r"[a-z]{4,}", la))
    wb = set(re.findall(r"[a-z]{4,}", lb))
    return bool(wa & wb)


def _lead_lag(terms: list[dict], corpus: dict[int, int],
              limit: int = 20) -> list[dict]:
    """Term pairs whose share curves correlate best at a non-zero lag.

    For each ordered pair the leader's curve is compared against the follower's
    shifted back by 2..8 years; the best-correlating lag is kept when it beats the
    pair's own zero-lag correlation (otherwise the two simply move together and the
    lag is spurious).
    """
    years = [y for y in sorted(corpus) if y >= LEADLAG_MIN_YEAR and corpus[y] > 0]
    if len(years) < 15:
        return []

    curves: dict[str, list[float]] = {}
    for term in terms[:LEADLAG_TERMS]:
        counts = term["_counts"]
        if term["total"] < 15:
            continue
        share = [counts.get(y, 0) / corpus[y] for y in years]
        if sum(1 for v in share if v > 0) >= 10:
            curves[term["term"]] = _smooth(share)

    names = list(curves)
    pairs: list[dict] = []
    for i, lead in enumerate(names):
        a = curves[lead]
        n = len(a)
        for follow in names[i + 1:]:
            if _overlapping(lead, follow):
                continue
            b = curves[follow]
            zero = _pearson(a, b)
            for direction in (1, -1):
                first, second = (a, b) if direction == 1 else (b, a)
                best_r, best_lag = 0.0, 0
                for lag in range(2, LEADLAG_MAX_LAG + 1):
                    overlap = n - lag
                    if overlap < 12:
                        break
                    r = _pearson(first[:overlap], second[lag:lag + overlap])
                    if r > best_r:
                        best_r, best_lag = r, lag
                # Must beat moving-together: without this the list fills with pairs
                # that are simply both riding the same corpus-wide swell.
                if best_r >= LEADLAG_MIN_R and best_r > zero + 0.08:
                    pairs.append({
                        "lead": lead if direction == 1 else follow,
                        "follow": follow if direction == 1 else lead,
                        "lag": best_lag,
                        "r": round(best_r, 2),
                        "gain": round(best_r - zero, 2),
                    })
    pairs.sort(key=lambda p: (-p["r"], -p["gain"]))

    seen: set[str] = set()
    out: list[dict] = []
    for pair in pairs:
        key = pair["lead"]
        if key in seen:
            continue
        seen.add(key)
        out.append(pair)
        if len(out) >= limit:
            break
    return out


# ── Overview payload ──────────────────────────────────────────────────────────

def compute_trends(manifest: dict) -> dict:
    """The Research Trends overview: one pass over the manifest, then scoring.

    Shape (every field beyond ``years`` and the four original dimensions is additive,
    so an older client keeps working):

        years         {year: papers}
        <dim>         [{term, total, counts, stats, delta, base, recent}]  x6 dims
        windows       {base: [lo, hi], recent: [lo, hi]}
        newcomers     {dim: [{term, first, total, recent}]}
        bursts        {dim: [{term, from, to, n, expected, z}]}
        leadlag       [{lead, follow, lag, r}]
        totals        {papers, dated, dims: {dim: distinct}}
    """
    years: Counter[int] = Counter()
    dims: dict[str, dict[str, dict]] = {k: {} for k in DIM_CAPS}
    undated = 0

    for record in (manifest or {}).values():
        if not isinstance(record, dict):
            continue
        year = record_year(record)
        if year is None:
            undated += 1
            continue
        years[year] += 1
        for dim, terms in record_terms(record).items():
            bucket = dims[dim]
            for term in terms:
                key = term.lower()
                entry = bucket.get(key)
                if entry is None:
                    entry = bucket[key] = {"term": term, "total": 0,
                                           "counts": Counter()}
                entry["total"] += 1
                entry["counts"][year] += 1

    corpus = dict(years)
    corpus_total = sum(corpus.values())
    if not corpus:
        return {"years": {}, "windows": {}, "newcomers": {}, "bursts": {},
                "leadlag": [], "totals": {"papers": undated, "dated": 0, "dims": {}},
                **{dim: [] for dim in DIM_CAPS}}

    max_year = max(corpus)
    recent = (max_year - RECENT_SPAN + 1, max_year)
    base = (recent[0] - BASE_SPAN, recent[0] - 1)
    corpus_recent = max(1, _window_sum(corpus, *recent))
    corpus_base = max(1, _window_sum(corpus, *base))

    # The current year is only partly collected, so its bar and its share are not
    # comparable with a complete year. Flagged rather than dropped — the caller
    # renders it differently instead of the page silently losing its newest data.
    this_year = datetime.date.today().year
    out: dict = {
        "years": {str(y): n for y, n in sorted(corpus.items())},
        "partialFrom": this_year if max_year >= this_year else None,
        "windows": {"base": list(base), "recent": list(recent)},
        "totals": {
            "papers": corpus_total + undated,
            "dated": corpus_total,
            "undated": undated,
            "dims": {dim: len(bucket) for dim, bucket in dims.items()},
        },
    }

    newcomers: dict[str, list] = {}
    bursts: dict[str, list] = {}
    ranked_for_leadlag: list[dict] = []

    for dim, cap in DIM_CAPS.items():
        entries = sorted(dims[dim].values(), key=lambda e: -e["total"])[:cap]
        shaped = []
        for entry in entries:
            counts = dict(entry["counts"])
            in_recent = _window_sum(counts, *recent)
            in_base = _window_sum(counts, *base)
            # Share of collected output, so the corpus's own decline cannot masquerade
            # as a topic declining.
            delta = in_recent / corpus_recent - in_base / corpus_base
            shaped.append({
                "term": entry["term"],
                "total": entry["total"],
                "counts": {str(y): n for y, n in sorted(counts.items())},
                "stats": _term_stats(counts),
                "base": in_base,
                "recent": in_recent,
                "delta": round(delta * 100, 3),  # percentage points of corpus share
                "_counts": counts,
            })

        # Newcomers: terms whose first appearance is recent. The rising/fading columns
        # structurally cannot surface these — a term that did not exist in the base
        # window has nothing to have risen from, and the MIN_TOTAL floor excludes most
        # of them anyway.
        arrivals = [
            {"term": s["term"], "first": s["stats"].get("first"),
             "total": s["total"], "recent": s["recent"]}
            for s in shaped
            if s["stats"].get("first", 0) >= max_year - NEWCOMER_MAX_AGE
            and s["total"] >= MIN_TOTAL_FOR_NEWCOMER
        ]
        arrivals.sort(key=lambda a: (-a["recent"], -a["total"]))
        newcomers[dim] = arrivals[:12]

        scored_bursts = []
        for s in shaped:
            burst = _burst(s["_counts"], corpus, s["total"], corpus_total)
            if burst:
                scored_bursts.append({"term": s["term"], **burst})
        scored_bursts.sort(key=lambda b: -b["z"])
        bursts[dim] = scored_bursts[:12]

        if dim in ("keywords", "subjects"):
            ranked_for_leadlag.extend(shaped)

        out[dim] = [{k: v for k, v in s.items() if k != "_counts"} for s in shaped]

    out["newcomers"] = newcomers
    out["bursts"] = bursts
    ranked_for_leadlag.sort(key=lambda s: -s["total"])
    out["leadlag"] = _lead_lag(ranked_for_leadlag, corpus)
    return out


# ── Per-term detail ───────────────────────────────────────────────────────────

def _top(counter: Counter, limit: int) -> list[dict]:
    return [{"term": term, "n": n} for term, n in counter.most_common(limit)]


def trend_detail(manifest: dict, dim: str, term: str, limit: int = 12,
                 windows: dict | None = None) -> dict:
    """One term's context: what it travels with, who owns it, and its papers.

    Answers the question the line chart raises but cannot settle — *why* did this
    rise. Co-occurrence is reported per window so a shifting neighbourhood is
    visible, and the author/journal splits show whether a topic changed hands or
    changed venue.
    """
    if dim not in DIM_CAPS:
        raise ValueError(f"unknown dimension: {dim}")
    needle = term.strip().lower()
    if not needle:
        raise ValueError("empty term")

    dated_years = [
        record_year(r) for r in (manifest or {}).values() if isinstance(r, dict)
    ]
    dated_years = [y for y in dated_years if y is not None]
    if not dated_years:
        return {"dim": dim, "term": term, "papers": [], "cooccur": {},
                "authors": {}, "journals": {}, "total": 0}
    max_year = max(dated_years)
    if windows:
        recent = tuple(windows.get("recent") or (max_year - RECENT_SPAN + 1, max_year))
        base = tuple(windows.get("base") or (recent[0] - BASE_SPAN, recent[0] - 1))
    else:
        recent = (max_year - RECENT_SPAN + 1, max_year)
        base = (recent[0] - BASE_SPAN, recent[0] - 1)

    co_all: Counter = Counter()
    co_recent: Counter = Counter()
    co_base: Counter = Counter()
    cross: dict[str, Counter] = defaultdict(Counter)
    authors_recent: Counter = Counter()
    authors_base: Counter = Counter()
    journals_recent: Counter = Counter()
    journals_base: Counter = Counter()
    papers: list[dict] = []
    display = term.strip()
    total = 0

    for filename, record in (manifest or {}).items():
        if not isinstance(record, dict):
            continue
        terms = record_terms(record)
        hit = next((t for t in terms[dim] if t.lower() == needle), None)
        if hit is None:
            continue
        display = hit
        total += 1
        year = record_year(record)

        for other in terms[dim]:
            if other.lower() == needle:
                continue
            co_all[other] += 1
            if year is not None and base[0] <= year <= base[1]:
                co_base[other] += 1
            elif year is not None and recent[0] <= year <= recent[1]:
                co_recent[other] += 1
        for other_dim, values in terms.items():
            if other_dim == dim:
                continue
            for value in values:
                cross[other_dim][value] += 1

        if year is not None:
            in_base = base[0] <= year <= base[1]
            in_recent = recent[0] <= year <= recent[1]
            for author in terms["authors"]:
                if in_recent:
                    authors_recent[author] += 1
                elif in_base:
                    authors_base[author] += 1
            for journal in terms["journals"]:
                if in_recent:
                    journals_recent[journal] += 1
                elif in_base:
                    journals_base[journal] += 1

        papers.append({
            "filename": filename,
            "title": (record.get("title") or "").strip(),
            "year": year,
            "journal": (record.get("container_title") or "").strip(),
            "authors": terms["authors"][:3],
        })

    papers.sort(key=lambda p: (-(p["year"] or 0), p["title"]))
    return {
        "dim": dim,
        "term": display,
        "total": total,
        "windows": {"base": list(base), "recent": list(recent)},
        "cooccur": {
            "all": _top(co_all, limit),
            "base": _top(co_base, limit),
            "recent": _top(co_recent, limit),
        },
        "cross": {d: _top(c, 8) for d, c in cross.items() if d != "types"},
        "authors": {"base": _top(authors_base, 8), "recent": _top(authors_recent, 8)},
        "journals": {"base": _top(journals_base, 8), "recent": _top(journals_recent, 8)},
        "papers": papers[:60],
    }
