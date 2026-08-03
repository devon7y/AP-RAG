#!/usr/bin/env python3
"""
repair_manifest_mismatches.py — re-resolve manifest records whose author disagrees
with the (trustworthy) filename, documented in docs/MANIFEST_AUTHOR_MISMATCHES.md.

Strategy per flagged record (author absent from the record, strict detector):
  1. DOI(s) found in the PDF text -> Crossref -> keep if the record's author matches
     the filename surname AND the Crossref title overlaps the PDF text.
  2. else Crossref author+year search, each candidate ranked by title-token overlap
     with the PDF text (the real paper's title always appears in its own PDF).
Apply ONLY author-verified + title-confirmed matches (conf >= APPLY). Everything else
is LEFT UNTOUCHED and written to a review list (policy chosen by the user 2026-08-02:
"repair + keep unresolvable").

Non-destructive: writes <manifest>.repaired.json + a JSON report; it does NOT overwrite
the live manifest (a separate, reviewed step does that).

Run:  python scripts/repair_manifest_mismatches.py
"""
import json, re, sys, time, threading, unicodedata
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_apa_manifest as B  # noqa: E402

PAPERS   = Path("/Users/devon7y/Papers")
MANIFEST = "data/papers_metadata.json"
OUT      = "data/papers_metadata.repaired.json"
CR_CACHE = "data/cache/.crossref_full_cache.json"
SE_CACHE = "data/cache/.crossref_search_cache.json"
REPORT   = sys.argv[1] if len(sys.argv) > 1 else "data/state/repair_report.json"
MAILTO   = "dyanitsk@ualberta.ca"
APPLY    = 0.60          # min confidence to auto-apply (author-verified + title-confirmed)

FOLD = [('ł','l'),('ı','i'),('ø','o'),('đ','d'),('ð','d'),('þ','th'),
        ('œ','oe'),('æ','ae'),('ß','ss'),('oe','o'),('ue','u'),('ae','a'),('ss','s')]
def fold(s):
    s = unicodedata.normalize('NFKD', str(s or ''))
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    for a, b in FOLD:
        s = s.replace(a, b)
    return re.sub(r'[^a-z]', '', s)

STOP = {'the','a','an','of','and','in','on','for','to','with','from','by','via','using',
        'study','studies','review','effect','effects','role','evidence','model','models'}
def toks(s):
    return {w for w in re.findall(r'[a-z]{3,}', str(s or '').lower()) if w not in STOP}

def overlap(title, ptoks):
    t = toks(title)
    return (len(t & ptoks) / len(t)) if t else 0.0

def fn_parts(fn):
    stem = fn.rsplit('.pdf', 1)[0]
    ym = re.search(r'((?:19|20)\d\d)', stem)
    return stem.split('_')[0], (ym.group(1) if ym else '')

def author_match(authors, fn_surname):
    fa = fold(fn_surname)
    if not fa:
        return False
    for a in authors or []:
        f = fold(a.get('family', '') if isinstance(a, dict) else a)
        if f and (fa == f or fa in f or f in fa):
            return True
    return False

def cr_title(item):
    t = item.get('title')
    return (t[0] if isinstance(t, list) and t else (t or ''))

def crossref_search(author, year, title, cache, lock):
    key = f"{author}|{year}|{(title or '')[:80]}"
    with lock:
        if key in cache:
            return cache[key]
    params = {'query.author': author, 'rows': 20, 'mailto': MAILTO}
    if title:
        params['query.bibliographic'] = title
    if year:
        params['filter'] = f'from-pub-date:{year}-01-01,until-pub-date:{year}-12-31'
    try:
        r = requests.get("https://api.crossref.org/works", params=params, timeout=30)
        items = r.json().get('message', {}).get('items', []) if r.status_code == 200 else []
    except Exception:
        items = []
    with lock:
        cache[key] = items
    time.sleep(0.15)
    return items

MOJI = re.compile(r'[ÃÂÅÐÑâ€™ Â]|[0-9~?]')
ORG  = re.compile(r'\b(inc|association|team|group|society|university|committee|'
                  r'department|laborator|institute|corp|company|press)\b', re.I)

