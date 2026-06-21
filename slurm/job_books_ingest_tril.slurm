#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=books_ingest
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/books_ingest_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/books_ingest_%j.err
#SBATCH --time=12:00:00
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

# ── Qdrant sidecar via Apptainer ─────────────────────────────────────
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_LUSTRE="$WORKDIR/qdrant_storage_westbury"
QDRANT_LOCAL="$SLURM_TMPDIR/qdrant_storage"
QDRANT_PID=""

if [ -f "$QDRANT_SIF" ]; then
    mkdir -p "$QDRANT_LOCAL" "$QDRANT_LUSTRE"

    if [ "$(ls -A "$QDRANT_LUSTRE" 2>/dev/null)" ]; then
        echo "[$(date)] Seeding Qdrant local storage from scratch..."
        rsync -a "$QDRANT_LUSTRE/" "$QDRANT_LOCAL/"
        echo "[$(date)] Seeded $(du -sh "$QDRANT_LOCAL" | cut -f1) from scratch."
    fi

    module load apptainer 2>/dev/null || true
    echo "[$(date)] Starting Qdrant sidecar ($QDRANT_LOCAL)..."
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

# ── Run ingest ────────────────────────────────────────────────────────
echo "[$(date)] Starting books ingestion (papers_large, book chunker)..."

WORKDIR=$WORKDIR \
N_VLLM=${N_VLLM:-3} \
ENDPOINTS_SUBDIR=${ENDPOINTS_SUBDIR:-vllm_endpoints_westbury_qwen3_32b} \
PAPERS_SUBDIR=${PAPERS_SUBDIR:-papers_large} \
STORAGE_SUBDIR=${STORAGE_SUBDIR:-rag_storage_westbury_qwen3_32b} \
LLM_MODEL=${LLM_MODEL:-Qwen/Qwen3-32B} \
PARALLEL_DOCS=${PARALLEL_DOCS:-32} \
LLM_MAX_ASYNC=${LLM_MAX_ASYNC:-32} \
CONTEXT_MAX_ASYNC=${CONTEXT_MAX_ASYNC:-32} \
MAX_DOC_TOKENS=${MAX_DOC_TOKENS:-36000} \
EMBED_FUNC_MAX_ASYNC=${EMBED_FUNC_MAX_ASYNC:-16} \
MAX_PARALLEL_INSERT=${MAX_PARALLEL_INSERT:-16} \
QDRANT_URL=$QDRANT_URL \
INSERT_DONE_EVERY_N=${INSERT_DONE_EVERY_N:-1} \
REBUILD_EMBEDDINGS=${REBUILD_EMBEDDINGS:-0} \
DOC_POLL_TIMEOUT=${DOC_POLL_TIMEOUT:-43200} \
CHUNKER_TYPE=book \
BOOK_CHUNK_TARGET_TOKENS=${BOOK_CHUNK_TARGET_TOKENS:-1000} \
BOOK_CHUNK_MAX_TOKENS=${BOOK_CHUNK_MAX_TOKENS:-1500} \
BOOK_CHUNK_MIN_TOKENS=${BOOK_CHUNK_MIN_TOKENS:-250} \
BOOK_CHUNK_OVERLAP_TOKENS=${BOOK_CHUNK_OVERLAP_TOKENS:-200} \
  PYTHONPATH="$WORKDIR" python -m pipeline.ingest

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

# ── Stop Qdrant and sync back ─────────────────────────────────────────
if [ -n "$QDRANT_PID" ]; then
    kill $QDRANT_PID 2>/dev/null
    wait $QDRANT_PID 2>/dev/null
    echo "[$(date)] Qdrant sidecar stopped."
    echo "[$(date)] Syncing Qdrant data back to persistent scratch..."
    rsync -a --delete "$QDRANT_LOCAL/" "$QDRANT_LUSTRE/"
    echo "[$(date)] Qdrant sync complete ($(du -sh "$QDRANT_LUSTRE" | cut -f1))."
fi

exit $EXIT_CODE
