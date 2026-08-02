#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_reocr_delete
#SBATCH --output=logs/westbury_reocr_delete_%j.out
#SBATCH --error=logs/westbury_reocr_delete_%j.err
#SBATCH --time=08:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=6
#SBATCH --mem=48G
#SBATCH --gpus=h100:1

# Remove the re-OCR'd papers from the LightRAG store so the ingest re-reads the
# corrected PDFs (resume-skip would otherwise reuse the old-OCR chunks/entities).
# Wraps scripts/delete_doc.py (graph-aware adelete_by_doc_id) for every re-OCR'd
# filename that is already in doc_status; pending-first so the no-LLM bulk lands
# before any shared-entity re-summary (88 already-processed docs) might abort.
# Pass WORKDIR + REOCR_DIR via --export. STORAGE/QDRANT default to the full-corpus run.

set -uo pipefail
: "${WORKDIR:?set WORKDIR}"
: "${REOCR_DIR:?set REOCR_DIR}"
VENV_DIR="$WORKDIR/venv"
export WORKDIR
export STORAGE_SUBDIR="${STORAGE_SUBDIR:-rag_storage_full}"
QDRANT_SUBDIR="${QDRANT_SUBDIR:-qdrant_storage_full}"

export HF_HOME="$WORKDIR/hf_cache"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR="$WORKDIR/cache/tiktoken"
export XDG_CACHE_HOME="$WORKDIR/cache"
export TRITON_CACHE_DIR="$WORKDIR/cache/triton"
export FLASHINFER_CACHE_DIR="$WORKDIR/cache/flashinfer"
export BNB_CUDA_VERSION=126
export PYTORCH_ALLOC_CONF=expandable_segments:True

mkdir -p "$WORKDIR/logs" "$WORKDIR/cache"
module load python/3.11 gcc/12.3 cuda/12.6 opencv
if [ ! -f "$VENV_DIR/bin/activate" ]; then echo "ERROR: venv missing at $VENV_DIR"; exit 1; fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] venv ready. WORKDIR=$WORKDIR STORAGE=$STORAGE_SUBDIR REOCR=$REOCR_DIR"

# ── Qdrant sidecar via Apptainer (NVMe copy + sync-back; mirrors the ingest) ──
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_LUSTRE="$WORKDIR/$QDRANT_SUBDIR"
QDRANT_LOCAL="$SLURM_TMPDIR/qdrant_storage"
if [ ! -f "$QDRANT_SIF" ]; then
  echo "ERROR: no Qdrant SIF at $QDRANT_SIF — corpus vectors live in Qdrant, cannot delete without it."
  exit 1
fi
mkdir -p "$QDRANT_LOCAL" "$QDRANT_LUSTRE"
if [ "$(ls -A "$QDRANT_LUSTRE" 2>/dev/null)" ]; then
  echo "[$(date)] Seeding Qdrant local NVMe from scratch..."
  rsync -a "$QDRANT_LUSTRE/" "$QDRANT_LOCAL/"
  echo "[$(date)] Seeded $(du -sh "$QDRANT_LOCAL" | cut -f1)."
fi
module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true
CACERT=$(python -c "import certifi; print(certifi.where())" 2>/dev/null)
apptainer run --writable-tmpfs --pwd /qdrant \
  --env QDRANT__TELEMETRY_DISABLED=true \
  --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
  --env SSL_CERT_DIR=/etc/ssl/certs \
  --env QDRANT__SERVICE__MAX_REQUEST_SIZE_MB=256 \
  --bind "$CACERT:/etc/ssl/certs/ca-bundle.crt" \
  --bind "$QDRANT_LOCAL:/qdrant/storage" "$QDRANT_SIF" &
QDRANT_PID=$!
for i in $(seq 1 72); do
  curl -sf "http://localhost:6333/healthz" >/dev/null 2>&1 && { echo "[$(date)] Qdrant ready after $((i*5))s"; break; }
  sleep 5
done
if ! curl -sf "http://localhost:6333/healthz" >/dev/null 2>&1; then
  echo "ERROR: Qdrant did not start"; kill "$QDRANT_PID" 2>/dev/null; exit 1
fi
export QDRANT_URL="http://localhost:6333"

# ── Build the resolvable target list (re-OCR'd basenames in doc_status), pending-first ──
python3 - "$REOCR_DIR" "$WORKDIR/$STORAGE_SUBDIR/kv_store_doc_status.json" > "$SLURM_TMPDIR/targets.txt" <<'PYEOF'
import json, os, glob, sys
reocr = {os.path.basename(p) for p in glob.glob(sys.argv[1] + '/*.pdf')}
ds = json.load(open(sys.argv[2]))
rank = {'pending': 0, 'parsing': 1, 'analyzing': 1, 'processing': 1, 'failed': 2, 'processed': 3}
rows = []
for k, v in ds.items():
    if isinstance(v, dict):
        fn = os.path.basename(v.get('file_path', ''))
        if fn in reocr:
            rows.append((rank.get(v.get('status'), 9), fn))
for _, fn in sorted(rows):
    print(fn)
PYEOF
mapfile -t TARGETS < "$SLURM_TMPDIR/targets.txt"
echo "[$(date)] Deleting ${#TARGETS[@]} resolvable re-OCR'd docs (pending-first) from $STORAGE_SUBDIR..."

WORKDIR="$WORKDIR" \
STORAGE_SUBDIR="$STORAGE_SUBDIR" \
PAPERS_SUBDIR="${PAPERS_SUBDIR:-papers_full}" \
EMBED_MODEL_ID="${EMBED_MODEL_ID:-Qwen/Qwen3-Embedding-8B}" \
EMBEDDING_DIM="${EMBEDDING_DIM:-4096}" \
LLM_MODEL="${LLM_MODEL:-Qwen/Qwen3.6-35B-A3B}" \
QDRANT_URL="$QDRANT_URL" \
  PYTHONPATH="$WORKDIR" python scripts/delete_doc.py "${TARGETS[@]}" --delete-llm-cache --yes
EXIT_CODE=$?
echo "[$(date)] delete_doc.py exit=$EXIT_CODE"

# ── Stop Qdrant + sync the (now-smaller) store back to persistent scratch ──
kill "$QDRANT_PID" 2>/dev/null
wait "$QDRANT_PID" 2>/dev/null
echo "[$(date)] Syncing Qdrant back to scratch..."
rsync -a --delete "$QDRANT_LOCAL/" "$QDRANT_LUSTRE/"
echo "[$(date)] Qdrant sync complete ($(du -sh "$QDRANT_LUSTRE" | cut -f1)). Done (exit $EXIT_CODE)."
exit $EXIT_CODE
