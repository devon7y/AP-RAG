"""Refresh public/data/papers.json from the canonical paper database.

The atlas paper table is born in a full layout run (hpc_layout.py → pack_full.py)
and then freezes, while the canonical database — data/papers_metadata.json — keeps
moving: new records, corrected titles/authors/dates, and file renames (logged to
data/rename_log.jsonl by the academic-pdfs intake). This script re-syncs the
bibliographic HALF of every row in place, without touching the geometry half
(centroid/centroid3/nChunks) and without ever reordering rows — papermeta.json,
authors.json, author_game.json and atlas.bin all join on this row order.

Run it (then export_metadata.py, then build_cluster_trends.py) whenever the
canonical database changes; scripts/propagate_papers.sh does exactly that.

What it cannot do: give geometry to papers that were added after the last layout
run. Those show up in every PC-backed feature immediately but appear on the
atlas map only after the next hpc_layout.py run; they are counted in the report.
"""

import ast
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
PUB = HERE.parent / "public" / "data"
DATA = HERE.parent.parent / "data"

PAPERS_P = PUB / "papers.json"
MANIFEST_P = DATA / "papers_metadata.json"
RENAME_LOG_P = DATA / "rename_log.jsonl"

ABSTRACT_CAP = 320  # matches hpc_layout.py


def _author_list(rec) -> list:
    v = rec.get("authors")
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        try:
            return ast.literal_eval(v)
        except Exception:
            return []
    return []


def _initials(given: str) -> str:
    return " ".join(f"{x[0]}." for x in re.split(r"[\s\-]+", (given or "").strip()) if x)


def short_authors(rec) -> str:
    au = _author_list(rec)
    fams = [a.get("family", "") for a in au if isinstance(a, dict) and a.get("family")]
    if not fams:
        return ""
    if len(fams) == 1:
        return fams[0]
    if len(fams) == 2:
        return f"{fams[0]} & {fams[1]}"
    return f"{fams[0]} et al."


def rec_year(rec: dict, filename: str) -> int:
    m = re.search(r"(19|20)\d\d", str(rec.get("year", "")))
    if m:
        return int(m.group(0))
    m = re.search(r"(19|20)\d\d", filename)
    return int(m.group(0)) if m else 0


def rename_map() -> dict[str, str]:
    """old filename → latest filename, chains followed."""
    step: dict[str, str] = {}
    if RENAME_LOG_P.exists():
        for line in RENAME_LOG_P.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("old") and e.get("new"):
                step[e["old"]] = e["new"]
    out: dict[str, str] = {}
    for old in step:
        cur, hops = old, 0
        while cur in step and hops < 50:
            cur = step[cur]
            hops += 1
        if cur != old:
            out[old] = cur
    return out


def main() -> None:
    papers = json.loads(PAPERS_P.read_text())
    manifest = json.loads(MANIFEST_P.read_text())
    renames = rename_map()

    in_table = {p["file"] for p in papers}
    renamed = updated = 0
    atlas_only: list[str] = []

    for p in papers:
        f = p["file"]
        # a rename since the layout run: adopt the new key so the manifest,
        # drive map, PC /papers and /pdf all line up again
        latest = renames.get(f)
        if latest and f not in manifest and latest in manifest and latest not in in_table:
            in_table.discard(f)
            in_table.add(latest)
            p["file"] = f = latest
            renamed += 1

        rec = manifest.get(f)
        if rec is None:
            atlas_only.append(f)
            continue
        p["title"] = rec.get("title") or f.replace(".pdf", "").replace("_", " ")
        p["authors"] = short_authors(rec) or f.split("_")[0]
        p["year"] = rec_year(rec, f)
        p["journal"] = rec.get("container_title", "")
        p["doi"] = rec.get("doi", "")
        p["abstract"] = (rec.get("abstract") or "")[:ABSTRACT_CAP]
        p["authorsFull"] = [
            f"{a['family']}, {_initials(a.get('given'))}".strip().rstrip(",")
            for a in _author_list(rec)
            if isinstance(a, dict) and a.get("family")
        ][:25]
        updated += 1

    pending_layout = sorted(set(manifest) - in_table)

    PAPERS_P.write_text(json.dumps(papers, separators=(",", ":")))
    print(f"wrote {PAPERS_P} ({PAPERS_P.stat().st_size / 1e6:.2f} MB)")
    print(f"refreshed {updated}/{len(papers)} rows from the canonical database")
    print(f"renames applied: {renamed}")
    print(f"atlas-only (no manifest record — removed/renamed papers or missing "
          f"metadata): {len(atlas_only)}")
    print(f"pending layout (in the database, not yet on the map): {len(pending_layout)}")
    if pending_layout[:10]:
        for f in pending_layout[:10]:
            print(f"  + {f}")
        if len(pending_layout) > 10:
            print(f"  … and {len(pending_layout) - 10} more")


if __name__ == "__main__":
    main()
