#!/usr/bin/env python3
"""Make disambiguation letters consecutive within each Author_Year group:
keep the un-lettered base (if present) and relabel the lettered files a, b, c, …
in order, filling gaps. Already-consecutive groups are untouched. A lone file
that still carries a letter is stripped back to the un-lettered base.
Two-phase rename avoids collisions. Dry-run unless --go."""
import re, sys
from collections import defaultdict
from pathlib import Path

P = Path("/Users/devon7y/Papers")
GO = "--go" in sys.argv
STEM = re.compile(r"^(?P<stem>[A-Za-z][A-Za-z'-]*(?:_[A-Za-z][A-Za-z'-]*|_Etal)?_\d{4})(?P<suf>[a-z]?)\.pdf$")

groups = defaultdict(list)
for p in P.iterdir():
    m = STEM.match(p.name)
    if m: groups[m.group("stem")].append((m.group("suf"), p))

renames = []   # (old_path, new_name)
for stem, items in groups.items():
    base = [p for s, p in items if s == ""]
    lettered = sorted((p for s, p in items if s), key=lambda p: STEM.match(p.name).group("suf"))
    # lone lettered file, no base -> strip to base
    if not base and len(lettered) == 1:
        old = lettered[0]; new = f"{stem}.pdf"
        if old.name != new: renames.append((old, new))
        continue
    # relabel lettered files to consecutive a,b,c,...
    for i, old in enumerate(lettered):
        new = f"{stem}{chr(ord('a') + i)}.pdf"
        if old.name != new:
            renames.append((old, new))

print(f"groups: {len(groups)} | files to relabel: {len(renames)}")
print("\n  RELABEL:")
for old, new in sorted(renames, key=lambda r: r[0].name)[:60]:
    print(f"    {old.name:<34} -> {new}")
if len(renames) > 60:
    print(f"    ... and {len(renames)-60} more")

if GO:
    # phase 1: move every to-rename file to a unique temp name (avoid collisions)
    tmp = []
    for old, new in renames:
        t = old.with_name(old.name + ".renum_tmp")
        old.rename(t); tmp.append((t, new))
    # phase 2: temp -> final
    log = Path("/Users/devon7y/renumber.log"); n = 0
    with open(log, "w") as lf:
        for t, new in tmp:
            dst = P / new
            t.rename(dst); lf.write(f"{t.name.replace('.renum_tmp','')}\t{new}\n"); n += 1
    print(f"\nrelabeled {n} files. log: {log}")
else:
    print("\n(dry run; --go to apply)")
