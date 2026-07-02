#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=books_ingest
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/books_ingest_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/books_ingest_%j.err
#SBATCH --time=12:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=6
#SBATCH --mem=32G
#SBATCH --gpus=h100:1
#SBATCH --signal=B:TERM@600
# ^ deliver SIGTERM to this shell 10 min BEFORE walltime: the trap below stops
#   the ingest (its in-python handler flushes storages), leaving real time for
#   the Qdrant stop + rsync-back. Without it, SLURM's ~30s KillWait silently
#   dropped the cycle's Qdrant delta (vectors) on every walltime kill.

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export BNB_CUDA_VERSION=126
export PYTORCH_ALLOC_CONF=expandable_segments:True

mkdir -p "$WORKDIR/logs" "$WORKDIR/rag_storage_westbury_qwen3_32b" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

# ── Graphml backup/restore guard ─────────────────────────────────────
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

# ── Early SIGTERM → graceful stop with time to sync (see --signal above) ──────
PYTHON_PID=""
TIMED_OUT=0
trap 'echo "[$(date)] SIGTERM — stopping ingest for graceful sync"; TIMED_OUT=1; [ -n "$PYTHON_PID" ] && kill $PYTHON_PID 2>/dev/null' SIGTERM SIGINT

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env.slurm first."
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

# ── Qdrant sidecar via Apptainer (local NVMe for performance) ──────
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_LUSTRE="$WORKDIR/qdrant_storage_westbury"
QDRANT_LOCAL="$SLURM_TMPDIR/qdrant_storage"
QDRANT_PID=""

if [ -f "$QDRANT_SIF" ]; then
    mkdir -p "$QDRANT_LOCAL" "$QDRANT_LUSTRE"

    if [ "$(ls -A "$QDRANT_LUSTRE" 2>/dev/null)" ]; then
        echo "[$(date)] Seeding Qdrant local storage from Lustre..."
        rsync -a "$QDRANT_LUSTRE/" "$QDRANT_LOCAL/"
        echo "[$(date)] Seeded $(du -sh "$QDRANT_LOCAL" | cut -f1) from Lustre."
    fi

    module load apptainer/1.4.5 2>/dev/null || true
    echo "[$(date)] Starting Qdrant sidecar on local NVMe ($QDRANT_LOCAL)..."
    apptainer run --writable-tmpfs --pwd /qdrant \
    --env QDRANT__TELEMETRY_DISABLED=true \
    --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    --env SSL_CERT_DIR=/etc/ssl/certs \
    --env QDRANT__SERVICE__MAX_REQUEST_SIZE_MB=256 \
    --bind /etc/ssl/certs:/etc/ssl/certs \
    --bind "$QDRANT_LOCAL:/qdrant/storage" "$QDRANT_SIF" &
    QDRANT_PID=$!
    for i in $(seq 1 72); do
        if curl -sf "http://localhost:6333/healthz" > /dev/null 2>&1; then
            echo "[$(date)] Qdrant ready after $((i * 5))s"
            break
        fi
        if [ $i -eq 72 ]; then
            echo "[$(date)] WARNING: Qdrant did not start in 6 min. Falling back to NanoVectorDB."
            kill $QDRANT_PID 2>/dev/null
            QDRANT_PID=""
        fi
        sleep 5
    done
else
    echo "[$(date)] No Qdrant SIF found at $QDRANT_SIF — using NanoVectorDB."
fi

QDRANT_URL=""
if [ -n "$QDRANT_PID" ] && kill -0 $QDRANT_PID 2>/dev/null; then
    QDRANT_URL="http://localhost:6333"
fi

echo "[$(date)] Starting books ingestion (papers_large, book chunker)..."

