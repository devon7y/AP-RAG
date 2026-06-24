#!/usr/bin/env python3
"""Sort the non-conforming Papers_vscode_to_rename PDFs from the 'vscode' batch:
 - real papers  -> canonical Author_Year, renamed IN PLACE (stay in the folder)
 - supplements  -> Author_Year_Supplementary, IN PLACE
 - non-papers / unnameable / duplicates -> MOVED to Papers_needs_review
Year recovered from LLM / filename / arXiv / DOI->Crossref. Dry-run unless --go."""
import hashlib, json, os, re, shutil, sys
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn
import llm_rename as L

SRC = Path("/Users/devon7y/Papers_vscode_to_rename")
REVIEW = Path("/Users/devon7y/Papers_needs_review")
KEY = os.environ["OPENAI_API_KEY"]
GO = "--go" in sys.argv
SUPP_RE = re.compile(r"suppl|supplement|MOESM|_ESM|\.sapp|supporting", re.I)
# book parts, preregistrations, CVs -> always manual (not standard Author_Year papers)
NONPAPER_RE = re.compile(r"preregistration|prereg|_Part(One|Two|Three|Four|Five|Six)|(^|_)CV(_|\b)", re.I)

st = json.load(open(".batch_rename_vscode.json")); cmap = st["map"]
j = requests.get(f"https://api.openai.com/v1/batches/{st['batch_id']}",
                 headers={"Authorization": f"Bearer {KEY}"}, timeout=30).json()
out = requests.get(f"https://api.openai.com/v1/files/{j['output_file_id']}/content",
                   headers={"Authorization": f"Bearer {KEY}"}, timeout=300).text
res = {}
for line in out.splitlines():
    if not line.strip(): continue
    o = json.loads(line)
    try: res[cmap[o["custom_id"]]] = json.loads(o["response"]["body"]["choices"][0]["message"]["content"])
    except Exception: pass

cache = {}
def fhash(p):
    h = hashlib.sha1(); h.update(str(p.stat().st_size).encode())
    with open(p, "rb") as f: h.update(f.read(1 << 20))
    return h.hexdigest()
def tc(s): return vpn.titlecase_surname(s) if s.isupper() and len(s) > 1 else s
def year_of(r, fn, txt):
    ym = re.search(r"(1[5-9]\d{2}|20\d{2})", str((r or {}).get("year", "")))
    if ym: return ym.group(0)
    ys = [y for y in re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)', fn) if 1950 <= int(y) <= 2027]
    if ys: return ys[-1]
    m = re.search(r'(?<!\d)(\d{2})(\d{2})\.\d{4,5}(?!\d)', fn)
    if m and 1 <= int(m.group(2)) <= 12: return f"20{m.group(1)}"
    md = vpn.DOI_RE.search(txt)
    if md:
        rec = vpn.crossref_lookup(md.group(0).rstrip(".,;)"), "devon7y@gmail.com", cache)
        if rec and rec.get("year"): return rec.get("year"), rec.get("family")
    return None
def build(a1, a2, n, year, supp=False):
    if n >= 3 or (n == 2 and not a2): core = vpn.canonical_name(a1, "Etal", year)
    elif n == 2: core = vpn.canonical_name(a1, a2, year)
    else: core = vpn.canonical_name(a1, "", year)
    return core[:-4] + "_Supplementary.pdf" if supp else core

taken = {p.name.lower() for p in SRC.iterdir() if p.suffix.lower() == ".pdf"}
rename_inplace, to_review = [], []
for fn, r in res.items():
    src = SRC / fn
    if not src.exists(): continue
    if NONPAPER_RE.search(fn):
        to_review.append((fn, "book-part/prereg/CV")); continue
    txt = L.first_pages_text(src, pages=2)
    a1 = tc(vpn.ascii_name((r or {}).get("first_author_surname", "")))
    yr = year_of(r, fn, txt)
    year = yr[0] if isinstance(yr, tuple) else yr
    if isinstance(yr, tuple) and yr[1]: a1 = tc(vpn.ascii_name(yr[1]))
    try: n = int((r or {}).get("num_authors") or 0)
    except (TypeError, ValueError): n = 0
    a2 = tc(vpn.ascii_name((r or {}).get("second_author_surname", "") or ""))
    is_supp = bool(SUPP_RE.search(fn)) or ((r or {}).get("document_kind") == "supplementary")

    if is_supp:
        if re.search(r"_Supplementary\.pdf$", fn): continue          # already named
        if a1 and year:
            cand = build(a1, a2, n, year, supp=True)
            if cand.lower() != fn.lower():
                if cand.lower() in taken: cand = L.free_disambiguated(cand, taken)
                taken.add(cand.lower()); rename_inplace.append((fn, cand, "suppl"))
        else:
            to_review.append((fn, "supplement-unlinkable"))
        continue

    if not r or not r.get("is_citable_work") or not a1 or not year:
        reason = (r.get("document_kind", "?") if r else "no-result")
        if a1 and not year: reason = "no-year"
        to_review.append((fn, reason)); continue
    if len(txt.strip()) >= 200 and vpn.surname_in_text(a1, txt) == "no" \
            and not re.search(r'(?<!\d)(?:19|20)\d{2}(?!\d)', fn):
        to_review.append((fn, f"author {a1} not in text")); continue
    cand = build(a1, a2, n, year)
    if cand.lower() == fn.lower():
        continue
    if cand.lower() in taken:
        ex = SRC / cand
        if ex.exists() and fhash(ex) == fhash(src):
            to_review.append((fn, f"duplicate of {cand}")); continue
        cand = L.free_disambiguated(cand, taken)
    taken.add(cand.lower()); rename_inplace.append((fn, cand, "paper"))

print(f"rename-in-place {len(rename_inplace)} | move-to-review {len(to_review)}")
print("\n  RENAME IN PLACE (stay in folder):")
for o, c, k in rename_inplace: print(f"    [{k}] {o[:44]:<46} -> {c}")
print("\n  MOVE TO REVIEW (sample):")
from collections import Counter
print("   reasons:", dict(Counter(w for _, w in to_review)))
for o, w in to_review[:20]: print(f"    {o[:50]:<52} [{w}]")

if GO:
    log = SRC / "vscode_sort.log"; ren = mov = 0
    with open(log, "a") as lf:
        for o, c, k in rename_inplace:
            s = SRC / o; d = SRC / c
            if s.exists() and not d.exists(): shutil.move(str(s), str(d)); lf.write(f"rename\t{o}\t{c}\n"); ren += 1
        for o, w in to_review:
            s = SRC / o; d = REVIEW / o
            if d.exists(): d = REVIEW / (o[:-4] + "_2.pdf")
            if s.exists(): shutil.move(str(s), str(d)); lf.write(f"review\t{o}\t{w}\n"); mov += 1
    print(f"\nrenamed-in-place {ren}; moved-to-review {mov}. log {log}")
else:
    print("\n(dry run; --go to apply)")
