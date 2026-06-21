#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_ingest
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=6
#SBATCH --mem=32G
#SBATCH --gpus=nvidia_h100_80gb_hbm3_3g.40gb:1

# v2 ingest job — changes from v1:
#   - No destructive pre-run cleanup (resume support via ingest_cml_octen_v2.py)
#   - Read-only status report before ingestion
#   - Auto-resubmission: if unprocessed docs remain, submits a new job pair
#   - References ingest_cml_octen_v2.py instead of ingest_cml_octen.py
#   - REBUILD_EMBEDDINGS=1 mode: rebuild vector DBs from cached intermediates
#     (no vLLM needed, no auto-resubmission)
#   - Structure-aware chunking via CHUNK_* env vars (section/paragraph/sentence)
#
# Memory budget (40 GB MIG):
#   Qwen3-Embedding-8B (bf16) model: ~16 GiB  (float32 would be ~32 GiB → OOM;
#     ingest.py forces EMBED_TORCH_DTYPE=bfloat16)
#   With EMBED_FUNC_MAX_ASYNC=1 + activations: ~18-20 GiB total
#   ~20 GiB headroom
#
# PRE_FLIGHT check 4: submit with --dependency=after:$VLLM_JOB
# PRE_FLIGHT check 5: LLM_MODEL must match what vLLM serves (Qwen/Qwen3-32B)

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

# Auto-resubmission: track iteration count (default 1, max 15)

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export BNB_CUDA_VERSION=126
export PYTORCH_ALLOC_CONF=expandable_segments:True

mkdir -p "$WORKDIR/logs" "$WORKDIR/rag_storage_westbury_qwen3_32b" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

# ── Read-only status report (replaces v1 destructive cleanup) ──────────────
echo "[$(date)] Current doc status:"
python3 - <<'PYEOF'
import json
from pathlib import Path

storage = Path("/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b")
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

# ── (2A) Start Qdrant sidecar via Apptainer ───────────────────────────────
# Use Qdrant if the SIF image exists; otherwise fall back to NanoVectorDB.
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_DATA="$WORKDIR/qdrant_storage_westbury"
QDRANT_PID=""

if [ -f "$QDRANT_SIF" ]; then
    mkdir -p "$QDRANT_DATA"
    module load apptainer/1.4.5 2>/dev/null || true
    echo "[$(date)] Starting Qdrant sidecar (Apptainer)..."
    apptainer run --bind "$QDRANT_DATA:/qdrant/storage" "$QDRANT_SIF" &
    QDRANT_PID=$!

    # Wait for Qdrant to be ready (up to 2 minutes)
    for i in $(seq 1 24); do
        if curl -sf "http://localhost:6333/healthz" > /dev/null 2>&1; then
            echo "[$(date)] Qdrant ready after $((i * 5))s"
            break
        fi
        if [ $i -eq 24 ]; then
            echo "[$(date)] WARNING: Qdrant did not start in 2 min. Falling back to NanoVectorDB."
            kill $QDRANT_PID 2>/dev/null
            QDRANT_PID=""
        fi
        sleep 5
    done
else
    echo "[$(date)] No Qdrant SIF found at $QDRANT_SIF — using NanoVectorDB."
    echo "  To enable Qdrant: apptainer pull $QDRANT_SIF docker://qdrant/qdrant:latest"
fi

# Set QDRANT_URL only if Qdrant is running
QDRANT_URL=""
if [ -n "$QDRANT_PID" ] && kill -0 $QDRANT_PID 2>/dev/null; then
    QDRANT_URL="http://localhost:6333"
fi

# ── Run ingest (v2) ───────────────────────────────────────────────────────
REBUILD_EMBEDDINGS=${REBUILD_EMBEDDINGS:-0}
if [ "$REBUILD_EMBEDDINGS" = "1" ]; then
    echo "[$(date)] REBUILD EMBEDDINGS MODE — no vLLM needed, recomputing vectors from cache..."
else
    echo "[$(date)] Starting ingestion v2 (rag_storage_westbury_qwen3_32b, MIG 3/8)..."
fi

WORKDIR=$WORKDIR \
N_VLLM=${N_VLLM:-1} \
ENDPOINTS_SUBDIR=${ENDPOINTS_SUBDIR:-vllm_endpoints_westbury_qwen3_32b} \
PAPERS_SUBDIR=${PAPERS_SUBDIR:-papers} \
STORAGE_SUBDIR=${STORAGE_SUBDIR:-rag_storage_westbury_qwen3_32b} \
LLM_MODEL=${LLM_MODEL:-Qwen/Qwen3-32B} \
PARALLEL_DOCS=${PARALLEL_DOCS:-4} \
LLM_MAX_ASYNC=${LLM_MAX_ASYNC:-16} \
CONTEXT_MAX_ASYNC=${CONTEXT_MAX_ASYNC:-16} \
MAX_DOC_TOKENS=${MAX_DOC_TOKENS:-20000} \
EMBED_FUNC_MAX_ASYNC=${EMBED_FUNC_MAX_ASYNC:-1} \
MAX_PARALLEL_INSERT=${MAX_PARALLEL_INSERT:-4} \
QDRANT_URL=$QDRANT_URL \
INSERT_DONE_EVERY_N=${INSERT_DONE_EVERY_N:-1} \
REBUILD_EMBEDDINGS=$REBUILD_EMBEDDINGS \
CHUNK_TARGET_TOKENS=${CHUNK_TARGET_TOKENS:-800} \
CHUNK_MAX_TOKENS=${CHUNK_MAX_TOKENS:-1000} \
CHUNK_MIN_TOKENS=${CHUNK_MIN_TOKENS:-300} \
CHUNK_OVERLAP_TOKENS=${CHUNK_OVERLAP_TOKENS:-150} \
CHUNK_EXCLUDE_REFS=${CHUNK_EXCLUDE_REFS:-1} \
CHUNK_EXCLUDE_ACK=${CHUNK_EXCLUDE_ACK:-1} \
  PYTHONPATH="$WORKDIR" python -m pipeline.ingest

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

# Stop Qdrant sidecar if running
if [ -n "$QDRANT_PID" ]; then
    kill $QDRANT_PID 2>/dev/null
    wait $QDRANT_PID 2>/dev/null
    echo "[$(date)] Qdrant sidecar stopped."
fi

exit $EXIT_CODE
