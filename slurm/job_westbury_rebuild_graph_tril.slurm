#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_rebuild_graph
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_rebuild_graph_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_rebuild_graph_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --partition=compute
#SBATCH --gpus-per-node=h100:1

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export BNB_CUDA_VERSION=126
export SENTENCE_TRANSFORMERS_HOME=$WORKDIR/hf_cache/hub
export PYTORCH_ALLOC_CONF=expandable_segments:True

mkdir -p "$WORKDIR/logs" "$WORKDIR/cache"

# ── Graphml backup/restore guard ─────────────────────────────────────────────
GRAPHML="$WORKDIR/rag_storage_westbury_qwen3_32b/graph_chunk_entity_relation.graphml"
GRAPHML_BAK="$WORKDIR/rag_storage_westbury_qwen3_32b/graph_chunk_entity_relation.graphml.bak"
if [ -s "$GRAPHML" ]; then
    cp "$GRAPHML" "$GRAPHML_BAK"
    echo "[$(date)] Graphml backed up ($(du -sh "$GRAPHML" | cut -f1))."
fi
restore_graphml() {
    if [ ! -s "$GRAPHML" ] && [ -s "$GRAPHML_BAK" ]; then
        cp "$GRAPHML_BAK" "$GRAPHML"
        echo "[$(date)] Graphml was empty — restored from backup ($(du -sh "$GRAPHML" | cut -f1))."
    fi
}
trap restore_graphml EXIT

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env_tril.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

echo "[$(date)] Starting graph rebuild (no vLLM, no embeddings — cache hits only)…"

WORKDIR=$WORKDIR \
STORAGE_SUBDIR=${STORAGE_SUBDIR:-rag_storage_westbury_qwen3_32b} \
PARALLEL_DOCS=${PARALLEL_DOCS:-8} \
LLM_MAX_ASYNC=${LLM_MAX_ASYNC:-16} \
  python "$WORKDIR/scripts/rebuild_graph.py"

EXIT_CODE=$?
echo "[$(date)] Graph rebuild finished with exit code $EXIT_CODE."

exit $EXIT_CODE
