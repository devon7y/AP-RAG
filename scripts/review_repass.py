#!/usr/bin/env python3
"""Directives #1 + #2: re-name the review papers via VISION (bypasses pdftotext
multi-column jumbling) using the current filename as ground truth for year +
author-count, asking the model only to expand the 4-letter codes to FULL
surnames. Verifies each surname's first letters match its code. OpenAI Batch API.

    python3 review_repass.py submit
    python3 review_repass.py status
    python3 review_repass.py collect [--go]   # --go applies the renames
"""
import base64, json, os, re, subprocess, sys, tempfile
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn
import llm_rename as L

REVIEW = Path("/Users/devon7y/Papers_needs_review")
PAPERS = Path("/Users/devon7y/Papers")
KEY = os.environ["OPENAI_API_KEY"]
H = {"Authorization": f"Bearer {KEY}"}
STATE = Path("review_repass_state.json")
MODEL = "gpt-5-mini"

SCHEMA = {"type": "object", "additionalProperties": False, "properties": {
    "first_author_surname": {"type": "string"},
    "second_author_surname": {"type": "string"},
    "num_authors": {"type": "integer"},
    "year_on_page": {"type": "string"},
    "is_paper": {"type": "boolean"}},
    "required": ["first_author_surname", "second_author_surname",
                 "num_authors", "year_on_page", "is_paper"]}

def parse_caplan(name):
    """name -> (chunks, count, year) or None. count: 'one'|'two'|'etal'."""
    s = name[:-4]
    m = re.search(r"(\d{4})[a-z]?$", s)
    if not m:
        return None
    year = m.group(1); stem = s[:m.start()]
    chunks = re.findall(r"[A-Z][a-z.]*", stem)
    if not chunks:
        return None
    if chunks[-1] == "Etal":
        return chunks[:-1], "etal", year
    if len(chunks) == 2:
        return chunks, "two", year
    if len(chunks) == 1:
        return chunks, "one", year
    return chunks, "etal", year   # 3+ glued chunks -> treat as etal

def jpegs(p, pages=2, dpi=100):
    out = []
    with tempfile.TemporaryDirectory() as td:
        stem = os.path.join(td, "p")
        try:
            subprocess.run(["pdftoppm", "-jpeg", "-jpegopt", "quality=50",
                            "-r", str(dpi), "-f", "1",
                            "-l", str(pages), str(p), stem],
                           capture_output=True, timeout=120, check=True)
        except Exception:
            return out
        for f in sorted(Path(td).glob("p*.jpg")):
            out.append(f.read_bytes())
    return out

def prompt_for(chunks, count, year):
    if count == "etal":
        who = (f'The FIRST author surname begins with "{chunks[0]}". '
               "The paper has THREE OR MORE authors.")
    elif count == "two":
        who = (f'There are exactly TWO authors; the first surname begins with '
               f'"{chunks[0]}", the second with "{chunks[1]}".')
    else:
        who = f'There is ONE author; the surname begins with "{chunks[0]}".'
    return ("You are reading page images of a scholarly paper. A library code "
            f"says: {who} Publication year: {year}.\n"
            "Look ONLY at the author byline directly under the title on the "
            "first page (ignore reference lists / other articles). Return the "
            "FULL last name(s) — ASCII, keep internal hyphens, glue multiword "
            "surnames (van Santen -> vanSanten). first_author_surname MUST "
            f'begin with "{chunks[0]}". Also report year_on_page if printed.')

def targets():
    out = []
    for p in sorted(REVIEW.glob("*.pdf")):
        if re.search(r"suppl|supplement", p.name, re.I):
            continue
        parsed = parse_caplan(p.name)
        if parsed:
            out.append((p, parsed))
    return out

