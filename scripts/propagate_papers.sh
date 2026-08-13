#!/usr/bin/env bash
# propagate_papers.sh — push the canonical paper database everywhere, in one command.
#
# The single source of truth is the pair at the repo root:
#
#     data/papers_metadata.json   bibliographic record per paper (THE database)
#     data/drive_links.json       filename → Google Drive webViewLink
#
# Everything every feature shows — chat citations, the Papers browser, trends,
# the digest header counts, the graph explorer's paper cards, and the atlas's
# metadata layers — derives from these two files. This script re-derives and
# re-deploys all of it after the database changes (papers added via the
# academic-pdfs intake or add_papers.py, dates refreshed, records corrected).
#
#   scripts/propagate_papers.sh                # everything below
#   scripts/propagate_papers.sh --skip-pc      # don't touch the PC (no deploy/restart)
#   scripts/propagate_papers.sh --skip-pdfs    # don't rsync PDFs to the PC
#   scripts/propagate_papers.sh --citations    # also refresh OpenAlex citations.json
#
# Steps:
#   1. sanity-check the database pair
#   2. rebuild the web app's derived metadata layers (papers.json bib fields,
#      papermeta/authors/author_game, cluster_trends) from the canonical files
#   3. deploy the database pair to the PC query server + restart it (its
#      manifest is cached in-process, so the restart is what makes it live)
#   4. rsync new PDFs to the PC for the in-app reader
#
# What this can NOT do (inherently batch, prints reminders):
#   - RAG retrieval / knowledge graph / digest content for new papers → HPC
#     ingest run (pipeline/ingest.py via slurm/)
#   - atlas map geometry for new papers → next layout run (web/data-pipeline/
#     hpc_layout.py → pack_full.py); until then new papers are in every list
#     but not on the map
#   - the live site reads web/public/data from the Vercel deploy → commit+push
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_PC=0; SKIP_PDFS=0; DO_CITATIONS=0
for a in "$@"; do
  case "$a" in
    --skip-pc) SKIP_PC=1;;
    --skip-pdfs) SKIP_PDFS=1;;
    --citations) DO_CITATIONS=1;;
    *) echo "unknown flag: $a" >&2; exit 2;;
  esac
done

PY="$PWD/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

echo "== 1/4 canonical database sanity =="
"$PY" - <<'EOF'
import json
m = json.load(open("data/papers_metadata.json"))
d = json.load(open("data/drive_links.json"))
assert isinstance(m, dict) and m, "papers_metadata.json is not a non-empty dict"
assert isinstance(d, dict) and d, "drive_links.json is not a non-empty dict"
print(f"papers_metadata.json: {len(m)} records")
print(f"drive_links.json:     {len(d)} links ({len(set(d) - set(m))} not in the manifest)")
EOF

echo
echo "== 2/4 web derived metadata (papers.json bib fields, papermeta/authors/author_game, cluster trends) =="
( cd web/data-pipeline && "$PY" refresh_paper_table.py )
( cd web/data-pipeline && "$PY" export_metadata.py )
( cd web/data-pipeline && "$PY" build_cluster_trends.py )
if [ "$DO_CITATIONS" = 1 ]; then
  echo "-- OpenAlex citation layer (network, incremental) --"
  "$PY" scripts/fetch_openalex.py
fi

if [ "$SKIP_PC" = 1 ]; then
  echo
  echo "== 3/4 PC deploy skipped (--skip-pc) =="
else
  echo
  echo "== 3/4 deploy database pair to PC + restart query server =="
  ssh -o ConnectTimeout=20 pc 'powershell -NoProfile -Command "Copy-Item C:\rag_server\papers_metadata.json C:\rag_server\papers_metadata.bak.json -Force; if (Test-Path C:\rag_server\drive_links.json) { Copy-Item C:\rag_server\drive_links.json C:\rag_server\drive_links.bak.json -Force }"'
  scp -o ConnectTimeout=30 data/papers_metadata.json "pc:C:/rag_server/papers_metadata.json"
  scp -o ConnectTimeout=30 data/drive_links.json "pc:C:/rag_server/drive_links.json"
  bash restart_aprag_pc.sh | grep -E "manifest_papers|drive" || true
fi

if [ "$SKIP_PDFS" = 1 ] || [ "$SKIP_PC" = 1 ]; then
  echo
  echo "== 4/4 PDF sync skipped =="
else
  echo
  echo "== 4/4 rsync PDFs to the PC =="
  bash scripts/sync_papers_to_pc.sh
fi

echo
echo "== done. still batch (run when due): =="
echo "  - HPC RAG ingest for new papers (pipeline/ingest.py via slurm/) — chat"
echo "    retrieval, graph and digest content only see ingested papers"
echo "  - atlas layout rebuild (web/data-pipeline/hpc_layout.py -> pack_full.py)"
echo "    to place new papers on the map; refresh_paper_table.py just reported"
echo "    how many are pending"
echo "  - commit + push web/public/data + web/server-data so Vercel serves the"
echo "    refreshed packs"
