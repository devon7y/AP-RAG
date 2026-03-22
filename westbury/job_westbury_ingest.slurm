#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_ingest
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.err
#SBATCH --time=10:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=6
#SBATCH --mem=32G
#SBATCH --gpus=nvidia_h100_80gb_hbm3_3g.40gb:1

# Ingest-only: Octen-Embedding-8B-INT8 on a MIG 3/8 slice (40 GB).
# Paired with a separate vLLM job on a dedicated H100.
#
# Memory budget (40 GB MIG):
#   Octen-8B-INT8 model: ~10 GiB
#   With EMBED_FUNC_MAX_ASYNC=4: ~18 GiB total (4 x 2 GiB activations)
#   ~22 GiB headroom
#
# Higher parallelism than single-GPU since no vLLM memory contention:
#   MAX_PARALLEL_INSERT=32  (LightRAG pipeline: 32 concurrent doc extractions)
#   LLM_MAX_ASYNC=64        (entity extraction; short prompts, many concurrent)
#   CONTEXT_MAX_ASYNC=32    (contextualization; ~28K token prompts, KV-cache limited to ~5 concurrent)
#   EMBED_FUNC_MAX_ASYNC=4  (own GPU, plenty of room; global semaphore, not per-doc)
#
# PRE_FLIGHT check 4: submit with --dependency=after:$VLLM_JOB
# PRE_FLIGHT check 5: LLM_MODEL must match what vLLM serves (Qwen/Qwen3-32B)

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

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

# ── Reset non-processed docs so re-submission doesn't hit "Content already exists" ──
echo "[$(date)] Resetting pending/failed docs to allow clean re-submission..."
python3 - <<'PYEOF'
import json
from pathlib import Path

storage = Path("/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b")
status_path = storage / "kv_store_doc_status.json"
full_docs_path = storage / "kv_store_full_docs.json"

if not status_path.exists():
    print("No doc status file found, skipping reset.")
    exit()

status = json.loads(status_path.read_text())
full_docs = json.loads(full_docs_path.read_text()) if full_docs_path.exists() else {}

to_remove = [k for k, v in status.items() if v.get("status") not in ("processed",)]
print(f"Removing {len(to_remove)} non-processed entries (pending/failed) from status and full_docs...")

for k in to_remove:
    status.pop(k, None)
    full_docs.pop(k, None)

status_path.write_text(json.dumps(status))
if full_docs_path.exists():
    full_docs_path.write_text(json.dumps(full_docs))

processed = sum(1 for v in status.values() if v.get("status") == "processed")
print(f"Done. {processed} processed entries retained. Ready for clean re-submission.")
PYEOF

# ── Run ingest ─────────────────────────────────────────────────────────────
echo "[$(date)] Starting ingestion (rag_storage_westbury_qwen3_32b, MIG 3/8)..."
WORKDIR=$WORKDIR \
N_VLLM=1 \
ENDPOINTS_SUBDIR=vllm_endpoints_westbury_qwen3_32b \
PAPERS_SUBDIR=papers \
STORAGE_SUBDIR=rag_storage_westbury_qwen3_32b \
LLM_MODEL=Qwen/Qwen3-32B \
PARALLEL_DOCS=4 \
LLM_MAX_ASYNC=64 \
CONTEXT_MAX_ASYNC=32 \
MAX_DOC_TOKENS=20000 \
EMBED_FUNC_MAX_ASYNC=4 \
MAX_PARALLEL_INSERT=32 \
  python "$WORKDIR/ingest_cml_octen.py"

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."
exit $EXIT_CODE
