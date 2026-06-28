#!/usr/bin/env python3
"""add_papers.py — staged intake for new corpus papers.

Drop new PDFs into the staging inbox (``Temp Papers/``). This tool name-verifies
and de-duplicates them against the live corpus (``Papers/``), promotes only the
clean, non-duplicate ones, and then syncs that delta to the three downstream
systems that key on the filename:

    1. RAG ingest on the HPCs  (decoupled — you run it when enough accumulate)
    2. the Google Drive link map  (drive_links.json)
    3. the APA bib manifest       (papers_metadata.json)

A ledger (``.new_papers_ledger.json``) records each promoted paper's progress
across those three targets, so nothing is silently missed and the HPC ingest can
be batched. Every mutating step is dry-run unless ``--go``.

    python3 add_papers.py stage                 # classify the inbox (dry)
    python3 add_papers.py promote [--go]         # move clean papers -> Papers/ + ledger
    python3 add_papers.py drive   [--go]         # copy delta into the Drive Desktop mount
    python3 add_papers.py drive-map [--go]       # merge new Drive IDs -> drive_links.json (after sync)
    python3 add_papers.py manifest [--go]        # submit APA-manifest batch for the delta
    python3 add_papers.py manifest-collect [--go]# merge manifest batch results
    python3 add_papers.py status                 # ledger: what still needs ingest/drive/manifest
    python3 add_papers.py mark-ingested --all    # after an HPC ingest run
"""
from __future__ import annotations
import argparse, ctypes, ctypes.util, hashlib, json, os, re, shutil, subprocess, sys
from collections import defaultdict
from datetime import date
from pathlib import Path

REPO      = Path(__file__).resolve().parent.parent
INBOX     = Path("/Users/devon7y/Temp Papers")
PAPERS    = Path("/Users/devon7y/Papers")
DRIVE     = Path("/Users/devon7y/Library/CloudStorage/GoogleDrive-dyanitsk@ualberta.ca/Shared drives/CML documents/Papers")
LEDGER    = REPO / ".new_papers_ledger.json"
DRIVE_MAP = REPO / "drive_links.json"
MANIFEST  = REPO / "papers_metadata.json"

CANONICAL_RE = re.compile(r"^[A-Za-z][A-Za-z'-]*(_[A-Za-z][A-Za-z'-]*|_Etal)?_\d{4}[a-z]?(_Supplementary)?\.pdf$")
STEM_RE      = re.compile(r"^([A-Za-z][A-Za-z'-]*(?:_[A-Za-z][A-Za-z'-]*|_Etal)?_\d{4})[a-z]?(?:_Supplementary)?\.pdf$")
DOI_RE       = re.compile(r"10\.\d{4,9}/[^\s\"'<>)\]]+", re.I)
TARGETS      = ["ingested", "drive", "manifest"]

# ----------------------------------------------------------------------------- helpers
def load_ledger() -> dict:
    return json.loads(LEDGER.read_text()) if LEDGER.exists() else {}

def save_ledger(d: dict) -> None:
    LEDGER.write_text(json.dumps(d, indent=1, sort_keys=True))

def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

def pdf_doi(p: Path) -> str | None:
    try:
        t = subprocess.run(["pdftotext", "-f", "1", "-l", "3", "-layout", str(p), "-"],
                           capture_output=True, timeout=40).stdout.decode("utf-8", "ignore")
    except Exception:
        return None
    m = DOI_RE.search(t)
    return m.group(0).rstrip(".,;)").lower() if m else None

def drive_id(p: Path) -> str:
    """Read a file's Google Drive ID from the Drive-for-Desktop xattr (empty until synced)."""
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    buf = ctypes.create_string_buffer(512)
    n = libc.getxattr(os.fsencode(str(p)), b"com.google.drivefs.item-id#S", buf, 512, 0, 0)
    return buf.raw[:n].decode("utf-8", "ignore") if n and n > 0 else ""

def free_disambiguated(name: str, taken: set) -> str:
    stem = name[:-4]
    m = re.match(r"^(.*_\d{4})[a-z]?$", stem)
    if m:
        for c in "abcdefghijklmnopqrstuvwxyz":
            cand = f"{m.group(1)}{c}.pdf"
            if cand.lower() not in taken:
                return cand
    i = 2
    while f"{stem}_{i}.pdf".lower() in taken:
        i += 1
    return f"{stem}_{i}.pdf"

def inbox_pdfs() -> list[Path]:
    return sorted(p for p in INBOX.glob("*.pdf") if p.is_file())

