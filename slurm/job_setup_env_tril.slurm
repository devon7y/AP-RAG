#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_setup
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/setup_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/setup_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --partition=compute
#SBATCH --gpus-per-node=h100:1

# One-time setup: builds a persistent venv on Trillium.
# The venv from Nibi cannot be reused (compiled binaries are node-specific).
#
# Run once before submitting ingest jobs:
#   sbatch job_setup_env_tril.slurm

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton

mkdir -p "$WORKDIR/logs" "$WORKDIR/cache" "$WORKDIR/vllm_endpoints_westbury_qwen3_32b"

module load python/3.11 gcc/12.3 cuda/12.6

echo "[$(date)] Creating persistent venv at $VENV_DIR ..."
python -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

echo "[$(date)] Installing opencv-python-headless from PyPI (required before vllm)..."
pip install opencv-python-headless

echo "[$(date)] Uninstalling any pre-installed vllm..."
pip uninstall -y vllm 2>/dev/null || true

echo "[$(date)] Installing vllm 0.17.1+computecanada from wheelhouse..."
pip install --no-index vllm==0.17.1+computecanada
# py-spy for the vLLM hang watchdog (offline node: wheelhouse only)
pip install --no-index py-spy 2>/dev/null || echo "[setup] py-spy not in wheelhouse - hang diagnostics will note it as missing"

echo "[$(date)] Installing remaining packages..."
pip install --quiet --no-index pypdf tiktoken numpy
pip install --quiet --no-index "accelerate>=1.1.0" bitsandbytes sentence-transformers
pip install --quiet pypdf pymupdf tiktoken  # ensure latest from PyPI as fallback (pymupdf: column-aware extraction)
pip install --quiet "git+https://github.com/devon7y/LightRAG.git"
pip install --quiet qdrant-client

echo "[$(date)] Verifying vllm version..."
python3 -c "import vllm; print('vllm version:', vllm.__version__)"

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
