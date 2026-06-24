#!/usr/bin/env python3
"""Batch-4 triage of the Caplan review tail via the OpenAI Batch API (50% cost).

Targets the recoverable flagged cases (books missing a year, image-only scans,
low-confidence, errors, ambiguous-year, batch-1 rejects) -- NOT the genuine
not-citable items. Text-capable PDFs get a 6-page text request (copyright-year
focus); image-only scans get a 2-page JPEG vision request.

Usage:
    python3 batch4.py submit     # build JSONL, upload, create batch -> saves id
    python3 batch4.py status     # poll batch state
    python3 batch4.py collect    # download results, classify, write apply map
"""
import base64, json, os, re, subprocess, sys, tempfile
from pathlib import Path

import requests
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn
import llm_rename as L

ROOT = Path("/Users/devon7y/Caplan_Papers")
KEY = os.environ["OPENAI_API_KEY"]
H = {"Authorization": f"Bearer {KEY}"}
STATE = Path("batch4_state.json")
MODEL = "gpt-5-mini"

YEAR_PROMPT = L.PROMPT + ("\n\nThis document was flagged as hard: look extra "
    "carefully for the publication YEAR (title page, copyright page, journal "
    "masthead/footer, DOI line). Identify the byline authors precisely.")


def text_6(p):
    try:
        return subprocess.run(["pdftotext","-f","1","-l","6","-layout",str(p),"-"],
            capture_output=True, timeout=60).stdout.decode("utf-8","ignore")
    except Exception:
        return ""

def jpegs(p, pages=2, dpi=120):
    out=[]
    with tempfile.TemporaryDirectory() as td:
        stem=os.path.join(td,"p")
        try:
            subprocess.run(["pdftoppm","-jpeg","-r",str(dpi),"-f","1","-l",str(pages),
                            str(p),stem], capture_output=True, timeout=120, check=True)
        except Exception:
            return out
        for f in sorted(Path(td).glob("p*.jpg")): out.append(f.read_bytes())
    return out

def body_for(content):
    return {"model":MODEL,
            "messages":[{"role":"system","content":YEAR_PROMPT},
                        {"role":"user","content":content}],
            "response_format":{"type":"json_schema",
                "json_schema":{"name":"biblio","strict":True,"schema":L.OPENAI_SCHEMA}},
            "reasoning_effort":"medium","max_completion_tokens":3000}


def gather_targets():
    """Return {filename: 'text'|'vision'} for the recoverable tail."""
    t={}
    # review tail (skip not-citable)
    for line in open("caplan_review.tsv"):
        if line.startswith("#") or not line.strip(): continue
        c=line.rstrip("\n").split("\t")
        old, reason = c[0], (c[2] if len(c)>2 else "")
        if reason=="not-a-citable-work": continue
        t.setdefault(old, "vision" if reason in ("llm-author-not-on-page","llm-error")
                     else "text")
    # batch-2 ambiguous years -> text (need copyright page)
    if Path("caplan_batch2_review.tsv").exists():
        for line in open("caplan_batch2_review.tsv"):
            if not line.strip(): continue
            t.setdefault(line.split("\t")[0], "text")
    # batch-1 rejects (AUTHOR-flagged not applied) -> vision
    applied=set()
    if Path("caplan_batch1_apply.tsv").exists():
        applied={l.split("\t")[0] for l in open("caplan_batch1_apply.tsv")
                 if not l.startswith("#")}
    if Path("caplan_triage_author.tsv").exists():
        for line in open("caplan_triage_author.tsv"):
            if line.startswith("verdict"): continue
            old=line.split("\t")[1]
            if old not in applied: t.setdefault(old,"vision")
    # only existing files
    return {f:m for f,m in t.items() if (ROOT/f).exists()}


