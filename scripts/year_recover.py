#!/usr/bin/env python3
"""Recover the 143 vision-pass leftovers that had a confident AUTHOR but no
YEAR. Pull the year from: (1) a DOI in the PDF -> Crossref (also authoritative
first author), or (2) an arXiv ID in the filename (YYMM -> 20YY). Build the
canonical name from the vision author-count + recovered year, verify, merge.

    python3 year_recover.py [--go]
"""
import json, os, re, sys
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn
import llm_rename as L

DIR = Path("/Users/devon7y/Papers_needs_renaming")
PAPERS = Path("/Users/devon7y/Papers")
KEY = os.environ["OPENAI_API_KEY"]
GO = "--go" in sys.argv

st = json.load(open(".batch_rename_pnr_vision.json")); cmap = st["map"]
j = requests.get(f"https://api.openai.com/v1/batches/{st['batch_id']}",
                 headers={"Authorization": f"Bearer {KEY}"}, timeout=30).json()
out = requests.get(f"https://api.openai.com/v1/files/{j['output_file_id']}/content",
                   headers={"Authorization": f"Bearer {KEY}"}, timeout=300).text
res = {}
for line in out.splitlines():
    if not line.strip(): continue
    o = json.loads(line)
    try: res[cmap[o["custom_id"]]] = json.loads(o["response"]["body"]["choices"][0]["message"]["content"])
    except Exception: pass

def arxiv_year(name):
    m = re.search(r'(?<!\d)(\d{2})(\d{2})\.\d{4,5}(?!\d)', name)
    if not m: return None
    mm = int(m.group(2))
    if not (1 <= mm <= 12): return None
    return f"20{m.group(1)}"

def filename_year(name):
    """A plausible publication year in the filename (1950-2026), as a standalone
    number (not embedded in a longer digit run like an ACM/DOI article id)."""
    ys = [y for y in re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)', name)
          if 1950 <= int(y) <= 2026]
    return ys[-1] if ys else None   # trailing year is usually the pub year

manual = [l.split("\t")[0] for l in open("batch_rename_pnr_vision_manual.tsv") if l.strip()]
taken = {p.name.lower() for p in PAPERS.iterdir() if p.suffix.lower() == ".pdf"}
cache = {}
apply, still = [], []
for fn in manual:
    r = res.get(fn); src = DIR / fn
    if not src.exists(): continue
    if not r or not r.get("is_citable_work") or not r.get("first_author_surname") \
            or r.get("confidence") == "low":
        still.append((fn, "no-confident-author")); continue
    text = L.first_pages_text(src, pages=2)
    a1 = vpn.ascii_name(r["first_author_surname"])
    try: n = int(r.get("num_authors") or 0)
    except (TypeError, ValueError): n = 0
    a2 = vpn.ascii_name(r.get("second_author_surname", "") or "")
    year = None; ysrc = ""
    m = vpn.DOI_RE.search(text)
    if m:
        rec = vpn.crossref_lookup(m.group(0).rstrip(".,;)"), "devon7y@gmail.com", cache)
        if rec and rec.get("year"):
            year = rec["year"]; ysrc = "crossref"
            if rec.get("family"): a1 = vpn.ascii_name(rec["family"])
    if not year:
        ay = arxiv_year(fn)
        if ay: year, ysrc = ay, "arxiv-id"
    if not year:
        fy = filename_year(fn)
        if fy: year, ysrc = fy, "filename-year"
    if not year:
        still.append((fn, "no-year-found")); continue
    if n >= 3 or (n == 2 and not a2):
        cand = vpn.canonical_name(a1, "Etal", year)
    elif n == 2:
        cand = vpn.canonical_name(a1, a2, year)
    else:
        cand = vpn.canonical_name(a1, "", year)
    if len(text.strip()) >= 200 and a1 and vpn.surname_in_text(a1, text) == "no":
        still.append((fn, f"author {a1} not in text")); continue
    t = taken.copy(); t.discard(fn.lower())
    cand = L.free_disambiguated(cand, t); taken.add(cand.lower())
    apply.append((fn, cand, ysrc))

print(f"year-recovery: recovered {len(apply)} | still manual {len(still)}")
from collections import Counter
print("  by year source:", dict(Counter(s for *_, s in apply)))
print("  sample:")
for o, nm, s in apply[:18]: print(f"    {o[:38]:<40} -> {nm}  [{s}]")
if GO:
    import shutil
    log = DIR / "year_recover.log"; k = 0
    with open(log, "a") as lf:
        for o, nm, s in apply:
            sp = DIR / o; d = PAPERS / nm
            if not sp.exists() or d.exists(): continue
            shutil.move(str(sp), str(d)); lf.write(f"{o}\t{nm}\t{s}\n"); k += 1
    open("year_recover_still_manual.tsv", "w").write("\n".join(f"{o}\t{w}" for o, w in still) + "\n")
    print(f"\nmerged {k} into Papers/; {len(still)} still manual. log: {log}")
else:
    print("\n(dry run; --go to merge)")
