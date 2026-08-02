#!/usr/bin/env python3
"""backfill_dates_llm.py — upgrade date precision by reading the *printed* publication
date off each PDF with gpt-5-mini (OpenAI Batch API), for records Crossref only dated to
the month/year.

The hard part is correctness: journal first pages print BOTH a submission-pipeline date
("Received 25 Jan 2007", "Accepted 4 Jul 2003") and an appearance date ("Published online
9 Jun 2018"). Only the appearance date is a valid "earliest public appearance"; the
Received/Accepted date can be a year early and would corrupt the axis. The prompt extracts
ONLY appearance dates and the model reports which label it used; we hard-reject the rest.

Merge rule (conservative): accept the model's day only when
  (a) label is an appearance label (published-online/available-online/first-published/
      published/posted/preprint-stamp), never received/accepted/submitted/revised; AND
  (b) same (year, month) as the existing Crossref date  -> upgrade month precision to day; OR
      strictly earlier than it with a clear online/posted label -> online-first correction.
Otherwise skip (keep the Crossref date).

Subcommands:
    test   --limit N     synchronous validation run (no manifest writes; prints yield)
    submit [--since Y]    build + submit the Batch API job over month/year-precision records
    collect               poll the batch; on completion apply the merge rule to the manifest
"""
from __future__ import annotations
import argparse, json, os, re, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_apa_manifest as bam
import backfill_dates as bd

MODEL = "gpt-5-mini"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"
STATE_FILE = bd.STATE / ".dates_llm_batch.json"

APPEARANCE_LABELS = {"published-online", "available-online", "first-published",
                     "published", "posted", "preprint-stamp", "issue-date"}
REJECT_LABELS = {"received", "accepted", "submitted", "revised", "none"}

SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "appearance_date": {"type": "string"},   # YYYY-MM-DD | YYYY-MM | ""
        "date_label": {"type": "string",
                       "enum": sorted(APPEARANCE_LABELS | REJECT_LABELS)},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["appearance_date", "date_label", "confidence"],
}

PROMPT = """You extract the single date a scholarly work FIRST BECAME PUBLICLY AVAILABLE, \
to the day if printed.

Look on the page for a PUBLICATION / APPEARANCE date, labelled one of: "Published online", \
"Available online", "First published", "Epub", "Published:", "Posted" (preprint), or an \
arXiv/bioRxiv/medRxiv/PsyArXiv version stamp (e.g. "arXiv:2005.14165 ... 28 May 2020", \
"posted May 20, 2020"). For a journal issue with only a month/season, that month is the \
appearance date.

CRITICAL — these are NOT appearance dates; never return them: "Received", "Accepted", \
"Submitted", "Revised", "In revised form", "Manuscript received", "Date of acceptance". \
They are submission-pipeline dates, often a year before publication. If ONLY such dates \
appear and there is no appearance date, return appearance_date "".

Return:
- appearance_date: "YYYY-MM-DD" if a full appearance date is printed; "YYYY-MM" if only \
month; "" if no valid appearance date is visible.
- date_label: which label you used (published-online / available-online / first-published \
/ published / posted / preprint-stamp / issue-date), or received / accepted / submitted / \
revised / none if no appearance date was usable.
- confidence: high/medium/low."""


def pdf_text(path: Path, pages: int = 2) -> str:
    try:
        return subprocess.run(["pdftotext", "-f", "1", "-l", str(pages), "-layout",
                               str(path), "-"], capture_output=True, timeout=60
                              ).stdout.decode("utf-8", "ignore")
    except Exception:
        return ""


def build_body(text: str) -> dict:
    return {"model": MODEL,
            "messages": [{"role": "system", "content": PROMPT},
                         {"role": "user", "content": "FIRST-PAGE TEXT:\n\n" + text[:7000]}],
            "response_format": {"type": "json_schema", "json_schema": {
                "name": "appdate", "strict": True, "schema": SCHEMA}},
            "reasoning_effort": "low", "max_completion_tokens": 900}


