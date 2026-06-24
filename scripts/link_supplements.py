#!/usr/bin/env python3
"""Directive #3: gather all Supplementary Materials PDFs (review main folder +
supplementary_materials/ subfolder) and rename them to match their paper, with
_Supplementary appended. Supplements use the old 4-letter Caplan code, so we link
them to the canonical paper in Papers/ by deriving each paper's code and matching.

    python3 link_supplements.py        # dry run
    python3 link_supplements.py --go
"""
import re, shutil, sys
from pathlib import Path

PAPERS = Path("/Users/devon7y/Papers")
REVIEW = Path("/Users/devon7y/Papers_needs_review")
SUPPL = REVIEW / "supplementary_materials"
GO = "--go" in sys.argv

SUPPL_RE = re.compile(r"(suppl|supplement|supplementary|_si\b|_sm\b|_supp)", re.I)

def code_of_canonical(name):
    """Agarwal_Etal_2014.pdf -> 'agaretal2014' (first4 + [etal|second4] + year)."""
    m = re.match(r"^(.+?)_(?:(Etal)|([A-Za-z][A-Za-z'-]*))?_?(\d{4})[a-z]?\.pdf$", name)
    parts = name[:-4].split("_")
    if len(parts) < 2: return None
    year = parts[-1]
    if not re.fullmatch(r"\d{4}[a-z]?", year): return None
    year = year[:4]
    a1 = parts[0]
    code = a1[:4]
    if len(parts) >= 3:
        a2 = parts[1]
        code += "Etal" if a2 == "Etal" else a2[:4]
    return (code + year).lower()

def code_of_supplement(name):
    """AgarEtal2014_suppl.pdf / CavaEtal2009_suppl1.pdf -> 'agaretal2014'."""
    stem = name[:-4] if name.lower().endswith(".pdf") else name
    stem = SUPPL_RE.split(stem)[0].rstrip("_-. ")
    m = re.match(r"^([A-Za-z.]+?\d{4}[a-z]?)", stem)
    if not m: return None
    code = re.sub(r"[^A-Za-z0-9]", "", m.group(1))
    return code.lower()

# build canonical-code -> Papers stem
paper_by_code = {}
for p in PAPERS.iterdir():
    if p.is_file() and p.suffix.lower() == ".pdf":
        c = code_of_canonical(p.name)
        if c:
            paper_by_code.setdefault(c, p.name[:-4])

# gather supplements: subfolder + any in review main folder
supp_files = [p for p in SUPPL.glob("*.pdf")] if SUPPL.exists() else []
supp_files += [p for p in REVIEW.glob("*.pdf") if SUPPL_RE.search(p.name)]

matched, unmatched, ambiguous = [], [], []
taken = set()
for s in sorted(supp_files):
    code = code_of_supplement(s.name)
    paper = paper_by_code.get(code) if code else None
    if not paper:
        unmatched.append((s, code)); continue
    base = f"{paper}_Supplementary"
    dst = SUPPL / f"{base}.pdf"
    i = 1
    while dst.name.lower() in taken or (dst.exists() and dst.resolve() != s.resolve()):
        i += 1; dst = SUPPL / f"{base}_{i}.pdf"
    taken.add(dst.name.lower())
    matched.append((s, dst, code))

print(("[DRY] " if not GO else "[GO] ") +
      f"supplements: {len(supp_files)} | matched {len(matched)} | unmatched {len(unmatched)}")
print("\n  sample matches:")
for s, d, c in matched[:15]:
    print(f"    {s.name:<34} -> {d.name}")
print("\n  unmatched (no paper with that code -> leave for manual):")
for s, c in unmatched[:20]:
    print(f"    {s.name:<34} (code={c})")

if GO:
    SUPPL.mkdir(exist_ok=True)
    log = REVIEW / "supplement_link.log"
    n = 0
    with open(log, "a") as lf:
        for s, d, c in matched:
            if s.resolve() == d.resolve(): continue
            shutil.move(str(s), str(d)); lf.write(f"{s}\t{d}\n"); n += 1
    print(f"\nrenamed/gathered {n} supplements -> {SUPPL}/  (log: {log})")
else:
    print("\nDry run. Re-run with --go.")
