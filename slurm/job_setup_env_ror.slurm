#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_setup
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/setup_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/setup_%j.err
#SBATCH --time=01:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G

# One-time setup: builds a fresh persistent venv on Rorqual.
# Compiled binaries are node/cluster-specific, so a venv from another cluster
# cannot be reused — this wipes any stale venv and rebuilds.
#
#   sbatch job_setup_env_ror.slurm
#
# Model weights already live in the shared cache /scratch/devon7y/huggingface
# (Qwen3.6-35B-A3B + Qwen3-Embedding-8B). This script only builds the venv.

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
HF_SHARED=/scratch/devon7y/huggingface

export HF_HOME=$HF_SHARED
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton

mkdir -p "$WORKDIR/logs" "$WORKDIR/cache" "$WORKDIR/vllm_endpoints_westbury_qwen3_32b"

module load python/3.11 gcc/12.3 cuda/12.6

echo "[$(date)] Removing any stale venv at $VENV_DIR ..."
rm -rf "$VENV_DIR"

echo "[$(date)] Creating fresh venv at $VENV_DIR ..."
python -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

echo "[$(date)] Installing packages..."
pip install --quiet uv
# PIN the vLLM nightly: unpinned nightlies regressed TP=2 (device=1,num_gpus=1
# placement bug) and the TP=2 shm-broadcast stability was validated ONLY on this
# build. Bump VLLM_PIN deliberately and re-run a multi-hour TP=2 soak (see
# docs/INGEST_EFFICIENCY_OPEN_PROBLEMS.md P3) before trusting a new build.
VLLM_PIN=${VLLM_PIN:-0.23.1rc1.dev245+g9037498c2}
uv pip install "vllm==${VLLM_PIN}" --pre --extra-index-url https://wheels.vllm.ai/nightly
uv pip install git+https://github.com/huggingface/transformers.git
pip install --quiet pypdf pymupdf tiktoken numpy   # pymupdf: column-aware PDF extraction
pip install --quiet "accelerate>=1.1.0" bitsandbytes sentence-transformers
# LightRAG: install the nested upstream source shipped alongside this repo.
pip install "$WORKDIR/LightRAG"
pip install --quiet qdrant-client certifi
python -c "import lightrag; from lightrag import LightRAG" \
  || { echo "[$(date)] ERROR: LightRAG import failed after install"; exit 1; }
echo "[$(date)] Packages installed."

echo "[$(date)] Verifying model weights in the shared cache..."
python3 -c "
from pathlib import Path
hf = Path('$HF_SHARED/hub')
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
