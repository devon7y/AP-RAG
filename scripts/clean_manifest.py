#!/usr/bin/env python3
"""Clean an existing ``papers_metadata.json`` in place: fix the metadata-quality issues
that crept in from Crossref/LLM extraction. Backs up to ``<out>.bak`` first.

  * author/editor surnames: ALL-CAPS → proper case (WESTBURY → Westbury, MCGAUGH → McGaugh)
  * subjects: unify case ACROSS the corpus (psychometrics/Psychometrics → one) + dedup
  * affiliations: strip leading marker digits (2Brown → Brown) + trailing punctuation + dedup
  * keywords: lowercase + dedup
  * journals: expand abbreviated container titles (Cogn Neurodyn → Cognitive Neurodynamics)
    via one gpt-5-mini call (skip with --no-journals or if OPENAI_API_KEY is unset)

The per-record normalizers are reused from build_apa_manifest.normalize_record (so a
fresh build and a cleanup produce the same shapes); this script adds the cross-record
subject canonicalization and the journal expansion, which need the whole corpus.

Usage:  python3 clean_manifest.py [papers_metadata.json] [--no-journals]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_apa_manifest as b  # noqa: E402  (normalize_record + field normalizers)

# Container titles worth sending to the LLM for expansion: dotted abbreviations
# ("J. theor. Biol.") or common abbreviated tokens ("Cogn", "Neurosci", "Psychon"…).
_ABBREV_TOKENS = re.compile(
    r"\b(Cogn|Neurodyn|Psychol|Behav|Neurosci|Psychon|Bull|Rev|Annu|Exp|Mem|Lang|Biol|"
    r"Comput|Med|Sci|Proc|Natl|Acad|Int|Res|Affect|Nat|Dev|Clin|Soc|Hum|Percept|Mot|"
    r"Physiol|Q|Trans|Theor|Vet|Syst|Image|Assist|Interv|Sleep)\b", re.IGNORECASE)


def _looks_abbreviated(journal: str) -> bool:
    if not journal:
        return False
    if re.search(r"\b[A-Za-z]{1,7}\.", journal):   # a dotted abbreviation
        return True
    # token-based: short-ish title containing a known abbreviated token, no long words
    return bool(_ABBREV_TOKENS.search(journal)) and len(journal.split()) <= 6


def canonicalize_subjects(manifest: dict) -> int:
    """Unify subject casing across the corpus; return number of records changed."""
    votes: dict[str, Counter] = {}
    for rec in manifest.values():
        for s in rec.get("subjects") or []:
            s2 = re.sub(r"\s+", " ", s.strip())
            if s2:
                votes.setdefault(s2.lower(), Counter())[s2] += 1
    canon: dict[str, str] = {}
    for lc, counter in votes.items():
        cands = [v for v in counter if v != v.lower()] or list(counter)
        canon[lc] = max(cands, key=lambda v: (counter[v], sum(ch.isupper() for ch in v)))

    changed = 0
    for rec in manifest.values():
        seen: set[str] = set()
        out: list[str] = []
        for s in rec.get("subjects") or []:
            lc = re.sub(r"\s+", " ", s.strip()).lower()
            cv = canon.get(lc, s)
            if cv.lower() not in seen:
                seen.add(cv.lower())
                out.append(cv)
        if out != (rec.get("subjects") or []):
            changed += 1
        rec["subjects"] = out
    return changed


def expand_journals(manifest: dict, api_key: str) -> int:
    """Expand abbreviated container titles via one gpt-5-mini call; return # records changed."""
    import requests
    candidates = sorted({
        rec.get("container_title", "") for rec in manifest.values()
        if _looks_abbreviated(rec.get("container_title", ""))
    })
    if not candidates:
        print("no abbreviated journals detected.", file=sys.stderr)
        return 0
    print(f"expanding {len(candidates)} candidate journal name(s) via gpt-5-mini ...", file=sys.stderr)
    body = {
        "model": "gpt-5-mini",
        "messages": [
            {"role": "system", "content":
             "You expand abbreviated academic journal names to their full standard "
             "titles. If a name is ALREADY full, return it unchanged. Return ONLY a JSON "
             "object mapping each input string to its full title."},
            {"role": "user", "content": json.dumps(candidates)},
        ],
        "response_format": {"type": "json_object"},
        "reasoning_effort": "minimal",
        "max_completion_tokens": 4000,
    }
    r = requests.post("https://api.openai.com/v1/chat/completions",
                      headers={"Authorization": f"Bearer {api_key}"}, json=body, timeout=180)
    r.raise_for_status()
    mapping = json.loads(r.json()["choices"][0]["message"]["content"])
    # only accept genuine expansions (longer, different) to avoid shortening good titles
    expand = {k: v.strip() for k, v in mapping.items()
              if isinstance(v, str) and v.strip() and len(v.strip()) > len(k)}
    changed = 0
    for rec in manifest.values():
        ct = rec.get("container_title", "")
        if ct in expand:
            rec["container_title"] = expand[ct]
            changed += 1
    print(f"  expanded {len(expand)}/{len(candidates)} titles (e.g. "
          + "; ".join(f'{k!r}→{v!r}' for k, v in list(expand.items())[:3]) + ")", file=sys.stderr)
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", nargs="?", default="data/papers_metadata.json")
    ap.add_argument("--no-journals", action="store_true", help="skip the LLM journal expansion")
    args = ap.parse_args()

    path = Path(args.manifest)
    manifest = json.loads(path.read_text())
    print(f"loaded {len(manifest)} records from {path}", file=sys.stderr)

    # before-stats
    def caps_count():
        return sum(1 for r in manifest.values()
                   for a in (r.get("authors") or []) + (r.get("editors") or [])
                   if (a.get("family") or "") and a["family"] == a["family"].upper()
                   and a["family"] != a["family"].lower()
                   and not re.search(r"[^A-Za-z .'\-]", a["family"]))
    before_caps = caps_count()

    # 1. per-record normalizers (names, subjects-dedup, affiliations, keywords)
    for rec in manifest.values():
        b.normalize_record(rec)
    # 2. cross-record subject case unification
    subj_changed = canonicalize_subjects(manifest)
    # 3. journal expansion (optional)
    jrnl_changed = 0
    key = None if args.no_journals else __import__("os").environ.get("OPENAI_API_KEY")
    if key:
        try:
            jrnl_changed = expand_journals(manifest, key)
        except Exception as exc:  # never lose the rest of the cleanup on an API hiccup
            print(f"journal expansion failed ({exc!r}); skipping", file=sys.stderr)
    elif not args.no_journals:
        print("OPENAI_API_KEY unset — skipping journal expansion", file=sys.stderr)

    # back up the ORIGINAL (file on disk is untouched until the write below), then write cleaned
    bak = path.with_suffix(path.suffix + ".bak")
    if not bak.exists():
        bak.write_bytes(path.read_bytes())
    path.write_text(json.dumps(manifest, indent=1, ensure_ascii=False))

    print(f"\n=== cleaned {path} ===", file=sys.stderr)
    print(f"  author ALL-CAPS surnames fixed: {before_caps - caps_count()} (now {caps_count()} left)",
          file=sys.stderr)
    print(f"  records with subjects re-cased/deduped: {subj_changed}", file=sys.stderr)
    print(f"  records with journal expanded: {jrnl_changed}", file=sys.stderr)
    print(f"  backup: {bak}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