def submit():
    targets=gather_targets()
    print(f"building {len(targets)} batch requests ...", file=sys.stderr)
    cmap={}; lines=[]
    for i,(fn,mode) in enumerate(sorted(targets.items())):
        cid=f"r{i:05d}"; cmap[cid]=fn
        if mode=="text":
            txt=text_6(ROOT/fn)
            if len(txt.strip())<200:        # fall back to vision if no text
                mode="vision"
            else:
                content=[{"type":"text","text":"DOCUMENT TEXT:\n\n"+txt[:9000]}]
        if mode=="vision":
            imgs=jpegs(ROOT/fn)
            if not imgs:
                cmap.pop(cid); continue     # unreadable; skip
            content=[{"type":"text","text":"The document pages are attached as images."}]
            for im in imgs:
                content.append({"type":"image_url","image_url":
                    {"url":"data:image/jpeg;base64,"+base64.b64encode(im).decode()}})
        lines.append(json.dumps({"custom_id":cid,"method":"POST",
            "url":"/v1/chat/completions","body":body_for(content)}))
    inp=Path("batch4_input.jsonl"); inp.write_text("\n".join(lines)+"\n")
    sz=inp.stat().st_size/1e6
    print(f"wrote {inp} ({len(lines)} requests, {sz:.1f} MB)", file=sys.stderr)

    up=requests.post("https://api.openai.com/v1/files", headers=H,
        files={"file":(inp.name, inp.read_bytes())}, data={"purpose":"batch"}, timeout=300)
    up.raise_for_status(); fid=up.json()["id"]
    b=requests.post("https://api.openai.com/v1/batches", headers=H,
        json={"input_file_id":fid,"endpoint":"/v1/chat/completions",
              "completion_window":"24h"}, timeout=60)
    b.raise_for_status(); bid=b.json()["id"]
    STATE.write_text(json.dumps({"batch_id":bid,"file_id":fid,"map":cmap}))
    print(f"submitted batch {bid}  ({len(lines)} requests). state -> {STATE}")


def status():
    st=json.loads(STATE.read_text())
    r=requests.get(f"https://api.openai.com/v1/batches/{st['batch_id']}",headers=H,timeout=30)
    j=r.json(); rc=j.get("request_counts",{})
    print(f"batch {st['batch_id']}: {j['status']}  "
          f"completed={rc.get('completed')} failed={rc.get('failed')} total={rc.get('total')}")
    return j


def collect():
    st=json.loads(STATE.read_text()); cmap=st["map"]
    j=status()
    if j["status"]!="completed":
        print("not completed yet; run `status` / wait."); return
    out=requests.get(f"https://api.openai.com/v1/files/{j['output_file_id']}/content",
                     headers=H, timeout=300).text
    results={}
    for line in out.splitlines():
        if not line.strip(): continue
        o=json.loads(line); cid=o["custom_id"]
        try:
            results[cmap[cid]]=json.loads(
                o["response"]["body"]["choices"][0]["message"]["content"])
        except Exception:
            results[cmap[cid]]=None

    taken={p.name.lower() for p in ROOT.iterdir() if p.suffix.lower()==".pdf"}
    apply=[]; review=[]
    for fn,res in results.items():
        prop=L.proposed_name(res) if res else None
        if not prop:
            review.append((fn,"",("not-citable/low-conf/incomplete"))); continue
        new=prop[0]
        if new.lower()==fn.lower(): continue
        # verify: author in first 700 chars of text, else (scan) accept if conf high/med
        txt=text_6(ROOT/fn)
        fa=vpn.fold(new[:-4].split("_")[0])
        if len(txt.strip())>=200:
            ok = fa and (fa in vpn.fold(txt[:700]) or any(len(x)>=7 and x in vpn.fold(txt[:700]) for x in [fa]))
        else:
            ok = res.get("confidence") in ("high","medium")
        if not ok:
            review.append((fn,new,"author-not-verified")); continue
        t2=taken.copy(); t2.discard(fn.lower())
        nn=L.free_disambiguated(new,t2); taken.add(nn.lower())
        apply.append((fn,nn,"batch4"))

    with open("caplan_batch4_apply.tsv","w") as f:
        f.write("# old\tnew\ttier\n")
        for o,n,t in apply: f.write(f"{o}\t{n}\t{t}\n")
    with open("caplan_batch4_review.tsv","w") as f:
        for o,n,w in review: f.write(f"{o}\t{n}\t{w}\n")
    print(f"collected {len(results)} results -> apply {len(apply)}, review {len(review)}")
    print("apply map: caplan_batch4_apply.tsv  (review: caplan_batch4_review.tsv)")


if __name__=="__main__":
    {"submit":submit,"status":status,"collect":collect}[sys.argv[1]]()
