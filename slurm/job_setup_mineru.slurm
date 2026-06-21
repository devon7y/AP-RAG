#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_mineru_setup
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/mineru_setup_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/mineru_setup_%j.err
#SBATCH --time=01:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G

# One-time setup for the MinerU parser service (separate venv from the ingest venv,
# since MinerU pulls a heavy ML stack that must not perturb the ingest environment).
#
# Run once on Fir (has internet) before submitting job_westbury_mineru.slurm:
#   sbatch job_setup_mineru.slurm
#
# Builds venv_mineru, installs MinerU, and pre-downloads the PIPELINE-backend models
# (layout / OCR / table / formula) into hf_cache so the service starts quickly. For
# the OFFLINE clusters (Nibi/Trillium/Narval), Globus-transfer venv_mineru's model
# cache + set MINERU_MODEL_SOURCE=local in job_westbury_mineru.slurm (PHASE 2).
#
# NOTE (validate on Fir): the exact MinerU pip extra and the models-download CLI
# differ across MinerU releases. Adjust the two commands flagged "VERIFY" below to
# match the installed version (see https://github.com/opendatalab/MinerU).

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_mineru

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export MINERU_MODEL_SOURCE=huggingface

mkdir -p "$WORKDIR/logs" "$WORKDIR/hf_cache" "$WORKDIR/cache" "$WORKDIR/mineru_endpoints"

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

echo "[$(date)] Creating MinerU venv at $VENV_DIR ..."
python -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip

# VERIFY: pip extra for the API server (pipeline backend) on the installed MinerU.
echo "[$(date)] Installing MinerU (core + API server)..."
pip install --quiet -U "mineru[core]"

# VERIFY: pre-download the pipeline-backend models (layout/OCR/table/formula).
echo "[$(date)] Pre-downloading MinerU pipeline models..."
mineru-models-download -s huggingface -m pipeline || \
  echo "[$(date)] WARNING: model pre-download step failed/changed — models will download lazily on first parse (OK on Fir; NOT ok offline)."

echo "[$(date)] Verifying mineru-api entrypoint is present..."
command -v mineru-api && mineru-api --help 2>&1 | head -5 || \
  echo "[$(date)] WARNING: mineru-api not found — check the install extra (VERIFY)."

echo "[$(date)] Setup complete."
echo "  venv  : $VENV_DIR"
echo "  models: $HF_HOME"
