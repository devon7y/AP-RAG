#!/usr/bin/env bash
# refresh_dates.sh — reproducible publication-date refresh for the APA manifest.
#
# Run this after adding papers (i.e. after `add_papers.py promote`). Every stage is
# idempotent and cached, so it only does work for records that are still non-day and DOIs
# it has not looked up before — safe to re-run any time.
#
#   scripts/refresh_dates.sh              # metadata stages only (Crossref/PubMed/OpenAlex/S2/…)
#   scripts/refresh_dates.sh --llm        # also run the gpt-5-mini Batch pass over the PDFs
#   scripts/refresh_dates.sh --llm --deploy   # …and deploy the manifest to the PC + restart
#
# Env: OPENAI_API_KEY (auto-loaded from ~/.zshrc if unset). Optional NCBI_API_KEY (PubMed
# 10/s vs 3/s), S2_API_KEY (Semantic Scholar quota).
set -euo pipefail
cd "$(dirname "$0")/.."

DO_LLM=0; DO_DEPLOY=0
for a in "$@"; do
  case "$a" in --llm) DO_LLM=1;; --deploy) DO_DEPLOY=1;; esac
done

if [ -z "${OPENAI_API_KEY:-}" ]; then
  export OPENAI_API_KEY="$(grep -hE 'OPENAI_API_KEY' ~/.zshrc | head -1 | grep -oE 'sk-proj-[A-Za-z0-9_-]+' || true)"
fi

echo "== metadata date stages (idempotent, cached) =="
python3 scripts/backfill_dates.py all --since 1990

if [ "$DO_LLM" = 1 ]; then
  echo "== gpt-5-mini Batch: read the printed appearance date off remaining month/year PDFs =="
  python3 scripts/backfill_dates_llm.py submit --since 1990
  echo "-- polling batch until complete --"
  until python3 scripts/backfill_dates_llm.py collect 2>&1 | grep -q "precision-upgrades applied"; do
    sleep 120
  done
  python3 scripts/backfill_dates.py report
fi

if [ "$DO_DEPLOY" = 1 ]; then
  echo "== deploy canonical database (manifest + drive map) to PC + restart query server =="
  ssh -o ConnectTimeout=20 pc 'powershell -NoProfile -Command "Copy-Item C:\rag_server\papers_metadata.json C:\rag_server\papers_metadata.bak.json -Force; if (Test-Path C:\rag_server\drive_links.json) { Copy-Item C:\rag_server\drive_links.json C:\rag_server\drive_links.bak.json -Force }"'
  scp -o ConnectTimeout=30 data/papers_metadata.json "pc:C:/rag_server/papers_metadata.json"
  scp -o ConnectTimeout=30 data/drive_links.json "pc:C:/rag_server/drive_links.json"
  bash restart_aprag_pc.sh | grep manifest_papers
fi

echo "== done =="
