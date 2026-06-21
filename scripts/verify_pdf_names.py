#!/usr/bin/env python3
"""Verify that PDFs follow the AP-RAG citation-style naming scheme AND that the
name actually matches the paper's content.

Canonical filename scheme (see the `academic-pdfs` skill):

    Author_YYYY.pdf                one author
    Author1_Author2_YYYY.pdf       two authors
    Author1_Etal_YYYY.pdf          three or more authors

  * `Author` = first author's family name only (internal hyphens kept).
  * `Etal` literally (never `et_al`, `EtAl`, `et al`).
  * Year is 4 digits, optionally a lowercase disambiguation letter (`2011a`).

Two independent layers of checking:

  1. FORMAT  -- does the *filename* match the scheme? (instant, no PDF parse)
  2. CONTENT -- does the name match the actual paper?
       offline: is the filename's first-author surname present on page 1, and
                does the filename year appear in the document / its metadata?
       online (--online): if a DOI is found in the PDF, resolve it via Crossref
                and compare the authoritative first-author family name + year.

The content layer is deliberately conservative: it only calls something a
MISMATCH when it has a positive contradicting signal (Crossref disagreement, or
the surname is clearly absent from a PDF that *does* have a text layer). PDFs it
cannot read (image-only scans, encrypted) are reported UNVERIFIABLE, never wrong.

Optionally it can FIX the high-confidence cases. `--fix` writes a reviewable
`rename_map.tsv` (safe, computable renames: style reformats of verified names,
Crossref-confirmed author typos, Crossref year corrections) plus a
`rename_review.tsv` (everything that needs a human decision, with a best-guess
name). It changes nothing on disk. `--apply` then executes a (possibly hand-
edited) map with collision/missing-source guards, case-only-rename handling, and
an append-only `rename_applied.log`.

Usage:
    python3 verify_pdf_names.py [DIR] [--online] [--report report.csv]
                                [--jobs N] [--only-flagged]
    python3 verify_pdf_names.py [DIR] --online --fix      # write rename_map.tsv
    python3 verify_pdf_names.py [DIR] --apply rename_map.tsv   # rename on disk

Default DIR is /Users/devon7y/Papers.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from pathlib import Path

# --------------------------------------------------------------------------- #
# Filename grammar
# --------------------------------------------------------------------------- #
SURNAME = r"[A-Za-z][A-Za-z'-]*"
YEAR = r"[0-9]{4}[a-z]?"
# Author_YYYY  |  Author1_Author2_YYYY  |  Author1_Etal_YYYY
CANONICAL_RE = re.compile(
    rf"^(?P<a1>{SURNAME})(?:_(?P<a2>{SURNAME}))?_(?P<year>{YEAR})\.pdf$"
)
DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>)\]]+", re.IGNORECASE)
YEAR_RE = re.compile(r"\b(?:18|19|20)\d{2}\b")
# Things that look like supplements / duplicates rather than the paper itself.
# Note: must NOT match a bare `_YYYY.pdf` ending -- a copy marker is an *extra*
# token *after* the year (`Levin_2010_2.pdf`) or an explicit supplement word.
DUP_SUFFIX_RE = re.compile(
    r"(_\d{4}[a-z]?_\d+|\s*\(\d+\)|[_-](?:suppl|supplementary|supplement|"
    r"appendix|online))(?=\.pdf$)",
    re.IGNORECASE,
)
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")


def fold(s: str) -> str:
    """Lowercase, strip accents, drop everything but letters."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", s.lower())


def surname_in_text(surname: str, text: str) -> str | None:
    """Whole-word (token) test for a surname in page text.

    Returns "yes"/"no", or None when the surname is too short to test reliably
    (2 letters -- substring/token matching collides with common words like
    "an"/"he", so we decline rather than guess).
    """
    forms = {fold(surname), fold(surname.replace("-", ""))}
    for part in surname.split("-"):
        forms.add(fold(part))
    forms = {f for f in forms if f}
    if not forms or min(len(f) for f in forms) <= 2:
        return None
    tokens = {fold(t) for t in TOKEN_RE.findall(text)}
    tokens.discard("")
    if forms & tokens:
        return "yes"
    # Fallback for glued multi-word surnames in the filename (e.g.
    # "RodriguezDominguez" vs the byline's "Rodriguez Dominguez"): a long exact
    # substring of the accent-folded, letters-only text is specific enough to
    # trust without reintroducing the "berg in iceberg" problem (>=7 chars).
    blob = fold(text)
    if any(len(f) >= 7 and f in blob for f in forms):
        return "yes"
    return "no"


