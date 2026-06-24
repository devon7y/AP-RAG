#!/usr/bin/env python3
"""Place the Rorqual-OCR'd searchable PDFs (in ~/ocr_results) back into Papers/
and Papers_needs_review/, backing up each original scan exactly once. Files the
local run already processed have their original in _pre_ocr_backup already; for
those we just overwrite the (local-)searchable version with the HPC one."""
import shutil, subprocess
from pathlib import Path
RES = Path("/Users/devon7y/ocr_results")
BK = Path("/Users/devon7y/_pre_ocr_backup")
FOLDERS = {"Papers": Path("/Users/devon7y/Papers"),
           "Papers_needs_review": Path("/Users/devon7y/Papers_needs_review")}

placed = nofolder = backed = overwrote = bad = 0
for r in sorted(RES.glob("*.pdf")):
    n = r.name
    # sanity: the result must have a text layer
    txt = subprocess.run(["pdftotext", "-f", "1", "-l", "2", str(r), "-"],
                         capture_output=True).stdout
    if len(txt.strip()) < 30:
        bad += 1; continue
    tgt = fname = None
    for fn, fp in FOLDERS.items():
        if (fp / n).exists():
            tgt, fname = fp, fn; break
    if not tgt:
        nofolder += 1; continue
    bdir = BK / fname; bdir.mkdir(parents=True, exist_ok=True)
    if not (bdir / n).exists():
        shutil.move(str(tgt / n), str(bdir / n)); backed += 1     # original scan -> backup
    else:
        overwrote += 1                                            # original already backed up
    shutil.copy2(str(r), str(tgt / n))                            # drop in HPC searchable
    placed += 1
print(f"placed {placed} (newly-backed-up {backed}, overwrote-local {overwrote}) | "
      f"no-folder {nofolder} | low-text-skipped {bad}")
