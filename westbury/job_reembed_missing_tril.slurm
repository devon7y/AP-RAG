#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_reembed
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_reembed_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_reembed_%j.err
#SBATCH --time=12:00:00
#SBATCH --nodes=1
#SBATCH --partition=compute
#SBATCH --gpus-per-node=h100:1
#SBATCH --cpus-per-task=6

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export SENTENCE_TRANSFORMERS_HOME=$WORKDIR/hf_cache/hub
export BNB_CUDA_VERSION=126

mkdir -p "$WORKDIR/logs"

module load python/3.11 gcc/12.3 cuda/12.6

if [ ! -f "$VENV_DIR/bin/activate" ]; then
    echo "[$(date)] ERROR: venv not found at $VENV_DIR"
    exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready."

# ── Start Qdrant sidecar directly on Lustre (no copy — progress survives kills) ─
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_STORAGE="$WORKDIR/qdrant_storage_westbury"
QDRANT_PID=""
PYTHON_PID=""

if [ ! -f "$QDRANT_SIF" ]; then
    echo "[$(date)] ERROR: Qdrant SIF not found at $QDRANT_SIF"
    exit 1
fi

mkdir -p "$QDRANT_STORAGE"

# ── Cleanup trap: gracefully stop Python and Qdrant on SIGTERM ───────────────
cleanup() {
    echo "[$(date)] Caught signal — stopping Python and Qdrant..."
    kill "$PYTHON_PID" 2>/dev/null
    wait "$PYTHON_PID" 2>/dev/null
    kill "$QDRANT_PID" 2>/dev/null
    wait "$QDRANT_PID" 2>/dev/null
    echo "[$(date)] Shutdown complete. Progress is already on Lustre."
    exit 1
}
trap cleanup SIGTERM SIGINT

module load apptainer 2>/dev/null || true
echo "[$(date)] Starting Qdrant sidecar (storage: $QDRANT_STORAGE)..."
apptainer run --writable-tmpfs --pwd /qdrant \
    --env QDRANT__TELEMETRY_DISABLED=true \
    --env QDRANT__SERVICE__MAX_REQUEST_SIZE_MB=256 \
    --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    --env SSL_CERT_DIR=/etc/ssl/certs \
    --bind /etc/ssl/certs:/etc/ssl/certs \
    --bind "$QDRANT_STORAGE:/qdrant/storage" "$QDRANT_SIF" &
QDRANT_PID=$!

for i in $(seq 1 72); do
    if curl -sf "http://localhost:6333/healthz" > /dev/null 2>&1; then
        echo "[$(date)] Qdrant ready after $((i * 5))s"
        break
    fi
    if [ $i -eq 72 ]; then
        echo "[$(date)] ERROR: Qdrant did not start in 6 min."
        kill $QDRANT_PID 2>/dev/null
        exit 1
    fi
    sleep 5
done

# ── Run re-embed ──────────────────────────────────────────────────────────────
echo "[$(date)] Starting re-embedding of missing docs..."
WORKDIR=$WORKDIR \
STORAGE_SUBDIR=rag_storage_westbury_qwen3_32b \
QDRANT_URL=http://localhost:6333 \
REBUILD_EMBEDDINGS=1 \
REBUILD_BATCH_SIZE=256 \
EMBED_BATCH=32 \
EMBEDDING_BATCH_NUM=32 \
EMBED_FUNC_MAX_ASYNC=1 \
    python "$WORKDIR/ingest_cml_octen_v2.py" &
PYTHON_PID=$!
wait $PYTHON_PID
EXIT_CODE=$?
echo "[$(date)] Re-embedding finished with exit code $EXIT_CODE."

# ── Stop Qdrant ───────────────────────────────────────────────────────────────
kill $QDRANT_PID 2>/dev/null
wait $QDRANT_PID 2>/dev/null
echo "[$(date)] Qdrant sidecar stopped. Data is on Lustre at $QDRANT_STORAGE."

exit $EXIT_CODE
