#!/usr/bin/env python3
"""Find un-expanded Caplan-code names that slipped into Papers/ (review_repass
echoed the 4-letter code because the scan was unreadable) and move ONLY the
genuine truncations to Papers_needs_review. A code-echo (new surname == old
code) is KEPT when the now-OCR'd page-1 text confirms the surname is a real
standalone byline token (e.g. Lee, Asch, Wang); it's MOVED when the page is
unreadable or the surname is absent (a truncation of a longer name).

    python3 move_truncated_codes.py        # dry run
    python3 move_truncated_codes.py --go
"""
import re, shutil, subprocess, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn

PAP = Path("/Users/devon7y/Papers")
REVIEW = Path("/Users/devon7y/Papers_needs_review")
LOG = Path("/Users/devon7y/Papers_needs_review/review_repass.log")
GO = "--go" in sys.argv

def old_chunks(n):
    s = n[:-4]; m = re.search(r"(\d{4})[a-z]?$", s); stem = s[:m.start()] if m else s
    return [c for c in re.findall(r"[A-Z][a-z.]*", stem) if c != "Etal"]

# code-echoes now in Papers/
echoes = []
for line in (LOG.read_text().splitlines() if LOG.exists() else []):
    if "\t" not in line:
        continue
    old, new = line.split("\t")[:2]
    oc = old_chunks(old)
    ns = [p for p in new[:-4].split("_") if p != "Etal"][:-1]
    if oc and ns and len(oc) == len(ns) and \
       all(vpn.fold(o) == vpn.fold(s) for o, s in zip(oc, ns)) and (PAP / new).exists():
        echoes.append(new)

keep, move = [], []
for name in sorted(set(echoes)):
    surn = name[:-4].split("_")[0]
    txt = subprocess.run(["pdftotext", "-f", "1", "-l", "1", str(PAP / name), "-"],
                         capture_output=True).stdout.decode("utf-8", "ignore")
    if len(txt.strip()) < 40:
        move.append((name, "unreadable (OCR failed)")); continue
    if len(vpn.fold(surn)) <= 2:
        keep.append((name, "surname too short to verify -> keep")); continue
    hit = vpn.surname_in_text(surn, txt)
    if hit == "yes":
        keep.append((name, "byline confirms surname"))
    else:
        move.append((name, f"'{surn}' not a byline token -> truncation"))

print(f"code-echoes: {len(echoes)} | KEEP {len(keep)} | MOVE-to-review {len(move)}")
print("\n  MOVE (truncated/unreadable):")
for n, why in move:
    print(f"    {n:<26} [{why}]")
print("\n  KEEP (confirmed real surname):")
for n, why in keep[:12]:
    print(f"    {n:<26} [{why}]")

if GO:
    logf = REVIEW / "moved_truncated_codes.log"
    k = 0
    with open(logf, "a") as lf:
        for n, why in move:
            src = PAP / n; dst = REVIEW / n
            if not src.exists():
                continue
            if dst.exists():
                dst = REVIEW / (n[:-4] + "_2.pdf")
            shutil.move(str(src), str(dst)); lf.write(f"{n}\t{why}\n"); k += 1
    print(f"\nmoved {k} truncated-code PDFs Papers/ -> Papers_needs_review/ (log {logf})")
else:
    print("\n(dry run; --go to move)")
