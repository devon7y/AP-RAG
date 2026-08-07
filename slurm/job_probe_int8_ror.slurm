#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=probe_int8
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/probe_int8_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/probe_int8_%j.err
#SBATCH --time=04:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=400G
#SBATCH --signal=B:TERM@300
#
# Measure ScalarQuantization(int8) recall per collection, rescore ON vs OFF.
#
# Chunks measured 0.979 / 0.996 on the PC, but entities and relationships have
# different vector distributions and MUST be measured separately -- assuming a
# result carries over is what wasted the uint8 conversion.
#
# Why on Ror and not the PC: relationships int8 is ~33 GB and Qdrant keeps
# scalar-quantised data resident even at always_ram=false, which OOMed the 31 GB
# serving box before. A 400 GB node absorbs it with no risk to production.
#
# The source is STAGED to node-local NVMe and mutated there. The canonical
# Lustre store at qdrant_final is never modified.

set -uo pipefail

WORKDIR=/scratch/devon7y/westbury_rag
SRC_STORE=$WORKDIR/qdrant_final
QDRANT_SIF=$WORKDIR/qdrant_latest.sif
PY=$WORKDIR/venv_westbury/bin/python
QUERIES=$WORKDIR/query_vectors.json
HTTP=7400; GRPC=7401

mkdir -p "$WORKDIR/logs"
PIDS=()
cleanup () { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 5; }
trap cleanup EXIT TERM

module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true
CACERT=$("$PY" -c "import certifi; print(certifi.where())" 2>/dev/null || echo "")
BIND_CA=""
[ -n "$CACERT" ] && BIND_CA="--bind $CACERT:/etc/ssl/certs/ca-bundle.crt"

LOCAL_FREE_GB=$(df -BG --output=avail "${SLURM_TMPDIR:-/tmp}" 2>/dev/null | tail -1 | tr -dc '0-9')
echo "[$(date)] node-local free: ${LOCAL_FREE_GB:-0}G"
if [ "${LOCAL_FREE_GB:-0}" -lt 250 ]; then
    echo "[$(date)] ERROR: need 250G local to stage a mutable copy"; exit 1
fi

echo "[$(date)] staging source to NVMe (mutable copy; canonical store untouched)..."
rsync -a "$SRC_STORE/" "$SLURM_TMPDIR/src/" || { echo "staging failed"; exit 1; }
SRC_STORE=$SLURM_TMPDIR/src
echo "[$(date)] staged: $(du -sh "$SRC_STORE" 2>/dev/null | cut -f1)"

for i in 1 2 3 4 5; do
    apptainer exec "$QDRANT_SIF" /bin/true >/dev/null 2>&1 && break
    sleep 20
done

# optimizer threads > 0: this job DOES need the optimizer, to build int8 segments
# shellcheck disable=SC2086
apptainer run --writable-tmpfs --pwd /qdrant \
    --env QDRANT__TELEMETRY_DISABLED=true \
    --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    --env SSL_CERT_DIR=/etc/ssl/certs \
    --env QDRANT__SERVICE__HTTP_PORT=$HTTP \
    --env QDRANT__SERVICE__GRPC_PORT=$GRPC \
    $BIND_CA --bind "$SRC_STORE:/qdrant/storage" "$QDRANT_SIF" \
    > "$WORKDIR/logs/qprobe_${SLURM_JOB_ID}.log" 2>&1 &
PIDS+=($!)

ok=0
for i in $(seq 1 360); do
    curl -sf "http://localhost:$HTTP/healthz" >/dev/null 2>&1 && { ok=1; break; }
    grep -qE "Panic occurred|FATAL" "$WORKDIR/logs/qprobe_${SLURM_JOB_ID}.log" 2>/dev/null && {
        echo "[$(date)] qdrant died at startup"; tail -5 "$WORKDIR/logs/qprobe_${SLURM_JOB_ID}.log"; exit 1; }
    sleep 5
done
[ "$ok" = "1" ] || { echo "[$(date)] qdrant never ready"; exit 1; }
echo "[$(date)] qdrant ready on :$HTTP"

echo ""
"$PY" "$WORKDIR/probe_int8_per_collection.py" \
    --base "http://localhost:$HTTP" \
    --queries "$QUERIES" \
    --always-ram false \
    --collections lightrag_vdb_entities lightrag_vdb_relationships

echo "[$(date)] probe done"