# ----------------------------------------------------------------------------- classify
def classify():
    """Return list of (path, klass, detail). klass in: promote, collision, dup-identical,
    dup-content, dup-samepaper, needs-naming."""
    size_index = defaultdict(list)   # size -> [Papers paths]
    stem_index = defaultdict(list)   # stem -> [Papers names]
    for p in PAPERS.iterdir():
        if p.suffix.lower() != ".pdf":
            continue
        try:
            size_index[p.stat().st_size].append(p)
        except OSError:
            continue
        m = STEM_RE.match(p.name)
        if m:
            stem_index[m.group(1)].append(p)

    out = []
    for p in inbox_pdfs():
        name = p.name
        if not CANONICAL_RE.match(name):
            out.append((p, "needs-naming", "non-canonical filename")); continue
        dest = PAPERS / name
        same_size = size_index.get(p.stat().st_size, [])
        my = None
        if dest.exists():
            my = my or sha256(p)
            if sha256(dest) == my:
                out.append((p, "dup-identical", name)); continue
            # same name, different bytes: same paper (DOI match) -> dup; else -> disambiguate
            d = pdf_doi(p)
            if d and pdf_doi(dest) == d:
                out.append((p, "dup-samepaper", f"DOI matches existing {name}")); continue
            out.append((p, "collision", f"{name} exists with different content")); continue
        # content dup under a different name (same size first, then hash)
        hit = None
        if same_size:
            my = my or sha256(p)
            for q in same_size:
                if sha256(q) == my:
                    hit = q; break
        if hit:
            out.append((p, "dup-content", hit.name)); continue
        # same-paper-different-format dup: same stem + same DOI
        m = STEM_RE.match(name)
        sibs = stem_index.get(m.group(1), []) if m else []
        if sibs:
            d = pdf_doi(p)
            if d and any(pdf_doi(q) == d for q in sibs):
                out.append((p, "dup-samepaper", f"DOI matches existing {m.group(1)}*")); continue
        out.append((p, "promote", ""))
    return out

# ----------------------------------------------------------------------------- commands
def cmd_stage(args):
    rows = classify()
    by = defaultdict(list)
    for p, k, d in rows:
        by[k].append((p.name, d))
    order = ["promote", "collision", "needs-naming", "dup-identical", "dup-content", "dup-samepaper"]
    print(f"inbox: {len(rows)} PDFs in {INBOX}")
    for k in order:
        if k not in by: continue
        print(f"\n  {k}  ({len(by[k])}):")
        for n, d in by[k]:
            print(f"    {n:<40} {d}")
    n_ok = len(by.get("promote", [])) + len(by.get("collision", []))
    print(f"\n  -> {n_ok} promotable (run: add_papers.py promote --go)")

def cmd_promote(args):
    rows = classify()
    taken = {p.name.lower() for p in PAPERS.iterdir() if p.suffix.lower() == ".pdf"}
    plan = []   # (src, final_name)
    for p, k, d in rows:
        if k == "promote":
            plan.append((p, p.name))
        elif k == "collision":
            new = free_disambiguated(p.name, taken); taken.add(new.lower())
            plan.append((p, new))
    print(f"promote {len(plan)} papers into {PAPERS}:")
    for src, name in plan:
        tag = "" if name == src.name else f"  (disambiguated from {src.name})"
        print(f"    {name}{tag}")
    skipped = [(p.name, k) for p, k, d in rows if k not in ("promote", "collision")]
    if skipped:
        print(f"\n  leaving {len(skipped)} in inbox (dups/needs-naming):")
        for n, k in skipped:
            print(f"    {n:<40} [{k}]")
    if not args.go:
        print("\n(dry run; --go to apply)"); return
    led = load_ledger(); today = date.today().isoformat(); n = 0
    for src, name in plan:
        dst = PAPERS / name
        if dst.exists():
            print(f"  SKIP (exists): {name}"); continue
        shutil.move(str(src), str(dst))
        led[name] = {"added": today, "ingested": False, "drive": False,
                     "drive_copied": False, "manifest": False}
        n += 1
    save_ledger(led)
    print(f"\npromoted {n} papers; ledger -> {LEDGER}")