def submit():
    tg = targets()
    print(f"building {len(tg)} vision requests ...", file=sys.stderr)
    cmap = {}; lines = []
    for i, (p, (chunks, count, year)) in enumerate(tg):
        imgs = jpegs(p)
        if not imgs:
            continue
        cid = f"v{i:05d}"; cmap[cid] = {"file": p.name, "chunks": chunks,
                                        "count": count, "year": year}
        content = [{"type": "text", "text": prompt_for(chunks, count, year)}]
        for im in imgs:
            content.append({"type": "image_url", "image_url":
                {"url": "data:image/jpeg;base64," + base64.b64encode(im).decode()}})
        body = {"model": MODEL, "messages": [{"role": "user", "content": content}],
                "response_format": {"type": "json_schema", "json_schema":
                    {"name": "biblio", "strict": True, "schema": SCHEMA}},
                "reasoning_effort": "low", "max_completion_tokens": 2000}
        lines.append(json.dumps({"custom_id": cid, "method": "POST",
            "url": "/v1/chat/completions", "body": body}))
    inp = Path("review_repass_input.jsonl"); inp.write_text("\n".join(lines) + "\n")
    up = requests.post("https://api.openai.com/v1/files", headers=H,
        files={"file": (inp.name, inp.read_bytes())}, data={"purpose": "batch"}, timeout=600)
    up.raise_for_status(); fid = up.json()["id"]
    b = requests.post("https://api.openai.com/v1/batches", headers=H,
        json={"input_file_id": fid, "endpoint": "/v1/chat/completions",
              "completion_window": "24h"}, timeout=60)
    b.raise_for_status(); bid = b.json()["id"]
    STATE.write_text(json.dumps({"batch_id": bid, "map": cmap}))
    print(f"submitted {bid}: {len(lines)} requests ({inp.stat().st_size/1e6:.0f} MB)")

def status():
    st = json.loads(STATE.read_text())
    j = requests.get(f"https://api.openai.com/v1/batches/{st['batch_id']}", headers=H, timeout=30).json()
    rc = j.get("request_counts", {})
    print(f"{j['status']}  completed={rc.get('completed')}/{rc.get('total')} failed={rc.get('failed')}")
    return j

def collect():
    st = json.loads(STATE.read_text()); cmap = st["map"]
    j = status()
    if j["status"] != "completed":
        print("not completed yet."); return
    out = requests.get(f"https://api.openai.com/v1/files/{j['output_file_id']}/content",
                       headers=H, timeout=600).text
    res = {}
    for line in out.splitlines():
        if not line.strip(): continue
        o = json.loads(line)
        try:
            res[o["custom_id"]] = json.loads(o["response"]["body"]["choices"][0]["message"]["content"])
        except Exception:
            res[o["custom_id"]] = None
    taken = {p.name.lower() for p in PAPERS.iterdir() if p.suffix.lower() == ".pdf"}
    apply, manual = [], []
    GO = "--go" in sys.argv
    for cid, meta in cmap.items():
        r = res.get(cid); chunks = meta["chunks"]; count = meta["count"]; year = meta["year"]
        if not r or not r.get("is_paper") or not r.get("first_author_surname"):
            manual.append((meta["file"], "not-a-paper/unreadable")); continue
        a1 = vpn.ascii_name(r["first_author_surname"])
        ok1 = a1 and vpn.fold(a1).startswith(vpn.fold(chunks[0])[:3])
        if count == "two":
            a2 = vpn.ascii_name(r.get("second_author_surname", ""))
            ok2 = a2 and vpn.fold(a2).startswith(vpn.fold(chunks[1])[:3])
            if not (ok1 and ok2):
                manual.append((meta["file"], f"mismatch: {a1}/{a2} vs {chunks}")); continue
            cand = vpn.canonical_name(a1, a2, year)
        elif count == "etal":
            if not ok1:
                manual.append((meta["file"], f"mismatch: {a1} vs {chunks[0]}")); continue
            cand = vpn.canonical_name(a1, "Etal", year)
        else:
            if not ok1:
                manual.append((meta["file"], f"mismatch: {a1} vs {chunks[0]}")); continue
            cand = vpn.canonical_name(a1, "", year)
        if cand.lower() == meta["file"].lower():
            continue
        t = taken.copy(); t.discard(meta["file"].lower())
        cand = L.free_disambiguated(cand, t); taken.add(cand.lower())
        apply.append((meta["file"], cand))
    with open("review_repass_apply.tsv", "w") as f:
        f.write("# old\tnew\n")
        for o, n in apply: f.write(f"{o}\t{n}\n")
    with open("review_repass_manual.tsv", "w") as f:
        for o, w in manual: f.write(f"{o}\t{w}\n")
    print(f"results: apply {len(apply)}, manual {len(manual)}")
    print("  sample:")
    for o, n in apply[:15]: print(f"    {o:<22} -> {n}")
    if GO:
        import shutil
        log = REVIEW / "review_repass.log"; n = 0
        with open(log, "a") as lf:
            for o, nn in apply:
                s = REVIEW / o; d = PAPERS / nn
                if not s.exists() or d.exists(): continue
                shutil.move(str(s), str(d)); lf.write(f"{o}\t{nn}\n"); n += 1
        print(f"\napplied {n} -> Papers/ (log {log})")
    else:
        print("\n(collect without --go = dry run)")

{"submit": submit, "status": status, "collect": collect}[sys.argv[1]]()