def category(fn, rec):
    """Classify an UNRESOLVED record for the review list."""
    surname, _ = fn_parts(fn)
    fams = [a.get('family', '') for a in (rec.get('authors') or []) if isinstance(a, dict)]
    # correct special-char name (extended fold matches) & clean unicode -> false positive
    if any(fold(surname) and (fold(surname) == fold(f) or fold(surname) in fold(f)
                              or fold(f) in fold(surname)) for f in fams):
        raw = ' '.join(fams)
        return 'MOJIBAKE' if MOJI.search(raw) else 'FALSE_POSITIVE'
    if any(ORG.search(f) for f in fams):
        return 'CORPORATE'
    if any(MOJI.search(f) for f in fams):
        return 'GARBLED_NAME'
    return 'WRONG_UNRESOLVED'

def is_corrupt_name(s):
    """Detect a garbled author string (mojibake / OCR), NOT legitimate diacritics."""
    if re.search(r'[0-9~?]', s):        # digits/tilde/question mark never belong in a surname
        return True
    if re.search(r'[ÃÂ].', s):          # mojibake bigram lead (SpÃ¼ler, BraÂzdil)
        return True
    if 'β' in s:                        # greek beta mis-OCR of ß (Gleiβner)
        return True
    return False

def clean_false_positive(fn, rec):
    """True if the record's author already matches the filename under extended folding
    and the name string is clean — i.e. a detector false positive (leave untouched)."""
    surname, _ = fn_parts(fn)
    fs = fold(surname)
    if not fs:
        return False
    for a in (rec.get('authors') or []):
        fam = a.get('family', '') if isinstance(a, dict) else a
        if not fam:
            continue
        ff = fold(fam)
        if ff and (fs == ff or fs in ff or ff in fs) and not is_corrupt_name(fam):
            return True
    return False

def resolve(fn, rec, crc, sec, lock):
    surname, year = fn_parts(fn)
    p = PAPERS / fn
    txt = B._first_pages_text(p, pages=3) if p.exists() else ""
    ptoks = toks(txt)
    cands = []  # (record, conf, why)
    # (0) the record's OWN doi — authoritative + clean fields/order; fixes DOI-backed
    #     garbled names. Only sticks if Crossref's author matches the filename (a wrong
    #     scraped doi resolves to a non-matching author and is discarded here).
    orig_has_doi = bool((rec.get('doi') or '').strip())
    # Every applied repair must be title-confirmed against the PDF text; a repair with no
    # PDF to verify against is not auto-applied (falls through to review).
    own = (rec.get('doi') or '').strip()
    if own and ptoks:
        cr = B.crossref_full(own, MAILTO, crc, lock)
        if cr and author_match(cr.get('authors'), surname):
            ov = overlap(cr.get('title'), ptoks)
            if ov >= 0.5:        # the record's own doi must actually match this PDF
                cands.append((cr, 0.95, f"own-doi {own} ov={ov:.2f}"))
    if ptoks:
        seen = set()
        for d in re.findall(r'10\.\d{4,9}/[-._;()/:A-Za-z0-9]+', txt):
            d = d.rstrip('.,;)')
            if d in seen:
                continue
            seen.add(d)
            cr = B.crossref_full(d, MAILTO, crc, lock)
            if cr and author_match(cr.get('authors'), surname):
                ov = overlap(cr.get('title'), ptoks)
                if ov >= 0.5:    # else it may be a cited reference's doi, not this paper
                    cands.append((cr, 0.9, f"pdf-doi {d} ov={ov:.2f}"))
    if ptoks:
        # A DOI-backed original is likely the right paper (maybe a garbled name); only a
        # near-perfect title match may override it. A no-DOI original is ~9x more likely wrong.
        smin = 0.95 if orig_has_doi else 0.75
        titles = ([rec['title']] if rec.get('title') else []) + [""]
        for t in titles:
            for it in crossref_search(surname, year, t, sec, lock):
                if not author_match(it.get('author'), surname):
                    continue
                ov = overlap(cr_title(it), ptoks)
                if ov >= smin:
                    cr = B.crossref_to_record(it, (it.get('DOI') or ''))
                    cands.append((cr, min(0.90, 0.40 + ov / 2), f"search ov={ov:.2f}"))
    # (3) name-only fix: a clean latin-1 mojibake of the CORRECT record (right paper, the
    #     author string is just double-encoded). Unambiguous — keep the record, decode names.
    def _dec(s):
        try:
            d = s.encode('latin-1').decode('utf-8')
            return d if (d != s and not is_corrupt_name(d)) else None
        except Exception:
            return None
    fams = [a.get('family', '') for a in (rec.get('authors') or []) if isinstance(a, dict)]
    if any(_dec(f) and (fold(surname) == fold(_dec(f)) or fold(surname) in fold(_dec(f))
                        or fold(_dec(f)) in fold(surname)) for f in fams if f):
        newrec = json.loads(json.dumps(rec))
        for a in newrec.get('authors') or []:
            if isinstance(a, dict):
                for k in ('family', 'given'):
                    if a.get(k) and _dec(a[k]):
                        a[k] = _dec(a[k])
        cands.append((newrec, 0.70, "name-decode(mojibake)"))
    if not cands:
        return None
    cands.sort(key=lambda c: -c[1])
    return cands[0]

