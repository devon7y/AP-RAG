#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_ingest
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=6
#SBATCH --mem=32G
#SBATCH --gpus=h100:1

# Fir ingest — mirrors job_westbury_ingest_v2_nibi.slurm. Only difference is the
# WORKDIR path (/home/devon7y/scratch/devon7y/... on Fir). HF_HOME=$WORKDIR/hf_cache
# is the same as Nibi (models live in westbury_rag/hf_cache).

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

export WORKDIR
export STORAGE_SUBDIR="${STORAGE_SUBDIR:-rag_storage_aprag}"
QDRANT_SUBDIR="${QDRANT_SUBDIR:-qdrant_storage_aprag}"

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export BNB_CUDA_VERSION=126
export PYTORCH_ALLOC_CONF=expandable_segments:True

mkdir -p "$WORKDIR/logs" "$WORKDIR/$STORAGE_SUBDIR" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env_fir.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

echo "[$(date)] Current doc status:"
python3 - <<'PYEOF'
import json
import os
from pathlib import Path

storage = Path(os.environ["WORKDIR"]) / os.environ["STORAGE_SUBDIR"]
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

# ── Qdrant sidecar via Apptainer (local NVMe — Fir is Lustre) ──
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_LUSTRE="$WORKDIR/$QDRANT_SUBDIR"
QDRANT_LOCAL="$SLURM_TMPDIR/qdrant_storage"
QDRANT_PID=""

if [ -f "$QDRANT_SIF" ]; then
    mkdir -p "$QDRANT_LOCAL" "$QDRANT_LUSTRE"

    # Seed local NVMe from persistent storage if data exists
    if [ "$(ls -A "$QDRANT_LUSTRE" 2>/dev/null)" ]; then
        echo "[$(date)] Seeding Qdrant local storage from scratch..."
        rsync -a "$QDRANT_LUSTRE/" "$QDRANT_LOCAL/"
        echo "[$(date)] Seeded $(du -sh "$QDRANT_LOCAL" | cut -f1) from scratch."
    fi

    module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true
    # Qdrant 1.17 panics at startup if it cannot load a CA bundle. Bind the venv's
    # certifi bundle into the path Qdrant reads (robust regardless of host certs).
    CACERT=$(python -c "import certifi; print(certifi.where())" 2>/dev/null)
    echo "[$(date)] Binding CA bundle into Qdrant: $CACERT"
    apptainer run --writable-tmpfs --pwd /qdrant \
    --env QDRANT__TELEMETRY_DISABLED=true \
    --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    --env SSL_CERT_DIR=/etc/ssl/certs \
    --env QDRANT__SERVICE__MAX_REQUEST_SIZE_MB=256 \
    --bind "$CACERT:/etc/ssl/certs/ca-bundle.crt" \
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
    echo "  To enable Qdrant: apptainer pull $QDRANT_SIF docker://qdrant/qdrant:latest"
fi

QDRANT_URL=""
if [ -n "$QDRANT_PID" ] && kill -0 $QDRANT_PID 2>/dev/null; then
    QDRANT_URL="http://localhost:6333"
fi

# ── Trap SIGTERM for graceful shutdown on walltime ──────────────────
TIMED_OUT=0
trap 'echo "[$(date)] SIGTERM received (walltime)"; TIMED_OUT=1' SIGTERM SIGINT

# ── Run ingest (v2) ───────────────────────────────────────────────────
REBUILD_EMBEDDINGS=${REBUILD_EMBEDDINGS:-0}
if [ "$REBUILD_EMBEDDINGS" = "1" ]; then
    echo "[$(date)] REBUILD EMBEDDINGS MODE — no vLLM needed, recomputing vectors from cache..."
else
    echo "[$(date)] Starting ingestion v2 ($STORAGE_SUBDIR, 1x H100)..."
fi

WORKDIR=$WORKDIR \
N_VLLM=${N_VLLM:-1} \
ENDPOINTS_SUBDIR=${ENDPOINTS_SUBDIR:-vllm_endpoints_westbury_qwen3_32b} \
PAPERS_SUBDIR=${PAPERS_SUBDIR:-papers} \
STORAGE_SUBDIR=${STORAGE_SUBDIR:-rag_storage_aprag} \
LLM_MODEL=${LLM_MODEL:-Qwen/Qwen3.6-35B-A3B} \
PARALLEL_DOCS=${PARALLEL_DOCS:-4} \
LLM_MAX_ASYNC=${LLM_MAX_ASYNC:-16} \
CONTEXT_MAX_ASYNC=${CONTEXT_MAX_ASYNC:-16} \
MAX_DOC_TOKENS=${MAX_DOC_TOKENS:-20000} \
EMBED_FUNC_MAX_ASYNC=${EMBED_FUNC_MAX_ASYNC:-4} \
MAX_PARALLEL_INSERT=${MAX_PARALLEL_INSERT:-4} \
QDRANT_URL=$QDRANT_URL \
INSERT_DONE_EVERY_N=${INSERT_DONE_EVERY_N:-1} \
REBUILD_EMBEDDINGS=$REBUILD_EMBEDDINGS \
CHUNK_TARGET_TOKENS=${CHUNK_TARGET_TOKENS:-512} \
CHUNK_MAX_TOKENS=${CHUNK_MAX_TOKENS:-640} \
CHUNK_MIN_TOKENS=${CHUNK_MIN_TOKENS:-192} \
CHUNK_OVERLAP_TOKENS=${CHUNK_OVERLAP_TOKENS:-51} \
CHUNK_EXCLUDE_REFS=${CHUNK_EXCLUDE_REFS:-1} \
CHUNK_EXCLUDE_ACK=${CHUNK_EXCLUDE_ACK:-1} \
  PYTHONPATH="$WORKDIR" python -m pipeline.ingest

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

# ── Stop Qdrant and sync data back to persistent scratch ─────────────
if [ -n "$QDRANT_PID" ]; then
    kill $QDRANT_PID 2>/dev/null
    wait $QDRANT_PID 2>/dev/null
    echo "[$(date)] Qdrant sidecar stopped."

    echo "[$(date)] Syncing Qdrant data back to persistent scratch..."
    rsync -a --delete "$QDRANT_LOCAL/" "$QDRANT_LUSTRE/"
    echo "[$(date)] Qdrant sync complete ($(du -sh "$QDRANT_LUSTRE" | cut -f1))."
fi

exit $EXIT_CODE
