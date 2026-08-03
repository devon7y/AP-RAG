"""Name the map's regions with an LLM, from each cluster's own vocabulary.

This is what fills the "Fly to a region" list: NavigatePanel only lists clusters
that carry a `name`. It is distinct from the terrain's PEAK labels, which come
from the knowledge graph (dominant paper -> best KG entity -> cluster terms) and
need no LLM at all.
"""
import json, os, sys, urllib.request
from pathlib import Path

PUB = Path(__file__).parent.parent / "public" / "data"
clusters = json.loads((PUB / "clusters.json").read_text())
todo = [c for c in clusters if not c.get("name")]
print(f"{len(todo)}/{len(clusters)} clusters need names")

payload = [{"id": c["id"], "nPapers": c["nPapers"], "terms": c["terms"][:12],
            "titles": c["sampleTitles"][:5]} for c in todo]
prompt = (
    "You are naming regions on a map of a cognitive-science research corpus.\n"
    "For each cluster below you get its most distinctive terms (c-TF-IDF) and a "
    "few representative paper titles.\n\n"
    "Return JSON: {\"names\":[{\"id\":<int>,\"name\":\"...\",\"flavor\":\"...\"}]}\n"
    "  name   2-4 words, the field or topic a researcher would recognise "
    "(e.g. 'Hippocampal Memory', 'Lexical Frequency'). Title Case. No numbering.\n"
    "  flavor one short clause describing what lives there.\n"
    "Every id must appear exactly once. Names must be distinct.\n\n"
    + json.dumps(payload)
)
req = urllib.request.Request(
    "https://api.openai.com/v1/chat/completions",
    data=json.dumps({
        "model": "gpt-5-mini",
        "messages": [{"role": "user", "content": prompt}],
        "response_format": {"type": "json_object"},
    }).encode(),
    headers={"Content-Type": "application/json",
             "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
    method="POST")
with urllib.request.urlopen(req, timeout=600) as r:
    out = json.load(r)
named = json.loads(out["choices"][0]["message"]["content"])["names"]
by_id = {int(n["id"]): n for n in named}
hit = 0
for c in clusters:
    n = by_id.get(c["id"])
    if n and n.get("name"):
        c["name"], c["flavor"] = n["name"].strip(), (n.get("flavor") or "").strip()
        hit += 1
(PUB / "clusters.json").write_text(json.dumps(clusters, separators=(",", ":")))
print(f"named {hit}/{len(clusters)}")
for c in sorted(clusters, key=lambda x: -x["size"])[:8]:
    print(f"  {c['size']:>6} chunks  {c['name']}  — {c['flavor'][:60]}")
