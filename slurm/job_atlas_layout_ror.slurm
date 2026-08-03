#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=atlas_layout
#SBATCH --output=/scratch/devon7y/westbury_rag/atlas/logs/%x_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/atlas/logs/%x_%j.err
#SBATCH --time=12:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=300G
#SBATCH --gpus=h100:1

# Papers Atlas layout for the full corpus (~10.4k papers / ~445k chunks).
#
# One H100 for the neighbour search, CPU for the layout. The point of running here
# rather than on a laptop is that the chunk
# vectors already live beside this node, so UMAP sees them at their native 4096
# dimensions — nothing is projected away to make a transfer affordable.
#
# Only the chunks collection is staged (7 GB); entities/relationships are 3.6M
# and 8.1M vectors and the layout does not read them.
#
# The GPU computes EXACT cosine neighbours by tiled matmul in minutes; the CPU
# paths (Qdrant HNSW, pynndescent) remain as fallbacks and are approximate.

set -euo pipefail

WORKDIR=/scratch/devon7y/westbury_rag
ATLAS=$WORKDIR/atlas
VENV=$WORKDIR/venv
QDRANT_SIF=$WORKDIR/qdrant_latest.sif
SRC_COLL=$WORKDIR/qdrant_final
QDRANT_LOCAL=$SLURM_TMPDIR/qdrant_storage
OUT=$ATLAS/out

mkdir -p "$OUT" "$QDRANT_LOCAL/collections"

echo "[$(date)] staging chunks collection to node-local NVMe..."
rsync -a "$SRC_COLL/collections/lightrag_vdb_chunks" "$QDRANT_LOCAL/collections/"
[ -d "$SRC_COLL/aliases" ] && rsync -a "$SRC_COLL/aliases" "$QDRANT_LOCAL/" || true
[ -f "$SRC_COLL/raft_state.json" ] && cp "$SRC_COLL/raft_state.json" "$QDRANT_LOCAL/" || true
echo "[$(date)] staged $(du -sh "$QDRANT_LOCAL" | cut -f1)"

module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true
# Qdrant 1.17 panics at startup without a CA bundle (same fix as the ingest jobs)
CACERT=$("$VENV/bin/python" -c "import certifi; print(certifi.where())" 2>/dev/null || echo "")
BIND_CA=""
[ -n "$CACERT" ] && BIND_CA="--bind $CACERT:/etc/ssl/certs/ca-bundle.crt"

echo "[$(date)] starting Qdrant sidecar..."
# shellcheck disable=SC2086
apptainer run --writable-tmpfs --pwd /qdrant \
  --env QDRANT__TELEMETRY_DISABLED=true \
  --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
  --env SSL_CERT_DIR=/etc/ssl/certs \
  $BIND_CA \
  --bind "$QDRANT_LOCAL:/qdrant/storage" "$QDRANT_SIF" &
QDRANT_PID=$!
trap 'kill $QDRANT_PID 2>/dev/null || true' EXIT

for i in $(seq 1 72); do
    if curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
        echo "[$(date)] Qdrant ready after $((i * 5))s"
        break
    fi
    if [ "$i" -eq 72 ]; then
        echo "[$(date)] FATAL: Qdrant did not start in 6 min"
        exit 1
    fi
    sleep 5
done
curl -s http://localhost:6333/collections/lightrag_vdb_chunks | head -c 300; echo

export OMP_NUM_THREADS=$SLURM_CPUS_PER_TASK
export NUMBA_NUM_THREADS=$SLURM_CPUS_PER_TASK

echo "[$(date)] running layout..."
"$VENV/bin/python" "$ATLAS/hpc_layout.py" \
    --qdrant http://127.0.0.1:6333 \
    --chunks-kv "$WORKDIR/rag_storage_full/kv_store_text_chunks.json" \
    --manifest "$ATLAS/papers_metadata.json" \
    --out "$OUT"

echo "[$(date)] outputs:"
ls -la --block-size=M "$OUT"
echo "[$(date)] done"