def _parse(d: str) -> tuple | None:
    m = re.match(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$", d.strip())
    if not m:
        return None
    y, mo, da = m.group(1), m.group(2), m.group(3)
    return (int(y), int(mo) if mo else None, int(da) if da else None)


def decide(llm: dict, existing_date: str) -> tuple[str, str] | None:
    """Return (new_iso, note) if the model's date should replace/refine the existing one."""
    label = (llm.get("date_label") or "none").lower()
    if label not in APPEARANCE_LABELS:
        return None
    p = _parse(llm.get("appearance_date") or "")
    if not p or p[1] is None:          # need at least a month
        return None
    ly, lm, ld = p
    e = _parse(existing_date or "")
    if not e:
        # no prior date: accept month/day as-is
        iso = f"{ly:04d}-{lm:02d}" + (f"-{ld:02d}" if ld else "")
        return iso, f"page:{label}"
    ey, em, ed = e
    online = label in {"published-online", "available-online", "posted",
                       "preprint-stamp", "first-published"}
    # existing is year-only: any same-year month/day is a precision gain; an earlier-year
    # online date is a valid online-first correction.
    if em is None:
        if ly == ey:
            iso = f"{ly:04d}-{lm:02d}" + (f"-{ld:02d}" if ld else "")
            return iso, f"page:{label}"
        if ly < ey and online:
            iso = f"{ly:04d}-{lm:02d}" + (f"-{ld:02d}" if ld else "")
            return iso, f"page-online-first:{label}"
        return None
    # existing has month precision: only a day adds information
    if ld is None:
        return None
    if (ly, lm) == (ey, em):
        return f"{ly:04d}-{lm:02d}-{ld:02d}", f"page:{label}"          # precision upgrade
    if (ly, lm) < (ey, em) and online:
        return f"{ly:04d}-{lm:02d}-{ld:02d}", f"page-online-first:{label}"  # earlier appearance
    return None


def _targets(manifest: dict, since: int) -> list[str]:
    out = []
    for fn, r in manifest.items():
        if not isinstance(r, dict):
            continue
        if r.get("date_precision") not in ("month", "year"):
            continue
        cy = bd.canonical_year(r)
        if cy is None or cy < since:
            continue
        out.append(fn)
    return out


def cmd_test(args):
    key = os.environ["OPENAI_API_KEY"]
    manifest = json.loads(bd.MANIFEST.read_text())
    targets = _targets(manifest, args.since)[:args.limit]
    print(f"test: {len(targets)} papers (sync)", flush=True)
    up = down = reject = none = 0
    lock = threading.Lock()

    def run(fn):
        text = pdf_text(bd.PAPERS / fn)
        if len(text.strip()) < 100:
            return fn, None, "no-text"
        body = build_body(text)
        try:
            r = requests.post(OPENAI_URL, headers={"Authorization": f"Bearer {key}"},
                              json=body, timeout=120)
            llm = json.loads(r.json()["choices"][0]["message"]["content"])
        except Exception as e:
            return fn, None, f"err:{e}"
        return fn, llm, manifest[fn].get("date")

    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for fn, llm, existing in ex.map(run, targets):
            if not isinstance(llm, dict):
                none += 1; continue
            d = decide(llm, existing)
            if d:
                iso, note = d
                if "online-first" in note:
                    down += 1
                else:
                    up += 1
                print(f"  UPGRADE {existing}->{iso:12} [{llm.get('date_label')}] {fn[:34]}")
            elif (llm.get("date_label") or "none").lower() in REJECT_LABELS:
                reject += 1
            else:
                none += 1
    tot = len(targets)
    print(f"\ntest yield: {up} precision-upgrades + {down} online-first corrections "
          f"= {up+down}/{tot} usable ({100*(up+down)/max(tot,1):.0f}%); "
          f"{reject} had only received/accepted, {none} none/no-day")


def cmd_submit(args):
    manifest = json.loads(bd.MANIFEST.read_text())
    targets = _targets(manifest, args.since)
    if args.limit:
        targets = targets[:args.limit]
    print(f"submit: building batch for {len(targets)} month/year-precision papers "
          f"(since {args.since})", flush=True)
    jsonl = bd.STATE / "dates_llm_requests.jsonl"
    n = 0
    with jsonl.open("w") as f:
        for fn in targets:
            text = pdf_text(bd.PAPERS / fn)
            if len(text.strip()) < 100:
                continue
            req = {"custom_id": fn, "method": "POST", "url": "/v1/chat/completions",
                   "body": build_body(text)}
            f.write(json.dumps(req) + "\n"); n += 1
            if n % 500 == 0:
                print(f"  built {n} requests...", flush=True)
    print(f"  {n} requests -> {jsonl}", flush=True)
    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}
    batch_id = bam._upload_and_create(str(jsonl), headers)
    STATE_FILE.write_text(json.dumps({"batch_id": batch_id, "since": args.since, "n": n}))
    print(f"submitted batch {batch_id} ({n} requests). Poll with: backfill_dates_llm.py collect")


def cmd_collect(args):
    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}
    state = json.loads(STATE_FILE.read_text())
    info = bam._batch_info(state["batch_id"], headers)
    status = info.get("status")
    counts = info.get("request_counts", {})
    print(f"batch {state['batch_id']}: {status}  {counts}", flush=True)
    if status != "completed":
        print("not complete yet; re-run collect later."); return
    out_id = info.get("output_file_id")
    content = requests.get(f"https://api.openai.com/v1/files/{out_id}/content",
                           headers=headers, timeout=600).text
    manifest = json.loads(bd.MANIFEST.read_text())
    up = down = 0
    for line in content.splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        fn = row.get("custom_id")
        try:
            llm = json.loads(row["response"]["body"]["choices"][0]["message"]["content"])
        except Exception:
            continue
        rec = manifest.get(fn)
        if not isinstance(rec, dict):
            continue
        d = decide(llm, rec.get("date"))
        if d:
            iso, note = d
            prec = "day" if len(iso) == 10 else "month"
            bd.stamp_date(rec, iso, prec, "page_llm")
            if "online-first" in note:
                down += 1
            else:
                up += 1
    bd.MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"collect: {up} precision-upgrades + {down} online-first corrections applied "
          f"-> {bd.MANIFEST}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pt = sub.add_parser("test"); pt.add_argument("--limit", type=int, default=40)
    pt.add_argument("--jobs", type=int, default=8); pt.add_argument("--since", type=int, default=2000)
    ps = sub.add_parser("submit"); ps.add_argument("--limit", type=int, default=0)
    ps.add_argument("--since", type=int, default=2000)
    sub.add_parser("collect")
    args = ap.parse_args()
    return {"test": cmd_test, "submit": cmd_submit, "collect": cmd_collect}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
