#!/usr/bin/env python3
"""Name the review-folder PDFs from the review_final batch results, recovering a
missing year from the filename / arXiv id / DOI->Crossref, then move confirmed
papers into Papers/ (collision/dup-safe). Genuine non-papers (front matter,
indexes, undated) are left in review. Dry-run unless --go."""
import hashlib, json, os, re, shutil, sys
from pathlib import Path
import requests
sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_pdf_names as vpn
import llm_rename as L

REVIEW = Path("/Users/devon7y/Papers_needs_review")
PAPERS = Path("/Users/devon7y/Papers")
KEY = os.environ["OPENAI_API_KEY"]
GO = "--go" in sys.argv

st = json.load(open(".batch_rename_review_final.json")); cmap = st["map"]
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

def arxiv_year(n):
    m = re.search(r'(?<!\d)(\d{2})(\d{2})\.\d{4,5}(?!\d)', n)
    return f"20{m.group(1)}" if m and 1 <= int(m.group(2)) <= 12 else None
def filename_year(n):
    ys = [y for y in re.findall(r'(?<!\d)(?:19|20)\d{2}(?!\d)', n) if 1950 <= int(y) <= 2026]
    return ys[-1] if ys else None
def fhash(p):
    h = hashlib.sha1(); h.update(str(p.stat().st_size).encode())
    with open(p, "rb") as f: h.update(f.read(1 << 20))
    return h.hexdigest()

# rename IN PLACE within the review folder; do NOT move to Papers/.
taken = {p.name.lower() for p in REVIEW.iterdir() if p.suffix.lower() == ".pdf"}
cache = {}
EXCLUDE_KINDS = {"front-matter", "news", "form-or-scale", "software-manual", "supplementary"}
FRONTMATTER_RE = re.compile(r"_pp_|Contents|Contributor|Acknowledg|Bibliograph|Index|Series_page|Works_by|Author-Index|Front-matter", re.I)
named, manual = [], []
for fn, r in res.items():
    src = REVIEW / fn
    if not src.exists(): continue
    if FRONTMATTER_RE.search(fn):
        manual.append((fn, "front-matter")); continue
    if not r or not r.get("is_citable_work") or not r.get("first_author_surname") \
            or r.get("document_kind") in EXCLUDE_KINDS:
        manual.append((fn, r.get("document_kind", "?") if r else "no-result")); continue
    a1 = vpn.ascii_name(r["first_author_surname"])
    if a1.isupper() and len(a1) > 1: a1 = vpn.titlecase_surname(a1)
    txt = L.first_pages_text(src, pages=2)
    ym = re.search(r"(1[5-9]\d{2}|20\d{2})", str(r.get("year", "")))
    year = ym.group(0) if ym else (filename_year(fn) or arxiv_year(fn))
    if not year:                                       # last resort: DOI -> Crossref
        m = vpn.DOI_RE.search(txt)
        if m:
            rec = vpn.crossref_lookup(m.group(0).rstrip(".,;)"), "devon7y@gmail.com", cache)
            if rec and rec.get("year"):
                year = rec["year"]
                if rec.get("family"): a1 = vpn.ascii_name(rec["family"])
    if not a1 or not year:
        manual.append((fn, "no-year")); continue
    # loose verify: only reject if there IS text and the author is absent and the year wasn't external
    if len(txt.strip()) >= 200 and vpn.surname_in_text(a1, txt) == "no" and not (filename_year(fn) or arxiv_year(fn)):
        manual.append((fn, f"author {a1} not in text")); continue
    try: n = int(r.get("num_authors") or 0)
    except (TypeError, ValueError): n = 0
    a2 = vpn.ascii_name(r.get("second_author_surname", "") or "")
    if a2.isupper() and len(a2) > 1: a2 = vpn.titlecase_surname(a2)
    if n >= 3 or (n == 2 and not a2): cand = vpn.canonical_name(a1, "Etal", year)
    elif n == 2: cand = vpn.canonical_name(a1, a2, year)
    else: cand = vpn.canonical_name(a1, "", year)
    if cand.lower() == fn.lower():
        continue                                   # already correctly named
    if cand.lower() in taken:
        cand = L.free_disambiguated(cand, taken)   # avoid clashing with another review file
    taken.add(cand.lower())
    named.append((fn, cand))

print(f"renamed-in-place {len(named)} | still-manual {len(manual)}  (all stay in review)")
print("  sample names:")
for o, c in named[:20]: print(f"    {o[:42]:<44} -> {c}")
from collections import Counter
print("  manual reasons:", dict(Counter(w for _, w in manual)))
# write a rich manifest for the user's manual review (LLM author/title/year for the unresolved ones)
with open("review_naming_proposed.tsv", "w") as f:
    f.write("# status\told_name\tnew_name\treason\tllm_author\tllm_year\tllm_kind\tllm_title\n")
    for o, c in named:
        f.write(f"RENAMED\t{o}\t{c}\t\t\t\t\t\n")
    for o, w in manual:
        r = res.get(o) or {}
        f.write(f"manual\t{o}\t\t{w}\t{r.get('first_author_surname','')}\t"
                f"{r.get('year','')}\t{r.get('document_kind','')}\t{(r.get('title') or '')[:70]}\n")
if GO:
    log = REVIEW / "name_review.log"; k = 0
    with open(log, "a") as lf:
        for o, c in named:
            s = REVIEW / o; d = REVIEW / c
            if s.exists() and not d.exists():
                shutil.move(str(s), str(d)); lf.write(f"{o}\t{c}\n"); k += 1
    print(f"\nrenamed {k} in place within {REVIEW.name}/ (nothing moved to Papers/). log {log}")
    print("  full proposal manifest: review_naming_proposed.tsv")
else:
    print("\n(dry run; --go to apply — renames happen IN PLACE in the review folder)")
