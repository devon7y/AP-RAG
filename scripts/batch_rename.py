#!/usr/bin/env python3
"""General content-based PDF renamer via the OpenAI Batch API (50% cost), then
merge into Papers/ collision-safe. For folders of arbitrarily-named PDFs
(publisher downloads, DOIs, etc.) with no author/year in the filename.

    python3 batch_rename.py submit  --dir DIR
    python3 batch_rename.py status  --dir DIR
    python3 batch_rename.py collect --dir DIR [--go]
"""
import argparse, base64, hashlib, json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn
import llm_rename as L

PAPERS = Path("/Users/devon7y/Papers")
KEY = os.environ["OPENAI_API_KEY"]
H = {"Authorization": f"Bearer {KEY}"}
MODEL = "gpt-5-mini"

def jpegs(p, pages=2, dpi=100):
    out = []
    with tempfile.TemporaryDirectory() as td:
        stem = os.path.join(td, "p")
        try:
            subprocess.run(["pdftoppm", "-jpeg", "-jpegopt", "quality=50", "-r",
                            str(dpi), "-f", "1", "-l", str(pages), str(p), stem],
                           capture_output=True, timeout=120, check=True)
        except Exception:
            return out
        for f in sorted(Path(td).glob("p*.jpg")):
            out.append(f.read_bytes())
    return out

def state_path(d, tag=None): return Path(f".batch_rename_{tag or Path(d).name}.json")

def submit(dirp, tag=None, vision=False, files=None):
    allp = {p.name: p for p in Path(dirp).iterdir()
            if p.is_file() and p.suffix.lower() == ".pdf"}
    if files:
        want = [ln.split("\t")[0].strip() for ln in Path(files).read_text().splitlines()
                if ln.strip() and not ln.startswith("#")]
        pdfs = [allp[n] for n in want if n in allp]
    else:
        pdfs = [allp[n] for n in sorted(allp)]
    print(f"building requests for {len(pdfs)} PDFs (vision={vision}) ...", file=sys.stderr)
    cmap = {}; lines = []
    for i, p in enumerate(pdfs):
        txt = "" if vision else L.first_pages_text(p, pages=2)
        cid = f"b{i:05d}"; cmap[cid] = p.name
        if len(txt.strip()) >= 200:
            content = [{"type": "text", "text": "DOCUMENT TEXT:\n\n" + txt[:8000]}]
        else:
            imgs = jpegs(p)
            if not imgs:
                cmap.pop(cid); continue
            content = [{"type": "text", "text": "The document pages are attached as images."}]
            for im in imgs:
                content.append({"type": "image_url", "image_url":
                    {"url": "data:image/jpeg;base64," + base64.b64encode(im).decode()}})
        body = {"model": MODEL, "messages": [
                    {"role": "system", "content": L.PROMPT},
                    {"role": "user", "content": content}],
                "response_format": {"type": "json_schema", "json_schema":
                    {"name": "biblio", "strict": True, "schema": L.OPENAI_SCHEMA}},
                "reasoning_effort": "low", "max_completion_tokens": 3000}
        lines.append(json.dumps({"custom_id": cid, "method": "POST",
            "url": "/v1/chat/completions", "body": body}))
    inp = Path(f".batch_rename_{tag or Path(dirp).name}_input.jsonl")
    inp.write_text("\n".join(lines) + "\n")
    sz = inp.stat().st_size / 1e6
    print(f"  {len(lines)} requests, {sz:.0f} MB", file=sys.stderr)
    if sz > 195:
        print("  WARNING: >195MB, near the 200MB batch limit", file=sys.stderr)
    up = requests.post("https://api.openai.com/v1/files", headers=H,
        files={"file": (inp.name, inp.read_bytes())}, data={"purpose": "batch"}, timeout=600)
    up.raise_for_status(); fid = up.json()["id"]
    b = requests.post("https://api.openai.com/v1/batches", headers=H,
        json={"input_file_id": fid, "endpoint": "/v1/chat/completions",
              "completion_window": "24h"}, timeout=60)
    b.raise_for_status(); bid = b.json()["id"]
    state_path(dirp, tag).write_text(json.dumps({"batch_id": bid, "map": cmap, "dir": str(dirp)}))
    print(f"submitted {bid}: {len(lines)} requests")

def status(dirp, tag=None):
    st = json.loads(state_path(dirp, tag).read_text())
    j = requests.get(f"https://api.openai.com/v1/batches/{st['batch_id']}", headers=H, timeout=30).json()
    rc = j.get("request_counts", {})
    print(f"{j['status']}  completed={rc.get('completed')}/{rc.get('total')} failed={rc.get('failed')}")
    if j.get("errors"):
        for e in (j["errors"].get("data") or [])[:2]: print("  err:", e.get("message"))
    return j

