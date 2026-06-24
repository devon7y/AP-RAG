#!/usr/bin/env python3
"""Run the column-aware OCR (ocr_pdf_to_searchable.py) over the needs-OCR lists,
in parallel, backing up each original before replacing it with the searchable
version. Reversible: pre-OCR originals go to /Users/devon7y/_pre_ocr_backup/.

    python3 run_ocr.py JOBSPEC...   where JOBSPEC = "folder::listfile"
"""
import shutil, subprocess, sys, tempfile, threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = Path(__file__).resolve().parent
PY = HERE / ".ocrvenv/bin/python"
SCRIPT = HERE / "ocr_pdf_to_searchable.py"
BACKUP = Path("/Users/devon7y/_pre_ocr_backup")
LOG = BACKUP / "ocr_run.log"
WORKERS = 6
lock = threading.Lock()
done = [0]

def ocr_one(folder, name):
    src = Path(folder) / name
    if not src.exists():
        return name, "missing"
    try:
        with tempfile.TemporaryDirectory() as td:
            r = subprocess.run([str(PY), str(SCRIPT), str(src),
                                "--output-dir", td, "--dpi", "300"],
                               capture_output=True, timeout=1200)
            out = Path(td) / name
            if not out.exists() or out.stat().st_size < 1000:
                return name, f"ocr-failed ({r.stderr.decode('utf-8','ignore')[-80:].strip()})"
            txt = subprocess.run(["pdftotext", "-f", "1", "-l", "2", str(out), "-"],
                                 capture_output=True).stdout
            if len(txt.strip()) < 50:
                return name, "no-text-after-ocr"
            bdir = BACKUP / Path(folder).name
            bdir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(bdir / name))
            shutil.move(str(out), str(src))
            return name, "ok"
    except subprocess.TimeoutExpired:
        return name, "timeout"
    except Exception as e:
        return name, f"error:{e}"

def main():
    tasks = []
    for spec in sys.argv[1:]:
        folder, listfile = spec.split("::")
        names = [l.split("\t")[0].strip()
                 for l in Path(listfile).read_text().splitlines()
                 if l.strip() and not l.startswith("#")]
        tasks += [(folder, n) for n in names]
    BACKUP.mkdir(parents=True, exist_ok=True)
    total = len(tasks)
    print(f"OCR over {total} PDFs, {WORKERS} workers, dpi 300 ...", flush=True)
    counts = {}
    with open(LOG, "a") as lf, ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(ocr_one, f, n): (f, n) for f, n in tasks}
        for fut in as_completed(futs):
            name, st = fut.result()
            counts[st.split()[0] if st else "?"] = counts.get(st.split()[0], 0) + 1
            lf.write(f"{st}\t{name}\n"); lf.flush()
            done[0] += 1
            if done[0] % 20 == 0:
                ok = counts.get("ok", 0)
                print(f"  {done[0]}/{total}  (ok={ok})", flush=True)
    print(f"\nDONE {done[0]}/{total}")
    for k, v in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {k:<16} {v}")
    print(f"backups: {BACKUP}  log: {LOG}")

if __name__ == "__main__":
    main()
