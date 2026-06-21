#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_migrate_qdrant
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_migrate_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_migrate_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
# No GPU needed — CPU-only migration job

# Migrates NanoVectorDB JSON files (vdb_chunks, vdb_entities, vdb_relationships)
# to Qdrant. Run this once before the first Qdrant-backed ingest job.

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

export XDG_CACHE_HOME=$WORKDIR/cache

mkdir -p "$WORKDIR/logs"

module load python/3.11 gcc/12.3

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR"
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] venv activated."

# ── Start Qdrant sidecar ──────────────────────────────────────────────────────
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_LUSTRE="$WORKDIR/qdrant_storage_westbury"
QDRANT_LOCAL="$SLURM_TMPDIR/qdrant_storage"
QDRANT_PID=""

if [ ! -f "$QDRANT_SIF" ]; then
    echo "[$(date)] ERROR: Qdrant SIF not found at $QDRANT_SIF"
    echo "  Pull it with: apptainer pull $QDRANT_SIF docker://qdrant/qdrant:latest"
    exit 1
fi

mkdir -p "$QDRANT_LOCAL" "$QDRANT_LUSTRE"

# Seed from existing Lustre data if a previous migration was interrupted
if [ "$(ls -A "$QDRANT_LUSTRE" 2>/dev/null)" ]; then
    echo "[$(date)] Seeding local NVMe from Lustre ($(du -sh "$QDRANT_LUSTRE" | cut -f1))..."
    rsync -a "$QDRANT_LUSTRE/" "$QDRANT_LOCAL/"
    echo "[$(date)] Seed complete."
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

for i in $(seq 1 24); do
    if curl -sf "http://localhost:6333/healthz" > /dev/null 2>&1; then
        echo "[$(date)] Qdrant ready after $((i * 5))s"
        break
    fi
    if [ $i -eq 24 ]; then
        echo "[$(date)] ERROR: Qdrant did not start within 2 min."
        kill $QDRANT_PID 2>/dev/null
        exit 1
    fi
    sleep 5
done

# ── Run migration ──────────────────────────────────────────────────────────────
echo "[$(date)] Starting NanoVDB → Qdrant migration..."
echo "[$(date)] Source: $WORKDIR/rag_storage_westbury_qwen3_32b"
echo "[$(date)] Target: http://localhost:6333"

STORAGE_DIR=$WORKDIR/rag_storage_westbury_qwen3_32b \
QDRANT_URL=http://localhost:6333 \
  python "$WORKDIR/scripts/migrate_nano_to_qdrant.py"

EXIT_CODE=$?
echo "[$(date)] Migration finished with exit code $EXIT_CODE."

# ── Stop Qdrant and sync back to Lustre ───────────────────────────────────────
kill $QDRANT_PID 2>/dev/null
wait $QDRANT_PID 2>/dev/null
echo "[$(date)] Qdrant sidecar stopped."

echo "[$(date)] Syncing Qdrant data from local NVMe to Lustre..."
rsync -a --delete "$QDRANT_LOCAL/" "$QDRANT_LUSTRE/"
echo "[$(date)] Sync complete: $(du -sh "$QDRANT_LUSTRE" | cut -f1) at $QDRANT_LUSTRE"

exit $EXIT_CODE
