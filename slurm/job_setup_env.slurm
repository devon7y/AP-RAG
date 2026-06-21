#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_setup
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/setup_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/setup_%j.err
#SBATCH --time=01:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G

# One-time setup job: builds a persistent venv and pre-downloads all model
# weights into scratch so job_westbury_1gpu.slurm starts in ~seconds.
#
# Run once before submitting ingest jobs:
#   sbatch job_setup_env.slurm
#
# Re-run whenever you want to update vllm nightly or LightRAG.
# Safe to re-run: overwrites the existing venv in place.

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton

mkdir -p "$WORKDIR/logs" "$WORKDIR/hf_cache" "$WORKDIR/cache"

module load python/3.11 gcc/12.3 opencv/4.13.0

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

# ── Pre-download model weights ────────────────────────────────────────────────
echo "[$(date)] Pre-downloading Qwen/Qwen3.5-0.8B (~1.6GB, used for smoke tests)..."
python -c "
from huggingface_hub import snapshot_download
snapshot_download('Qwen/Qwen3.5-0.8B')
print('Qwen3.5-0.8B download complete.')
"

echo "[$(date)] Pre-downloading Qwen/Qwen3.5-27B-FP8 (~27GB)..."
python -c "
from huggingface_hub import snapshot_download
snapshot_download('Qwen/Qwen3.5-27B-FP8')
print('Qwen3.5-27B-FP8 download complete.')
"

echo "[$(date)] Pre-downloading Octen/Octen-Embedding-8B-INT8 (~8GB)..."
python -c "
from huggingface_hub import snapshot_download
snapshot_download('Octen/Octen-Embedding-8B-INT8')
print('Octen-Embedding-8B-INT8 download complete.')
"

echo "[$(date)] Setup complete."
echo "  venv : $VENV_DIR"
echo "  models: $HF_HOME"
du -sh "$HF_HOME"