def collect(dirp, go, tag=None):
    DIR = Path(dirp)
    st = json.loads(state_path(dirp, tag).read_text()); cmap = st["map"]
    j = status(dirp, tag)
    if j["status"] != "completed":
        print("not completed."); return
    out = requests.get(f"https://api.openai.com/v1/files/{j['output_file_id']}/content",
                       headers=H, timeout=600).text
    res = {}
    usage = {"in": 0, "out": 0}
    for line in out.splitlines():
        if not line.strip(): continue
        o = json.loads(line)
        try:
            body = o["response"]["body"]
            u = body.get("usage", {}); usage["in"] += u.get("prompt_tokens", 0); usage["out"] += u.get("completion_tokens", 0)
            res[cmap[o["custom_id"]]] = json.loads(body["choices"][0]["message"]["content"])
        except Exception:
            res[cmap.get(o["custom_id"], o["custom_id"])] = None

    def fhash(p):
        h = hashlib.sha1(); h.update(str(p.stat().st_size).encode())
        with open(p, "rb") as f: h.update(f.read(1 << 20))
        return h.hexdigest()

    taken = {p.name.lower() for p in PAPERS.iterdir() if p.suffix.lower() == ".pdf"}
    DUPES = DIR / "_duplicates"
    apply, dup, manual = [], [], []
    for fn, r in res.items():
        src = DIR / fn
        if not src.exists(): continue
        prop = L.proposed_name(r) if r else None
        if not prop:
            manual.append((fn, "not-citable/low-conf/incomplete")); continue
        cand = prop[0]
        # verify against page-1 text when available
        txt = L.first_pages_text(src, pages=1)
        if len(txt.strip()) >= 200:
            if vpn.surname_in_text(r.get("first_author_surname", ""), txt) == "no":
                manual.append((fn, f"author {r.get('first_author_surname')} not on p1")); continue
        # collision handling vs Papers
        if cand.lower() in taken:
            existing = PAPERS / cand
            if existing.exists() and fhash(existing) == fhash(src):
                dup.append((fn, cand)); continue
            t = taken.copy()
            cand2 = L.free_disambiguated(cand, t); cand = cand2
        taken.add(cand.lower())
        apply.append((fn, cand))

    cost = (usage["in"]/1e6*0.25 + usage["out"]/1e6*2.0) * 0.5
    print(f"results: merge {len(apply)} | duplicate {len(dup)} | manual {len(manual)}"
          f"  (batch cost ~${cost:.2f})")
    print("  sample:")
    for o, n in apply[:15]: print(f"    {o[:40]:<42} -> {n}")
    with open(f"batch_rename_{tag or DIR.name}_apply.tsv", "w") as f:
        for o, n in apply: f.write(f"{o}\t{n}\n")
    with open(f"batch_rename_{tag or DIR.name}_manual.tsv", "w") as f:
        for o, w in manual: f.write(f"{o}\t{w}\n")
    if go:
        DUPES.mkdir(exist_ok=True)
        log = DIR / "batch_rename.log"; n = 0
        with open(log, "a") as lf:
            for o, nn in apply:
                s = DIR / o; d = PAPERS / nn
                if not s.exists() or d.exists(): continue
                shutil.move(str(s), str(d)); lf.write(f"merge\t{o}\t{nn}\n"); n += 1
            for o, nn in dup:
                s = DIR / o
                if s.exists(): shutil.move(str(s), str(DUPES / o)); lf.write(f"dup\t{o}\n")
        print(f"\nmerged {n} into Papers/; {len(dup)} dups -> {DUPES}; "
              f"{len(manual)} left for manual. log: {log}")
    else:
        print("\n(dry run; pass --go to merge into Papers)")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["submit", "status", "collect"])
    ap.add_argument("--dir", required=True)
    ap.add_argument("--go", action="store_true")
    ap.add_argument("--vision", action="store_true", help="force vision (render images)")
    ap.add_argument("--files", help="only process basenames listed in this TSV (col 1)")
    ap.add_argument("--tag", help="namespace for state/output files (for a 2nd pass)")
    a = ap.parse_args()
    if a.cmd == "submit": submit(a.dir, a.tag, a.vision, a.files)
    elif a.cmd == "status": status(a.dir, a.tag)
    else: collect(a.dir, a.go, a.tag)