# --------------------------------------------------------------------------- #
# Name construction (for --fix)
# --------------------------------------------------------------------------- #
def ascii_name(s: str) -> str:
    """ASCII-safe surname: strip accents, keep letters and internal hyphens,
    preserve case (unlike fold())."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^A-Za-z-]", "", s)
    return s.strip("-")


def titlecase_surname(s: str) -> str:
    return "-".join(p.capitalize() for p in s.split("-") if p)


def canonical_name(a1: str, a2: str, year: str) -> str:
    return f"{a1}_{a2}_{year}.pdf" if a2 else f"{a1}_{year}.pdf"


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                           prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# --------------------------------------------------------------------------- #
# Result record
# --------------------------------------------------------------------------- #
@dataclass
class Result:
    filename: str
    verdict: str = "OK"                 # OK | FORMAT | SUSPECT | MISMATCH | UNVERIFIABLE
    format_ok: bool = False
    fn_author: str = ""
    fn_author2: str = ""
    fn_year: str = ""
    style_flags: list[str] = field(default_factory=list)
    has_text: bool = False
    author_on_p1: str = ""             # yes | no | "" (unknown)
    year_in_doc: str = ""              # yes | no | "" (unknown)
    doc_years: str = ""
    doi: str = ""
    cr_author: str = ""
    cr_year: str = ""
    notes: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# PDF text / metadata extraction (poppler)
# --------------------------------------------------------------------------- #
def pdf_text(path: Path, pages: int = 2) -> str:
    try:
        out = subprocess.run(
            ["pdftotext", "-f", "1", "-l", str(pages), "-layout", str(path), "-"],
            capture_output=True, timeout=60,
        )
        return out.stdout.decode("utf-8", "ignore")
    except Exception:
        return ""


def pdf_info(path: Path) -> dict[str, str]:
    try:
        out = subprocess.run(
            ["pdfinfo", str(path)], capture_output=True, timeout=30
        ).stdout.decode("utf-8", "ignore")
    except Exception:
        return {}
    info: dict[str, str] = {}
    for line in out.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            info[k.strip()] = v.strip()
    return info


# --------------------------------------------------------------------------- #
# Crossref (online, opt-in)
# --------------------------------------------------------------------------- #
def crossref_lookup(doi: str, mailto: str, cache: dict) -> dict | None:
    doi = doi.rstrip(".,;").lower()
    if doi in cache:
        return cache[doi]
    import requests
    try:
        r = requests.get(
            f"https://api.crossref.org/works/{doi}",
            params={"mailto": mailto},
            headers={"User-Agent": f"aprag-verify/1.0 (mailto:{mailto})"},
            timeout=20,
        )
        if r.status_code != 200:
            cache[doi] = None
            return None
        msg = r.json().get("message", {})
        authors = msg.get("author") or []
        family = ""
        for a in authors:
            if a.get("sequence") == "first" and a.get("family"):
                family = a["family"]
                break
        if not family and authors:
            family = authors[0].get("family", "")
        year = ""
        for key in ("published-print", "published-online", "issued", "published",
                    "created"):
            dp = (msg.get(key) or {}).get("date-parts") or []
            if dp and dp[0] and dp[0][0]:
                year = str(dp[0][0])
                break
        rec = {"family": family, "year": year}
        cache[doi] = rec
        return rec
    except Exception:
        cache[doi] = None
        return None


# --------------------------------------------------------------------------- #
# Per-file analysis
# --------------------------------------------------------------------------- #
def analyze(path: Path, online: bool, mailto: str, cache: dict) -> Result:
    name = path.name
    res = Result(filename=name)

    m = CANONICAL_RE.match(name)
    if not m:
        res.format_ok = False
        res.verdict = "FORMAT"
        res.notes.append("filename does not match Author[_Author|_Etal]_YYYY scheme")
        if DUP_SUFFIX_RE.search(name):
            res.style_flags.append("looks-like-duplicate-or-supplement")
        return res

    res.format_ok = True
    a1 = m.group("a1")
    a2 = m.group("a2") or ""
    res.fn_author = a1
    res.fn_author2 = a2
    res.fn_year = m.group("year")

    # ---- style flags (conforming, but stylistically off) ----
    low2 = a2.lower()
    if a2 and low2 == "etal" and a2 != "Etal":
        res.style_flags.append(f"noncanonical-etal:{a2}")
    if a2 and low2 in ("et", "etals", "etall"):
        res.style_flags.append(f"suspect-etal:{a2}")
    if a1.isupper() and len(a1) > 1:
        res.style_flags.append("allcaps-surname")
    if "etal" in a1.lower() and a1.lower() != "etal":
        res.style_flags.append("glued-etal (use Author_Etal_YYYY)")
    if DUP_SUFFIX_RE.search(name):
        res.style_flags.append("looks-like-duplicate-or-supplement")

    # ---- gather evidence from the PDF ----
    text = pdf_text(path)
    info = pdf_info(path)
    res.has_text = len(text.strip()) >= 40

    # author present on page 1? (whole-word match; None => too short to test)
    if res.has_text:
        hit = surname_in_text(a1, text)
        res.author_on_p1 = hit or "short"

    # year present in document text or metadata?
    fn_year_num = res.fn_year[:4]
    doc_years = set(YEAR_RE.findall(text))
    for k in ("CreationDate", "ModDate"):
        my = YEAR_RE.findall(info.get(k, ""))
        doc_years.update(my)
    res.doc_years = ",".join(sorted(doc_years))
    if doc_years:
        near = any(abs(int(y) - int(fn_year_num)) <= 1 for y in doc_years)
        res.year_in_doc = "yes" if near else "no"

    # DOI
    doi_m = DOI_RE.search(text) or DOI_RE.search(info.get("Subject", "") +
                                                 " " + info.get("Keywords", ""))
    if doi_m:
        res.doi = doi_m.group(0).rstrip(".,;)")

    # ---- online authoritative check ----
    #
    # The page-1 byline is the PRIMARY evidence. A DOI scraped from page 1 may
    # belong to a cited reference or an adjacent article in a two-column scan,
    # so we only let it overrule the filename when the byline does NOT already
    # corroborate the filename author:
    #   * filename author absent from p1  -> trust the DOI's identity (mismatch)
    #   * filename author present + DOI author matches -> own DOI; check the year
    #   * filename author present + DOI author differs  -> stray DOI; ignore it
    if online and res.doi:
        rec = crossref_lookup(res.doi, mailto, cache)
        if rec and rec.get("family"):
            res.cr_author = rec["family"]
            res.cr_year = rec.get("year", "")
            fn_fold = fold(a1)
            cr_fold = fold(rec["family"])
            cr_tokens = {fold(t) for t in re.split(r"[\s'-]+", rec["family"]) if t}
            cr_tokens.discard("")
            author_match = (fn_fold == cr_fold) or (fn_fold in cr_tokens)
            year_ok = True
            if res.cr_year and fn_year_num:
                year_ok = abs(int(res.cr_year) - int(fn_year_num)) <= 1

            byline_confirms = res.author_on_p1 == "yes"

            if not byline_confirms:
                # filename author not visibly on p1 -> the DOI decides identity
                if not author_match:
                    res.verdict = "MISMATCH"
                    res.notes.append(
                        f"named author '{a1}' not on p1; DOI resolves to "
                        f"'{rec['family']}' {res.cr_year} (verify)")
                    return res
                if not year_ok:
                    res.verdict = "MISMATCH"
                    res.notes.append(
                        f"DOI year {res.cr_year} != filename {fn_year_num}")
                    return res
                res.verdict = "OK"
                res.notes.append("verified via Crossref DOI")
                return res
            else:
                # byline matches filename author
                if author_match:
                    if not year_ok:
                        res.verdict = "MISMATCH"
                        res.notes.append(
                            f"author ok; DOI year {res.cr_year} != "
                            f"filename {fn_year_num}")
                        return res
                    res.verdict = "OK"
                    res.notes.append("verified via Crossref DOI")
                    return res
                # author on page 1 but DOI points elsewhere -> cited ref / scan
                res.notes.append(
                    f"ignored stray DOI {res.doi} (resolves to "
                    f"'{rec['family']}'; byline confirms '{a1}')")
                res.doi = ""  # don't let a citation DOI pollute the report
                # fall through to the offline verdict (author present -> OK)

    # ---- offline verdict ----
    if not res.has_text:
        res.verdict = "UNVERIFIABLE"
        res.notes.append("no extractable text layer (scanned/encrypted?)")
        return res

    if res.author_on_p1 == "short":
        # surname too short to test by token match; can't confirm offline
        res.verdict = "UNVERIFIABLE"
        res.notes.append("first-author surname too short to verify offline "
                         "(run with --online for a DOI check)")
        return res

    if res.author_on_p1 == "no":
        # strongest offline mismatch signal: the named author is nowhere on p1
        res.verdict = "SUSPECT"
        res.notes.append("first-author surname not found on page 1 "
                         "(likely a different paper)")
        if res.year_in_doc == "no":
            res.notes.append(f"filename year {fn_year_num} also absent from document")
        return res

    # Author present -> name looks right. A missing year is only a soft note
    # (reprints, scans, and front-matter often omit the publication year on p1).
    res.verdict = "OK"
    if res.year_in_doc == "no":
        res.notes.append(f"author ok, but filename year {fn_year_num} not "
                         "found in document (reprint/scan?) -- low priority")
    return res


# --------------------------------------------------------------------------- #
# Fix proposals (--fix)
# --------------------------------------------------------------------------- #
def propose_fix(res: "Result") -> tuple[str, str, str, bool] | None:
    """Return (new_name, tier, reason, auto) or None.

    auto=True  -> safe to put in the apply-able rename_map.tsv
    auto=False -> goes to rename_review.tsv only (needs a human glance)
    """
    src = res.filename
    a1, a2, yr = res.fn_author, res.fn_author2, res.fn_year

    # ---- Crossref-authoritative corrections (only when --online found a DOI) --
    if res.verdict == "MISMATCH" and res.cr_author:
        cr_fam = ascii_name(res.cr_author)
        cr_tokens = {fold(t) for t in re.split(r"[\s'-]+", res.cr_author) if t}
        author_match = fold(a1) == fold(res.cr_author) or fold(a1) in cr_tokens
        if author_match and res.cr_year:           # only the year is wrong
            dst = canonical_name(a1, a2, res.cr_year)
            if dst != src:
                return (dst, "crossref-year",
                        f"year {yr}->{res.cr_year} (author confirmed)", True)
            return None
        dist = levenshtein(fold(a1), fold(res.cr_author))
        if cr_fam and dist <= 3:                    # spelling typo
            dst = canonical_name(cr_fam, a2, yr)
            if dst != src:
                return (dst, "crossref-typo",
                        f"author '{a1}'->'{cr_fam}' (edit dist {dist})", True)
            return None
        if cr_fam:                                  # gross mismatch: review only
            dst = canonical_name(cr_fam, a2, res.cr_year or yr)
            return (dst, "crossref-gross",
                    f"named '{a1}' absent; DOI -> {res.cr_author} "
                    f"{res.cr_year} (verify; co-author count is a guess)", False)
        return None

    # ---- pure style reformat of a content-verified name ----
    if res.format_ok and res.verdict == "OK" and res.style_flags:
        new_a1, new_a2 = a1, a2
        if any(f.startswith("glued-etal") for f in res.style_flags):
            m = re.match(r"^(.*?)(?:EtAl|Etal|etal)$", a1)
            if m and m.group(1):
                new_a1, new_a2 = m.group(1), "Etal"
        if new_a1.isupper() and len(new_a1) > 1:
            new_a1 = titlecase_surname(new_a1)
        if new_a2:
            if new_a2.lower() == "etal":
                new_a2 = "Etal"
            elif new_a2.isupper() and len(new_a2) > 1:
                new_a2 = titlecase_surname(new_a2)
        dst = canonical_name(new_a1, new_a2, yr)
        if dst != src:
            return (dst, "style", ";".join(res.style_flags), True)

    return None


def apply_map(map_path: Path, root: Path) -> int:
    """Apply a tab-separated old<TAB>new rename map with safety checks."""
    pairs: list[tuple[str, str]] = []
    for line in map_path.read_text().splitlines():
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) < 2 or not cols[0] or not cols[1]:
            continue
        if cols[0] == "old_name":          # header
            continue
        pairs.append((cols[0], cols[1]))

    # collision detection within the map
    dsts = [d for _, d in pairs]
    dupes = {d for d in dsts if dsts.count(d) > 1}
    if dupes:
        print("ERROR: target names collide within the map:", file=sys.stderr)
        for d in sorted(dupes):
            print(f"  {d}", file=sys.stderr)
        return 2

    applied = skipped = 0
    log_lines = []
    for src, dst in pairs:
        sp, dp = root / src, root / dst
        if src == dst:
            continue
        if not sp.exists():
            print(f"SKIP missing   {src}")
            skipped += 1
            continue
        case_only = src.lower() == dst.lower()
        if dp.exists() and not case_only:
            print(f"SKIP collision {src}  ->  {dst} (target exists)")
            skipped += 1
            continue
        tmp = root / (src + ".rename_tmp")
        try:
            os.rename(sp, tmp)
            os.rename(tmp, dp)
        except OSError as e:
            print(f"SKIP error     {src}: {e}")
            if tmp.exists():
                os.rename(tmp, sp)
            skipped += 1
            continue
        print(f"RENAMED        {src}  ->  {dst}")
        log_lines.append(f"{src}\t{dst}")
        applied += 1

    if log_lines:
        log = root / "rename_applied.log"
        with open(log, "a") as f:
            f.write("\n".join(log_lines) + "\n")
        print(f"\napplied {applied}, skipped {skipped}. Log: {log}")
    else:
        print(f"\napplied {applied}, skipped {skipped}.")
    return 0


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("directory", nargs="?", default="/Users/devon7y/Papers")
    ap.add_argument("--online", action="store_true",
                    help="resolve DOIs via Crossref for authoritative checking")
    ap.add_argument("--mailto", default=os.environ.get("CROSSREF_MAILTO",
                                                       "devon7y@gmail.com"))
    ap.add_argument("--jobs", type=int, default=min(16, (os.cpu_count() or 4) * 2))
    ap.add_argument("--report", default="pdf_name_report.csv")
    ap.add_argument("--cache", default=".crossref_cache.json")
    ap.add_argument("--only-flagged", action="store_true",
                    help="print only non-OK files")
    ap.add_argument("--fix", action="store_true",
                    help="write a reviewable rename_map.tsv of safe fixes "
                         "(+ rename_review.tsv); changes nothing on disk")
    ap.add_argument("--apply", metavar="MAP", nargs="?", const="rename_map.tsv",
                    help="apply a rename map (default rename_map.tsv); this "
                         "renames files on disk")
    ap.add_argument("--map-out", default="rename_map.tsv")
    ap.add_argument("--review-out", default="rename_review.tsv")
    args = ap.parse_args()

    root = Path(args.directory).expanduser()
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 2

    # --apply short-circuits: just execute an existing map, no scanning.
    if args.apply:
        map_path = Path(args.apply).expanduser()
        if not map_path.exists():
            print(f"error: rename map {map_path} not found "
                  "(run with --fix first)", file=sys.stderr)
            return 2
        print(f"Applying {map_path} to {root} ...")
        return apply_map(map_path, root)

    pdfs = sorted(p for p in root.iterdir()
                  if p.is_file() and p.suffix.lower() == ".pdf")
    if not pdfs:
        print(f"no PDFs found in {root}", file=sys.stderr)
        return 1

    cache: dict = {}
    cache_path = Path(args.cache)
    if args.online and cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text())
        except Exception:
            cache = {}

    print(f"Scanning {len(pdfs)} PDFs in {root}"
          f"{'  [online Crossref]' if args.online else '  [offline]'} ...",
          file=sys.stderr)

    results: list[Result] = []
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        futs = {ex.submit(analyze, p, args.online, args.mailto, cache): p
                for p in pdfs}
        done = 0
        for fut in as_completed(futs):
            results.append(fut.result())
            done += 1
            if done % 100 == 0:
                print(f"  ...{done}/{len(pdfs)}", file=sys.stderr)

    if args.online:
        try:
            cache_path.write_text(json.dumps(cache))
        except Exception:
            pass

    order = {"MISMATCH": 0, "FORMAT": 1, "SUSPECT": 2, "UNVERIFIABLE": 3, "OK": 4}
    results.sort(key=lambda r: (order.get(r.verdict, 9), r.filename.lower()))

    # ---- CSV report (written to CWD by default, never into the corpus dir) ----
    report_path = Path(args.report).expanduser()
    with open(report_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["verdict", "filename", "fn_author", "fn_author2", "fn_year",
                    "author_on_p1", "year_in_doc", "doc_years", "doi",
                    "crossref_author", "crossref_year", "style_flags", "notes"])
        for r in results:
            w.writerow([r.verdict, r.filename, r.fn_author, r.fn_author2,
                        r.fn_year, r.author_on_p1, r.year_in_doc, r.doc_years,
                        r.doi, r.cr_author, r.cr_year,
                        ";".join(r.style_flags), " | ".join(r.notes)])

    # ---- summary ----
    counts: dict[str, int] = {}
    for r in results:
        counts[r.verdict] = counts.get(r.verdict, 0) + 1
    print("\n=== SUMMARY ===")
    for v in ("MISMATCH", "FORMAT", "SUSPECT", "UNVERIFIABLE", "OK"):
        if v in counts:
            print(f"  {v:<13} {counts[v]}")
    style_total = sum(1 for r in results if r.style_flags)
    if style_total:
        print(f"  (style flags on {style_total} otherwise-OK-format files)")
    print(f"\nFull report: {report_path}")

    # ---- --fix: write a reviewable rename map (+ review list); change nothing --
    if args.fix:
        auto: list[tuple[str, str, str, str]] = []   # src, dst, tier, reason
        review: list[tuple[str, str, str, str]] = []  # src, dst, verdict, reason
        for r in results:
            p = propose_fix(r)
            if p:
                dst, tier, reason, ok = p
                (auto if ok else review).append(
                    (r.filename, dst, tier if ok else r.verdict, reason))
            elif r.verdict in ("SUSPECT", "FORMAT", "UNVERIFIABLE", "MISMATCH"):
                review.append((r.filename, "", r.verdict, "; ".join(r.notes)))
        # guard: drop auto fixes whose target already exists as another file
        existing = {p.name.lower() for p in pdfs}
        safe_auto = []
        for src, dst, tier, reason in auto:
            if dst.lower() in existing and dst.lower() != src.lower():
                review.append((src, dst, "COLLISION",
                               f"{reason} -- target already exists"))
            else:
                safe_auto.append((src, dst, tier, reason))

        map_path = Path(args.map_out).expanduser()
        with open(map_path, "w") as f:
            f.write("# old_name\tnew_name\ttier\treason\n")
            f.write("# review these, delete any line you disagree with, then:\n")
            f.write(f"#   python3 {Path(__file__).name} {root} "
                    f"--apply {map_path.name}\n")
            for src, dst, tier, reason in sorted(safe_auto):
                f.write(f"{src}\t{dst}\t{tier}\t{reason}\n")
        review_path = Path(args.review_out).expanduser()
        with open(review_path, "w") as f:
            f.write("# old_name\tsuggested_new_name\tverdict\tnotes\n")
            f.write("# manual decisions -- not auto-applied. If you agree with a\n")
            f.write("# suggested_new_name, copy that line into the rename map.\n")
            for src, dst, verdict, reason in sorted(review):
                f.write(f"{src}\t{dst}\t{verdict}\t{reason}\n")

        by_tier: dict[str, int] = {}
        for _, _, tier, _ in safe_auto:
            by_tier[tier] = by_tier.get(tier, 0) + 1
        print("\n=== FIX PLAN (nothing changed yet) ===")
        print(f"  auto-fixable -> {map_path}  ({len(safe_auto)} files)")
        for tier in sorted(by_tier):
            print(f"      {tier:<16} {by_tier[tier]}")
        print(f"  manual review -> {review_path}  ({len(review)} files)")
        print(f"\n  Review the map, then apply with:\n"
              f"    python3 {Path(__file__).name} {root} --apply {map_path.name}")
        return 0

    # ---- console detail for the things that need attention ----
    print("\n=== FILES NEEDING ATTENTION ===")
    shown = 0
    for r in results:
        if r.verdict == "OK" and not r.style_flags:
            continue
        if args.only_flagged and r.verdict == "OK":
            continue
        tag = r.verdict
        extra = []
        if r.doi:
            extra.append(f"doi={r.doi}")
        if r.cr_author:
            extra.append(f"crossref={r.cr_author} {r.cr_year}")
        if r.style_flags:
            extra.append("style=" + ",".join(r.style_flags))
        note = "; ".join(r.notes)
        print(f"[{tag:<12}] {r.filename}")
        if note:
            print(f"               {note}")
        if extra:
            print(f"               {'  '.join(extra)}")
        shown += 1
    if shown == 0:
        print("  none \U0001f389")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