def cmd_drive(args):
    led = load_ledger()
    todo = [n for n, v in led.items() if not v.get("drive_copied") and (PAPERS / n).exists()
            and not (DRIVE / n).exists()]
    print(f"copy {len(todo)} papers into the Drive mount:\n    {DRIVE}")
    for n in todo:
        print(f"    {n}")
    if not args.go:
        print("\n(dry run; --go to copy)"); return
    if not DRIVE.exists():
        print(f"\nERROR: Drive mount not present — is Drive for Desktop streaming?\n  {DRIVE}"); return
    n = 0
    for name in todo:
        shutil.copy2(PAPERS / name, DRIVE / name)
        led[name]["drive_copied"] = True; n += 1
    save_ledger(led)
    print(f"\ncopied {n} into the Drive mount (upload is async). "
          f"Run `drive-map --go` once Drive finishes syncing to update the link map.")

def cmd_drive_map(args):
    led = load_ledger()
    todo = [n for n, v in led.items() if not v.get("drive")]
    ready, waiting = {}, []
    for name in todo:
        fid = drive_id(DRIVE / name) if (DRIVE / name).exists() else ""
        if fid:
            ready[name] = f"https://drive.google.com/file/d/{fid}/view?usp=drivesdk"
        else:
            waiting.append(name)
    print(f"new Drive links resolved: {len(ready)} | still uploading (no ID yet): {len(waiting)}")
    for n, u in ready.items():
        print(f"    {n}  ->  {u[:60]}...")
    if waiting:
        print("  waiting on Drive sync:")
        for n in waiting:
            print(f"    {n}")
    if not args.go:
        print("\n(dry run; --go to merge into drive_links.json)"); return
    if ready:
        m = json.loads(DRIVE_MAP.read_text())
        m.update(ready)
        DRIVE_MAP.write_text(json.dumps(m, indent=1, ensure_ascii=False))
        for name in ready:
            led[name]["drive"] = True
        save_ledger(led)
        print(f"\nmerged {len(ready)} links -> {DRIVE_MAP} (now {len(m)} entries)")
    if waiting:
        print(f"re-run drive-map later for the {len(waiting)} still syncing.")

def cmd_manifest(args):
    led = load_ledger()
    delta = [n for n, v in led.items() if not v.get("manifest") and (PAPERS / n).exists()]
    print(f"submit APA-manifest batch for {len(delta)} papers:")
    for n in delta:
        print(f"    {n}")
    if not args.go:
        print("\n(dry run; --go to submit the OpenAI batch)"); return
    if not delta:
        print("nothing to submit."); return
    cmd = [sys.executable, str(REPO / "scripts" / "build_apa_manifest.py"), "submit",
           str(PAPERS), "--files", *delta, "--tag", "newpapers"]
    print("  $", " ".join(cmd[:6]), "...")
    subprocess.run(cmd, cwd=str(REPO), check=False)
    print("\nsubmitted. Check with: build_apa_manifest.py status --tag newpapers")
    print("Then: add_papers.py manifest-collect --go")

def cmd_manifest_collect(args):
    if args.go:
        subprocess.run([sys.executable, str(REPO / "scripts" / "build_apa_manifest.py"),
                        "collect", str(PAPERS), "--tag", "newpapers"], cwd=str(REPO), check=False)
    meta = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    led = load_ledger(); n = 0
    for name, v in led.items():
        if not v.get("manifest") and name in meta:
            v["manifest"] = True; n += 1
    save_ledger(led)
    print(f"manifest now covers {n} newly-added papers (marked in ledger).")

