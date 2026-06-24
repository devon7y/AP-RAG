#!/usr/bin/env python3
"""Finalize the converted PDFs: apply canonical names, merge into Papers
(collision-safe), move un-nameable PDFs to the review top level, and back up the
original non-PDF source files. Dry-run unless --go."""
import shutil, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn
import llm_rename as L

PAPERS = Path("/Users/devon7y/Papers")
REVIEW = Path("/Users/devon7y/Papers_needs_review")
CONV = REVIEW / "_converted"
BACKUP = REVIEW / "_source_nonpdf_backup"
GO = "--go" in sys.argv

# 1. apply canonical renames within _converted (old->new basename)
ren = {}
mp = Path("converted_rename_map.tsv")
for line in mp.read_text().splitlines():
    if line.startswith("#") or not line.strip():
        continue
    o, n, *_ = line.split("\t")
    ren[o] = n

taken = {p.name.lower() for p in PAPERS.iterdir()
         if p.is_file() and p.suffix.lower() == ".pdf"}

plan = []  # (action, src, dst)
for p in sorted(CONV.glob("*.pdf")):
    canon = ren.get(p.name)
    if canon and vpn.CANONICAL_RE.match(canon):
        dst = L.free_disambiguated(canon, taken)
        taken.add(dst.lower())
        plan.append(("merge->Papers", p, PAPERS / dst))
    else:
        plan.append(("->review", p, REVIEW / p.name))

# 2. original non-PDF source files -> backup
SRC_GLOBS = ["*.ps.gz", "*.ps", "*.cgi", "*.docx", "Mein2001pdf", "JordEtal1995"]
originals = []
for g in SRC_GLOBS:
    originals += list(REVIEW.glob(g))
for s in originals:
    plan.append(("backup-original", s, BACKUP / s.name))

# 3. dead symlink + DS_Store
for junk in [REVIEW / "Eich_1982.pdf", REVIEW / ".DS_Store", CONV / ".DS_Store"]:
    if junk.is_symlink() or junk.exists():
        plan.append(("delete", junk, None))

from collections import Counter
c = Counter(a for a, _, _ in plan)
print(("[DRY RUN] " if not GO else "[EXEC] ") + "finalize plan:")
for k, v in c.items():
    print(f"  {k:<16} {v}")
print("\n  merges into Papers:")
for a, s, d in plan:
    if a == "merge->Papers":
        print(f"    {s.name}  ->  {d.name}")

if not GO:
    print("\nDry run. Re-run with --go.")
    sys.exit(0)

BACKUP.mkdir(exist_ok=True)
log = REVIEW / "convert_finalize.log"
n = 0
with open(log, "a") as lf:
    for a, s, d in plan:
        if a == "delete":
            (s.unlink() if (s.is_symlink() or s.is_file()) else None)
            lf.write(f"delete\t{s}\n"); n += 1; continue
        if d.exists():
            continue
        shutil.move(str(s), str(d))
        lf.write(f"{a}\t{s}\t{d}\n"); n += 1
# remove _converted if now empty of pdfs
leftover = list(CONV.glob("*.pdf"))
if not leftover:
    for x in CONV.iterdir():
        if x.name == ".DS_Store": x.unlink()
    try: CONV.rmdir()
    except OSError: pass
print(f"\ndone: {n} ops. log -> {log}")