def norm(s):  # strict detector from the doc
    s = unicodedata.normalize('NFKD', str(s or ''))
    s = ''.join(c for c in s if not unicodedata.combining(c)).lower()
    for a, b in (('oe','o'), ('ue','u'), ('ae','a'), ('ss','s')):
        s = s.replace(a, b)
    return re.sub(r'[^a-z]', '', s)

def flagged_set(m):
    out = []
    for fn, r in sorted(m.items()):
        fams = [a.get('family','') for a in (r.get('authors') or [])
                if isinstance(a, dict) and a.get('family')]
        if not fams:
            continue
        fa = norm(fn.rsplit('.pdf', 1)[0].split('_')[0])
        if not any(fa == norm(f) or fa in norm(f) or norm(f) in fa for f in fams):
            out.append(fn)
    return out

def main():
    m = json.load(open(MANIFEST))
    crc = B._load(CR_CACHE)
    sec = B._load(SE_CACHE) if Path(SE_CACHE).exists() else {}
    lock = threading.Lock()
    flags = flagged_set(m)
    print(f"flagged: {len(flags)}", flush=True)

    applied, accepted, review = [], [], []
    for i, fn in enumerate(flags, 1):
        rec = m[fn]
        old_author = (rec.get('authors') or [{}])[0].get('family', '?')
        # (0) already-correct special-char record -> leave untouched
        if clean_false_positive(fn, rec):
            accepted.append({'file': fn, 'record_author': old_author})
            print(f"  [{i}] ACCEPT {fn}: {old_author} (correct special-char name)", flush=True)
            continue
        try:
            best = resolve(fn, rec, crc, sec, lock)
        except Exception as e:
            best = None
            print(f"  [{i}] {fn}: ERROR {e!r}", flush=True)
        if best and best[1] >= APPLY:
            newrec = B.finalize_record(best[0], fn)
            new_author = (newrec.get('authors') or [{}])[0].get('family', '?')
            m[fn] = newrec
            applied.append({'file': fn, 'old_author': old_author, 'new_author': new_author,
                            'new_title': newrec.get('title',''), 'doi': newrec.get('doi',''),
                            'conf': round(best[1], 2), 'why': best[2],
                            'verify': best[1] < 0.62})
            tag = " (VERIFY)" if best[1] < 0.62 else ""
            print(f"  [{i}] APPLY {fn}: {old_author} -> {new_author}  ({best[2]}){tag}", flush=True)
        else:
            cat = category(fn, rec)
            review.append({'file': fn, 'record_author': old_author,
                           'record_title': rec.get('title',''),
                           'doi': rec.get('doi',''), 'category': cat,
                           'pdf_present': (PAPERS / fn).exists()})
            print(f"  [{i}] KEEP  {fn}: {cat}", flush=True)

    B._save(CR_CACHE, crc)
    B._save(SE_CACHE, sec)
    json.dump(m, open(OUT, 'w'), indent=1, ensure_ascii=False)
    Path(REPORT).parent.mkdir(parents=True, exist_ok=True)
    json.dump({'applied': applied, 'accepted': accepted, 'review': review},
              open(REPORT, 'w'), indent=1, ensure_ascii=False)
    from collections import Counter
    nver = sum(1 for a in applied if a['verify'])
    print(f"\nAPPLIED {len(applied)} ({nver} low-conf/verify) | ACCEPT {len(accepted)} | KEEP {len(review)}")
    print("review categories:", dict(Counter(r['category'] for r in review)))
    print(f"wrote: {OUT}  and  {REPORT}")

if __name__ == "__main__":
    main()
