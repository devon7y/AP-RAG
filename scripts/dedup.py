#!/usr/bin/env python3
"""Corpus-wide exact-content de-duplication across Papers/, Papers_needs_review/,
and Papers_vscode_to_rename/. Files with identical content are a duplicate group;
keep the best-named copy (prefer Papers/ + clean canonical name) and delete the
rest. Group by size first, then full SHA-256 only within same-size groups.

    python3 dedup.py        # dry run (preview)
    python3 dedup.py --go   # delete redundant copies
"""
import hashlib, re, sys
from collections import defaultdict
from pathlib import Path

FOLDERS = [Path("/Users/devon7y/Papers"),
           Path("/Users/devon7y/Papers_vscode_to_rename"),
           Path("/Users/devon7y/Papers_needs_review")]
RANK = {p.name: i for i, p in enumerate(FOLDERS)}   # Papers best (0)
GO = "--go" in sys.argv
CANON = re.compile(r"^[A-Za-z][A-Za-z'-]*(_[A-Za-z][A-Za-z'-]*|_Etal)?_[0-9]{4}[a-z]?\.pdf$")

def full_sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def score(p):
    """Lower = better keeper."""
    n = p.name
    pen = 0
    pen += RANK.get(p.parent.name, 9) * 100
    if re.search(r"(__\d+|_\d{1,2})\.pdf$", n): pen += 40   # _2 / __1 copy markers (NOT the _YYYY year)
    if re.search(r"_suppl\.pdf$", n, re.I): pen += 30       # raw-code supplement
    if not (CANON.match(n) or re.match(r"^.+_Supplementary\.pdf$", n)): pen += 20
    if re.search(r"\d{4}[a-z]\.pdf$", n) or re.search(r"\d{4}[a-z]_Supplementary\.pdf$", n):
        pen += 5                                            # year-suffix disambiguation (prefer the base)
    # tiebreak: prefer the FULLER surname (e.g. Kahana over the code Kaha), then lexical
    return (pen, -len(n), n)

# collect, group by size
by_size = defaultdict(list)
for fp in FOLDERS:
    if not fp.is_dir(): continue
    for p in fp.iterdir():
        if p.is_file() and p.suffix.lower() == ".pdf":
            try: by_size[p.stat().st_size].append(p)
            except OSError: pass

groups = []
for sz, paths in by_size.items():
    if len(paths) < 2: continue
    byhash = defaultdict(list)
    for p in paths: byhash[full_sha(p)].append(p)
    for hsh, grp in byhash.items():
        if len(grp) > 1: groups.append(sorted(grp, key=score))

to_delete = []
for grp in groups:
    keeper = grp[0]
    for d in grp[1:]:
        to_delete.append((d, keeper))

total = sum(1 for fp in FOLDERS if fp.is_dir() for p in fp.iterdir() if p.suffix.lower()==".pdf")
print(f"scanned {total} PDFs | duplicate groups: {len(groups)} | redundant copies to delete: {len(to_delete)}")
print("\n  sample (DELETE  ->  keep):")
for d, k in to_delete[:25]:
    print(f"    {d.parent.name}/{d.name}")
    print(f"        keep: {k.parent.name}/{k.name}")
# how many deletions per folder
from collections import Counter
print("\n  deletions by folder:", dict(Counter(d.parent.name for d, _ in to_delete)))

if GO:
    log = Path("/Users/devon7y/dedup_deleted.log"); n = 0
    with open(log, "w") as lf:
        for d, k in to_delete:
            try:
                d.unlink(); lf.write(f"{d}\tKEPT\t{k}\n"); n += 1
            except OSError as e:
                lf.write(f"ERROR\t{d}\t{e}\n")
    print(f"\ndeleted {n} duplicate copies. log: {log}")
else:
    print("\n(dry run; --go to delete the redundant copies)")