WORKDIR=$WORKDIR \
N_VLLM=${N_VLLM:-3} \
ENDPOINTS_SUBDIR=${ENDPOINTS_SUBDIR:-vllm_endpoints_westbury_qwen3_32b} \
PAPERS_SUBDIR=${PAPERS_SUBDIR:-papers_large} \
STORAGE_SUBDIR=${STORAGE_SUBDIR:-rag_storage_westbury_qwen3_32b} \
LLM_MODEL=${LLM_MODEL:-Qwen/Qwen3.6-35B-A3B} \
PARALLEL_DOCS=${PARALLEL_DOCS:-32} \
LLM_MAX_ASYNC=${LLM_MAX_ASYNC:-32} \
CONTEXT_MAX_ASYNC=${CONTEXT_MAX_ASYNC:-32} \
MAX_DOC_TOKENS=${MAX_DOC_TOKENS:-36000} \
EMBED_FUNC_MAX_ASYNC=${EMBED_FUNC_MAX_ASYNC:-2} \
EMBED_BATCH=${EMBED_BATCH:-64} \
EMBEDDING_BATCH_NUM=${EMBEDDING_BATCH_NUM:-128} \
MAX_PARALLEL_INSERT=${MAX_PARALLEL_INSERT:-16} \
QDRANT_URL=$QDRANT_URL \
KV_FLUSH_INTERVAL=${KV_FLUSH_INTERVAL:-300} \
LLM_MAX_TOKENS=${LLM_MAX_TOKENS:-4096} \
CONTEXT_MAX_TOKENS=${CONTEXT_MAX_TOKENS:-300} \
LLM_TEMPERATURE=${LLM_TEMPERATURE:-0.0} \
LLM_SEED=${LLM_SEED:-42} \
CONTEXT_CACHE=${CONTEXT_CACHE:-1} \
CONTEXT_WARM_FIRST=${CONTEXT_WARM_FIRST:-1} \
CONTEXT_AFFINITY=${CONTEXT_AFFINITY:-1} \
STREAM_OVERLAP=${STREAM_OVERLAP:-1} \
ENDPOINT_REFRESH_S=${ENDPOINT_REFRESH_S:-300} \
MAX_GLEANING=${MAX_GLEANING:-1} \
FORCE_LLM_SUMMARY_ON_MERGE=${FORCE_LLM_SUMMARY_ON_MERGE:-8} \
SUMMARY_MAX_TOKENS=${SUMMARY_MAX_TOKENS:-1200} \
REBUILD_EMBEDDINGS=${REBUILD_EMBEDDINGS:-0} \
DOC_POLL_TIMEOUT=${DOC_POLL_TIMEOUT:-43200} \
CHUNKER_TYPE=book \
BOOK_CHUNK_TARGET_TOKENS=${BOOK_CHUNK_TARGET_TOKENS:-1000} \
BOOK_CHUNK_MAX_TOKENS=${BOOK_CHUNK_MAX_TOKENS:-1500} \
BOOK_CHUNK_MIN_TOKENS=${BOOK_CHUNK_MIN_TOKENS:-250} \
BOOK_CHUNK_OVERLAP_TOKENS=${BOOK_CHUNK_OVERLAP_TOKENS:-200} \
  PYTHONPATH="$WORKDIR" python -m pipeline.ingest &
PYTHON_PID=$!
wait $PYTHON_PID
EXIT_CODE=$?
# A trap-interrupted wait returns >128 while the child may still be flushing —
# wait again to reap the real exit status.
if [ $EXIT_CODE -gt 128 ] && kill -0 $PYTHON_PID 2>/dev/null; then
    wait $PYTHON_PID
    EXIT_CODE=$?
fi
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

if [ -n "$QDRANT_PID" ]; then
    kill $QDRANT_PID 2>/dev/null
    wait $QDRANT_PID 2>/dev/null
    echo "[$(date)] Qdrant sidecar stopped."
    echo "[$(date)] Syncing Qdrant data from local NVMe back to Lustre..."
    rsync -a --delete "$QDRANT_LOCAL/" "$QDRANT_LUSTRE/"
    echo "[$(date)] Qdrant sync complete ($(du -sh "$QDRANT_LUSTRE" | cut -f1))."
fi

exit $EXIT_CODE
