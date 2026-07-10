#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=reembed_chunks
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/%x_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/%x_%j.err
#SBATCH --time=01:30:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=64G
#SBATCH --gpus=a100:1

# Narval variant of job_reembed_chunks_nibi.slurm — races the Nibi copy; the
# Mac orchestrator takes whichever cluster's REEMBED_DONE appears first and
# scancels the loser. Narval specifics: A100 syntax, NO compute-node internet
# (model pre-staged in hf_cache, offline flags mandatory), 1 h minimum job,
# EMBED_BATCH halved (40 GB vs 80 GB VRAM).

set -u
WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

export STORAGE_DIR="${STORAGE_DIR:-$WORKDIR/reembed_in}"
export OUT_DIR="${OUT_DIR:-$WORKDIR/reembed_chunks_out}"
export EMBED_MODEL_ID="${EMBED_MODEL_ID:-Qwen/Qwen3-Embedding-8B}"
export EMBED_TORCH_DTYPE="${EMBED_TORCH_DTYPE:-bfloat16}"
export EMBED_BATCH="${EMBED_BATCH:-32}"
export EMBED_MAX_SEQ="${EMBED_MAX_SEQ:-4096}"

module load python/3.11 gcc/12.3 cuda/12.6
source "$VENV_DIR/bin/activate"

echo "[$(date)] Re-embedding chunks from $STORAGE_DIR -> $OUT_DIR (A100)"
python "$WORKDIR/reembed_chunks_hpc.py"
EXIT_CODE=$?
echo "[$(date)] Finished with exit code $EXIT_CODE"
ls -la "$OUT_DIR"
exit $EXIT_CODE
