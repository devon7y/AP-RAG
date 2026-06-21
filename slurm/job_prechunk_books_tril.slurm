#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=prechunk_books
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/prechunk_books_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/prechunk_books_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --gpus-per-node=h100:1
#SBATCH --partition=compute

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache

mkdir -p "$WORKDIR/logs" "$WORKDIR/rag_storage_westbury_qwen3_32b" "$WORKDIR/cache"

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env_tril.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

echo "[$(date)] Starting book pre-chunking (papers_large → book_chunk_cache.json)..."

WORKDIR=$WORKDIR \
PAPERS_SUBDIR=${PAPERS_SUBDIR:-papers_large} \
STORAGE_SUBDIR=${STORAGE_SUBDIR:-rag_storage_westbury_qwen3_32b} \
BOOK_CHUNK_TARGET_TOKENS=${BOOK_CHUNK_TARGET_TOKENS:-1000} \
BOOK_CHUNK_MAX_TOKENS=${BOOK_CHUNK_MAX_TOKENS:-1500} \
BOOK_CHUNK_MIN_TOKENS=${BOOK_CHUNK_MIN_TOKENS:-250} \
BOOK_CHUNK_OVERLAP_TOKENS=${BOOK_CHUNK_OVERLAP_TOKENS:-200} \
  PYTHONPATH="$WORKDIR" python "$WORKDIR/scripts/prechunk_books.py"

EXIT_CODE=$?
echo "[$(date)] Pre-chunking finished with exit code $EXIT_CODE."
exit $EXIT_CODE
