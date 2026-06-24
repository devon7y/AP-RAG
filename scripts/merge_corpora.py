#!/usr/bin/env python3
"""Merge Caplan_Papers into Papers, collision-safe, with a separate review folder.

End state:
  /Users/devon7y/Papers                -> all canonically-named PDFs (both corpora)
  /Users/devon7y/Papers_needs_review   -> non-conforming PDFs (both) + Caplan
                                          non-PDFs; exact dups under _duplicates/

Rules for each Caplan file:
  - canonical-name PDF + no clash        -> move into Papers
  - canonical-name PDF, name clash:
        same content as the Papers file   -> move to review/_duplicates (kept, not deleted)
        different content                 -> disambiguate (Smith_2020 -> Smith_2020a) into Papers
  - non-conforming PDF / non-PDF / dir    -> move into review
Papers' own non-conforming PDFs are also moved into review.
Nothing is deleted; every move is logged (reversible).

    python3 merge_corpora.py            # dry run (plan + counts)
    python3 merge_corpora.py --go       # execute
"""
import hashlib, shutil, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn
import llm_rename as L

PAPERS = Path("/Users/devon7y/Papers")
CAPLAN = Path("/Users/devon7y/Caplan_Papers")
REVIEW = Path("/Users/devon7y/Papers_needs_review")
DUPES = REVIEW / "_duplicates"
GO = "--go" in sys.argv

def fhash(p):
    h = hashlib.sha1()
    try:
        h.update(str(p.stat().st_size).encode())
        with open(p, "rb") as f: h.update(f.read(1 << 20))
    except OSError: return None
    return h.hexdigest()

def conforming(name): return bool(vpn.CANONICAL_RE.match(name))

# snapshot listings first (don't mutate while iterating)
papers_entries = sorted(PAPERS.iterdir())
caplan_entries = sorted(CAPLAN.iterdir())

taken = {p.name.lower() for p in papers_entries
         if p.is_file() and p.suffix.lower() == ".pdf" and conforming(p.name)}

plan = []  # (action, src, dst)

# Papers' own non-conforming PDFs -> review
for p in papers_entries:
    if p.is_file() and p.suffix.lower() == ".pdf" and not conforming(p.name):
        plan.append(("review", p, REVIEW / p.name))

# Caplan files
for p in caplan_entries:
    if not p.is_file():
        plan.append(("review-dir", p, REVIEW / p.name)); continue
    if p.suffix.lower() != ".pdf":
        plan.append(("review-other", p, REVIEW / p.name)); continue
    if not conforming(p.name):
        plan.append(("review", p, REVIEW / p.name)); continue
    # conforming PDF -> merge
    if p.name.lower() not in taken:
        plan.append(("merge", p, PAPERS / p.name)); taken.add(p.name.lower())
    else:
        existing = PAPERS / p.name
        if existing.exists() and fhash(existing) == fhash(p):
            plan.append(("dup", p, DUPES / p.name))
        else:
            new = L.free_disambiguated(p.name, taken)
            plan.append(("merge-disambig", p, PAPERS / new)); taken.add(new.lower())

from collections import Counter
c = Counter(a for a, _, _ in plan)
print("=== MERGE PLAN" + ("  [DRY RUN]" if not GO else "  [EXECUTING]") + " ===")
for k in ("merge","merge-disambig","dup","review","review-other","review-dir"):
    if c.get(k): print(f"  {k:<16} {c[k]}")
print(f"  Papers PDFs staying put (conforming): "
      f"{sum(1 for p in papers_entries if p.is_file() and p.suffix.lower()=='.pdf' and conforming(p.name))}")

print("\n  sample collisions (disambiguated):")
for a, s, d in [x for x in plan if x[0]=="merge-disambig"][:8]:
    print(f"    {s.name}  ->  {d.name}")
print("  sample exact duplicates (-> _duplicates/):")
for a, s, d in [x for x in plan if x[0]=="dup"][:8]:
    print(f"    {s.name}")

if not GO:
    print("\nDry run only. Re-run with --go to execute.")
    sys.exit(0)

REVIEW.mkdir(exist_ok=True); DUPES.mkdir(exist_ok=True)
log = REVIEW / "merge_move.log"
n = 0
with open(log, "a") as lf:
    for a, s, d in plan:
        if d.exists():
            d = d.parent / (d.stem + "_dup2" + d.suffix)  # ultra-safe: never clobber
        shutil.move(str(s), str(d))
        lf.write(f"{a}\t{s}\t{d}\n"); n += 1
print(f"\nmoved {n} entries. log -> {log}")