def cmd_reconcile(args):
    """Sync today's local renames/dedup (renumber.log + dedup_samepaper.log + Groppe)
    into the Drive copies and the two JSONs, so the new ingest's filenames resolve.
    Renames preserve the Drive file ID, so existing links are NOT broken."""
    renames, deletions = {}, set()
    rn = Path("/Users/devon7y/renumber.log")
    if rn.exists():
        for ln in rn.read_text().splitlines():
            if "\t" in ln:
                o, n = ln.split("\t")[:2]; renames[o] = n
    dd = Path("/Users/devon7y/dedup_samepaper.log")
    if dd.exists():
        for ln in dd.read_text().splitlines():
            p = ln.split("\t")
            if p and p[0] == "deleted": deletions.add(Path(p[1]).name)
            elif p and p[0] == "renamed": renames[p[1]] = p[2]
    if (PAPERS / "Groppe_Etal_2011a.pdf").exists() and not (PAPERS / "Groppe_Etal_2011c.pdf").exists():
        renames.setdefault("Groppe_Etal_2011c.pdf", "Groppe_Etal_2011a.pdf")
    # keep renames whose target exists locally (don't require the old name gone — chain
    # renames like b->a, c->b legitimately reuse the old name for a different file)
    renames = {o: n for o, n in renames.items() if (PAPERS / n).exists()}
    # a deletion that is also a rename target is handled by the rename (don't drop it)
    deletions -= set(renames.values())

    print(f"reconcile: {len(renames)} renames, {len(deletions)} deleted-dup keys")
    for o, n in sorted(renames.items()):
        print(f"    {o:<30} -> {n}")
    if deletions:
        print("  drop keys:", ", ".join(sorted(deletions)))
    if not args.go:
        print("\n(dry run; --go to apply to drive_links.json + papers_metadata.json + the Drive mount)")
        return

    def rekey(path):
        d = json.loads(path.read_text())
        moves = {n: d[o] for o, n in renames.items() if o in d}   # snapshot before removing (handles chains)
        nold = sum(1 for o in renames if d.pop(o, None) is not None)
        ndrop = sum(1 for k in deletions if d.pop(k, None) is not None)
        d.update(moves)
        path.write_text(json.dumps(d, indent=1, ensure_ascii=False))
        print(f"  {path.name}: rekeyed {len(moves)} renames, dropped {ndrop} deleted keys -> {len(d)} entries")

    shutil.copy2(DRIVE_MAP, str(DRIVE_MAP) + ".reconcile_bak")
    shutil.copy2(MANIFEST, str(MANIFEST) + ".reconcile_bak")
    rekey(DRIVE_MAP); rekey(MANIFEST)

    # rename the Drive mount copies (two-phase temp; preserves Drive ID). collisions restored + reported.
    if DRIVE.exists():
        tmp = []
        for o, n in renames.items():
            s = DRIVE / o
            if s.exists():
                t = DRIVE / (o + ".recon_tmp"); s.rename(t); tmp.append((t, o, DRIVE / n))
        rd, coll = 0, []
        for t, o, dst in tmp:
            if not dst.exists():
                t.rename(dst); rd += 1
            else:
                t.rename(DRIVE / o); coll.append(dst.name)   # restore original name
        print(f"  Drive mount: renamed {rd}" + (f"; {len(coll)} collided (left as-is): {coll}" if coll else ""))
    else:
        print("  Drive mount offline — JSONs rekeyed; rename Drive copies later.")
    if deletions:
        print(f"  note: {len(deletions)} deleted-dup files remain on Drive (keys dropped); "
              "left in place so any external links keep working.")

def cmd_status(args):
    led = load_ledger()
    if not led:
        print("ledger empty — nothing added yet."); return
    pend = {t: 0 for t in TARGETS}
    print(f"{'paper':<40} added       ingest drive manifest")
    for name in sorted(led):
        v = led[name]
        flag = lambda b: "  ✓  " if b else "  ·  "
        print(f"{name:<40} {v.get('added','?'):<11}{flag(v.get('ingested'))}{flag(v.get('drive'))}{flag(v.get('manifest'))}")
        for t in TARGETS:
            if not v.get(t): pend[t] += 1
    print(f"\npending -> ingest:{pend['ingested']}  drive:{pend['drive']}  manifest:{pend['manifest']}")
    if pend["ingested"]:
        names = [n for n in sorted(led) if not led[n].get("ingested")]
        print(f"\n  awaiting HPC ingest ({len(names)}):  " + " ".join(names))

def cmd_mark_ingested(args):
    led = load_ledger()
    names = list(led) if args.all else args.names
    n = 0
    for name in names:
        if name in led and not led[name].get("ingested"):
            led[name]["ingested"] = True; n += 1
    save_ledger(led)
    print(f"marked {n} papers ingested.")

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("stage", "promote", "drive", "drive-map", "manifest", "manifest-collect", "reconcile", "status"):
        sp = sub.add_parser(name)
        if name != "stage" and name != "status":
            sp.add_argument("--go", action="store_true")
    mi = sub.add_parser("mark-ingested")
    mi.add_argument("names", nargs="*"); mi.add_argument("--all", action="store_true")
    args = ap.parse_args()
    {"stage": cmd_stage, "promote": cmd_promote, "drive": cmd_drive, "drive-map": cmd_drive_map,
     "manifest": cmd_manifest, "manifest-collect": cmd_manifest_collect, "reconcile": cmd_reconcile,
     "status": cmd_status, "mark-ingested": cmd_mark_ingested}[args.cmd](args)

if __name__ == "__main__":
    main()
