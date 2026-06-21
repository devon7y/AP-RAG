#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_setup
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/setup_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/setup_%j.err
#SBATCH --time=01:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G

# One-time setup: builds a persistent venv on Nibi.
# The venv from Rorqual cannot be reused (compiled binaries are node-specific).
#
# Run once before submitting ingest jobs:
#   sbatch job_setup_env_nibi.slurm
#
# Model weights are already in hf_cache/ (transferred from Rorqual via Globus).
# This script only builds the venv — no model downloads needed.

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton

mkdir -p "$WORKDIR/logs" "$WORKDIR/cache" "$WORKDIR/vllm_endpoints_westbury_qwen3_32b"

module load python/3.11 gcc/12.3 cuda/12.6

echo "[$(date)] Creating persistent venv at $VENV_DIR ..."
python -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

echo "[$(date)] Installing packages..."
pip install --quiet uv
uv pip install vllm --pre --extra-index-url https://wheels.vllm.ai/nightly
uv pip install git+https://github.com/huggingface/transformers.git
pip install --quiet pypdf tiktoken numpy
pip install --quiet "accelerate>=1.1.0" bitsandbytes sentence-transformers
pip install --quiet "git+https://github.com/devon7y/LightRAG.git"
echo "[$(date)] Packages installed."

echo "[$(date)] Verifying model weights are present..."
python3 -c "
from pathlib import Path
hf = Path('$WORKDIR/hf_cache/hub')
models = [
    'models--Qwen--Qwen3.6-35B-A3B',
    'models--Qwen--Qwen3-Embedding-8B',
]
for m in models:
    p = hf / m
    if p.exists():
        import subprocess
        size = subprocess.check_output(['du', '-sh', str(p)]).split()[0].decode()
        print(f'  OK  {m} ({size})')
    else:
        print(f'  MISSING  {m}')
"

echo "[$(date)] Setup complete."
echo "  venv  : $VENV_DIR"
echo "  models: $HF_HOME"
