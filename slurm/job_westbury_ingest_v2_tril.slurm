#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_ingest
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.err
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

mkdir -p "$WORKDIR/logs" "$WORKDIR/rag_storage_westbury_qwen3_32b" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

# ── Graphml backup guard ──────────────────────────────────────────────────────
GRAPHML="$WORKDIR/rag_storage_westbury_qwen3_32b/graph_chunk_entity_relation.graphml"
GRAPHML_BAK="$WORKDIR/rag_storage_westbury_qwen3_32b/graph_chunk_entity_relation.graphml.bak"
if [ -s "$GRAPHML" ]; then
    cp "$GRAPHML" "$GRAPHML_BAK"
    echo "[$(date)] Graphml backed up ($(du -sh "$GRAPHML" | cut -f1))."
fi

QDRANT_PID=""
PYTHON_PID=""

# Called on SIGTERM/SIGINT — gracefully stop child processes, data already on Lustre
cleanup() {
    echo "[$(date)] Caught signal — stopping Python and Qdrant..."
    [ -n "$PYTHON_PID" ] && kill "$PYTHON_PID" 2>/dev/null; wait "$PYTHON_PID" 2>/dev/null
    [ -n "$QDRANT_PID" ] && kill "$QDRANT_PID" 2>/dev/null; wait "$QDRANT_PID" 2>/dev/null
    echo "[$(date)] Shutdown complete. Data is on Lustre."
    exit 1
}

# Called on any EXIT — restore graphml if wiped mid-run
restore_graphml() {
    if [ ! -s "$GRAPHML" ] && [ -s "$GRAPHML_BAK" ]; then
        cp "$GRAPHML_BAK" "$GRAPHML"
        echo "[$(date)] Graphml was empty — restored from backup ($(du -sh "$GRAPHML" | cut -f1))."
    fi
}

trap cleanup SIGTERM SIGINT
trap restore_graphml EXIT

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env_tril.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

echo "[$(date)] Current doc status:"
python3 - <<'PYEOF'
import json
from pathlib import Path

storage = Path("/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b")
status_path = storage / "kv_store_doc_status.json"

if not status_path.exists():
    print("  No doc status file found (fresh run).")
    exit()

status = json.loads(status_path.read_text())
counts = {}
for k, v in status.items():
    if k.startswith("doc-"):
        s = v.get("status", "unknown")
        counts[s] = counts.get(s, 0) + 1

total = sum(counts.values())
print(f"  Total entries: {total}")
for s in ("processed", "processing", "pending", "failed"):
    print(f"    {s}: {counts.get(s, 0)}")
PYEOF

# ── Qdrant sidecar directly on Lustre (progress survives kills) ───────────────
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_STORAGE="$WORKDIR/qdrant_storage_westbury"

if [ ! -f "$QDRANT_SIF" ]; then
    echo "[$(date)] ERROR: Qdrant SIF not found at $QDRANT_SIF"
    exit 1
fi

mkdir -p "$QDRANT_STORAGE"

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

# ── Run ingest ────────────────────────────────────────────────────────────────
echo "[$(date)] Starting ingestion v2 (rag_storage_westbury_qwen3_32b)..."

WORKDIR=$WORKDIR \
N_VLLM=${N_VLLM:-3} \
ENDPOINTS_SUBDIR=${ENDPOINTS_SUBDIR:-vllm_endpoints_westbury_qwen3_32b} \
PAPERS_SUBDIR=${PAPERS_SUBDIR:-papers} \
STORAGE_SUBDIR=${STORAGE_SUBDIR:-rag_storage_westbury_qwen3_32b} \
LLM_MODEL=${LLM_MODEL:-Qwen/Qwen3.6-35B-A3B} \
PARALLEL_DOCS=${PARALLEL_DOCS:-32} \
LLM_MAX_ASYNC=${LLM_MAX_ASYNC:-16} \
CONTEXT_MAX_ASYNC=${CONTEXT_MAX_ASYNC:-16} \
MAX_DOC_TOKENS=${MAX_DOC_TOKENS:-20000} \
EMBED_FUNC_MAX_ASYNC=${EMBED_FUNC_MAX_ASYNC:-4} \
MAX_PARALLEL_INSERT=${MAX_PARALLEL_INSERT:-4} \
QDRANT_URL=http://localhost:6333 \
INSERT_DONE_EVERY_N=${INSERT_DONE_EVERY_N:-1} \
REBUILD_EMBEDDINGS=${REBUILD_EMBEDDINGS:-0} \
CHUNK_TARGET_TOKENS=${CHUNK_TARGET_TOKENS:-800} \
CHUNK_MAX_TOKENS=${CHUNK_MAX_TOKENS:-1000} \
CHUNK_MIN_TOKENS=${CHUNK_MIN_TOKENS:-300} \
CHUNK_OVERLAP_TOKENS=${CHUNK_OVERLAP_TOKENS:-150} \
CHUNK_EXCLUDE_REFS=${CHUNK_EXCLUDE_REFS:-1} \
CHUNK_EXCLUDE_ACK=${CHUNK_EXCLUDE_ACK:-1} \
CHUNK_TIMEOUT=${CHUNK_TIMEOUT:-600} \
    PYTHONPATH="$WORKDIR" python -m pipeline.ingest &
PYTHON_PID=$!
wait $PYTHON_PID
EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

# ── Stop Qdrant ───────────────────────────────────────────────────────────────
kill $QDRANT_PID 2>/dev/null
wait $QDRANT_PID 2>/dev/null
echo "[$(date)] Qdrant sidecar stopped. Data is on Lustre at $QDRANT_STORAGE."
QDRANT_PID=""

exit $EXIT_CODE
