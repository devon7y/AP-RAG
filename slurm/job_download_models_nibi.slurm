#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_dl_models
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/dl_models_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/dl_models_%j.err
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G

# One-time prep: download the current-generation model weights into hf_cache/hub.
# Nibi compute nodes have outbound internet, so this runs as a normal job.
#   LLM (ingest):       Qwen/Qwen3.6-35B-A3B   (BF16 MoE, ~70 GB) -> served on 2x H100
#   Embedding (ingest): Qwen/Qwen3-Embedding-8B (~16 GB)          -> served on 1x H100
# Downloaded into the HF hub cache layout (models--Qwen--...) that the
# vLLM / ingest jobs expect with HF_HUB_OFFLINE=1.

set -euo pipefail

WORKDIR=/scratch/devon7y/westbury_rag
export HF_HOME=$WORKDIR/hf_cache
export HF_XET_HIGH_PERFORMANCE=1          # fast Xet transfer (replaces deprecated HF_HUB_ENABLE_HF_TRANSFER)
export PATH=$HOME/.local/bin:$PATH

mkdir -p "$WORKDIR/logs" "$HF_HOME"

module load python/3.11

echo "[$(date)] Installing/upgrading huggingface_hub (user site)..."
pip install --user --quiet --upgrade "huggingface_hub[hf_xet]"

# Newer huggingface_hub ships the `hf` CLI; `huggingface-cli` is deprecated and no-ops.
HFCLI=$(command -v hf || true)
if [ -z "$HFCLI" ]; then
  echo "[$(date)] ERROR: 'hf' CLI not found on PATH after install." >&2
  exit 1
fi
echo "[$(date)] Using HF CLI: $HFCLI ($($HFCLI version 2>/dev/null || echo '?'))"

for REPO in "Qwen/Qwen3.6-35B-A3B" "Qwen/Qwen3-Embedding-8B"; do
  echo "[$(date)] Downloading $REPO ..."
  "$HFCLI" download "$REPO"
  echo "[$(date)] Finished $REPO"
done

echo "[$(date)] Verifying weights are present in the hub cache..."
fail=0
for M in "models--Qwen--Qwen3.6-35B-A3B" "models--Qwen--Qwen3-Embedding-8B"; do
  P="$HF_HOME/hub/$M"
  if [ -d "$P" ] && [ -n "$(find "$P/snapshots" -name '*.safetensors' 2>/dev/null | head -1)" ]; then
    echo "  OK  $M ($(du -sh "$P" | cut -f1))"
  else
    echo "  MISSING/INCOMPLETE  $M" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "[$(date)] ERROR: one or more models did not download completely." >&2
  exit 1
fi
echo "[$(date)] All model weights present."
