#!/usr/bin/env python3
"""Find SAME-PAPER duplicates that differ in FORMAT (so byte-hash dedup misses
them): within each Author_Year group, files sharing a DOI are the same paper.
Keep the best version (published > author-manuscript/preprint, then denser text),
delete the rest, and rename the survivor to the base slot when free.

    python3 dedup_samepaper.py        # dry run
    python3 dedup_samepaper.py --go
"""
import re, subprocess, sys
from collections import defaultdict
from pathlib import Path

P = Path("/Users/devon7y/Papers")
GO = "--go" in sys.argv
DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"'<>)\]]+", re.I)
STEM = re.compile(r"^(?P<stem>[A-Za-z][A-Za-z'-]*(?:_[A-Za-z][A-Za-z'-]*|_Etal)?_\d{4})(?P<suf>[a-z]?)\.pdf$")
MANU = re.compile(r"author manuscript|NIH Public Access|accepted manuscript|"
                  r"author's personal copy|unedited manuscript|this is a preprint|"
                  r"PMC\s|medRxiv|bioRxiv|psyArXiv|preprint", re.I)

def text(p, n=3):
    try:
        return subprocess.run(["pdftotext", "-f", "1", "-l", str(n), "-layout", str(p), "-"],
                              capture_output=True, timeout=40).stdout.decode("utf-8", "ignore")
    except Exception:
        return ""
def doi(t):
    m = DOI_RE.search(t)
    return m.group(0).rstrip(".,;)").lower() if m else None

# group by Author_Year stem
groups = defaultdict(list)
for p in P.iterdir():
    m = STEM.match(p.name)
    if m: groups[m.group("stem")].append(p)

del_plan, rename_plan, manual = [], [], []
for stem, files in groups.items():
    if len(files) < 2: continue
    info = {}
    for f in files:
        t = text(f)
        info[f] = {"doi": doi(t), "manu": bool(MANU.search(t[:1200])),
                   "dens": len(t.strip()), "suf": STEM.match(f.name).group("suf")}
    by_doi = defaultdict(list)
    for f in files:
        if info[f]["doi"]: by_doi[info[f]["doi"]].append(f)
    for d, grp in by_doi.items():
        if len(grp) < 2: continue                          # same DOI in >=2 files = same paper
        def score(f):
            i = info[f]
            return (10 if i["manu"] else 0, i["suf"] != "", -i["dens"], f.name)
        grp.sort(key=score)
        keeper = grp[0]
        for d2 in grp[1:]:
            del_plan.append((d2, keeper, d))
        # promote keeper to the base slot if it's lettered and base is now free
        ksuf = info[keeper]["suf"]
        if ksuf:
            base = P / (stem + ".pdf")
            losers = {x for x, _, _ in del_plan}
            if (not base.exists()) or base in losers:
                rename_plan.append((keeper, base.name))

print(f"same-paper (same-DOI) duplicate sets found -> {len(del_plan)} redundant copies to delete")
print("\n  DELETE (redundant format)  ->  KEEP:")
for d, k, doi_ in sorted(del_plan, key=lambda x: x[0].name):
    print(f"    {d.name:<30}  ->  {k.name}   (DOI {doi_[:30]})")
print("\n  then PROMOTE survivor to base slot:")
for k, newname in rename_plan:
    print(f"    {k.name}  ->  {newname}")

if GO:
    log = Path("/Users/devon7y/dedup_samepaper.log"); nd = nr = 0
    losers = {d for d, _, _ in del_plan}
    with open(log, "w") as lf:
        for d, k, doi_ in del_plan:
            try: d.unlink(); lf.write(f"deleted\t{d}\tKEPT\t{k}\tDOI\t{doi_}\n"); nd += 1
            except OSError as e: lf.write(f"ERR\t{d}\t{e}\n")
        for k, newname in rename_plan:
            dst = P / newname
            if k.exists() and not dst.exists():
                k.rename(dst); lf.write(f"renamed\t{k.name}\t{newname}\n"); nr += 1
    print(f"\ndeleted {nd} redundant copies, promoted {nr} survivors. log: {log}")
else:
    print("\n(dry run; --go to apply)")
