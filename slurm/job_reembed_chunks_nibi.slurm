#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=reembed_chunks
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/%x_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/%x_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=64G
#SBATCH --gpus=h100:1

# Re-embed ALL text chunks with bf16 Qwen3-Embedding-8B (SCALING_ISSUES.md §3.11
# recovery, done properly on H100 instead of the PC's 4-bit model). Reads the
# frozen snapshot_4397 store (byte-identical to the PC deployment) and writes
# fp16 vector shards for the PC to bulk-load into a float16 Qdrant collection.
# Single job, no chain, no vLLM needed.

set -u
WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

export STORAGE_DIR="${STORAGE_DIR:-$WORKDIR/snapshot_4397/rag_storage_full}"
export OUT_DIR="${OUT_DIR:-$WORKDIR/reembed_chunks_out}"
export EMBED_MODEL_ID="${EMBED_MODEL_ID:-Qwen/Qwen3-Embedding-8B}"
export EMBED_TORCH_DTYPE="${EMBED_TORCH_DTYPE:-bfloat16}"
export EMBED_BATCH="${EMBED_BATCH:-64}"
export EMBED_MAX_SEQ="${EMBED_MAX_SEQ:-4096}"

module load python/3.11 gcc/12.3 cuda/12.6 opencv
source "$VENV_DIR/bin/activate"

echo "[$(date)] Re-embedding chunks from $STORAGE_DIR -> $OUT_DIR"
python "$WORKDIR/reembed_chunks_hpc.py"
EXIT_CODE=$?
echo "[$(date)] Finished with exit code $EXIT_CODE"
ls -la "$OUT_DIR"
exit $EXIT_CODE
