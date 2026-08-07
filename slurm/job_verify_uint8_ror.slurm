#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=verify_fp16
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/verify_fp16_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/verify_fp16_%j.err
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=200G
#SBATCH --signal=B:TERM@300
#
# Go/no-go on the fp16 store. uint8 passed every structural check (green,
# idx==pts, dtype/quant correct) while containing nothing but zeros, so counts
# alone prove nothing -- recall vs fp32 is the only real check.
#
# Original purpose: go/no-go: does 8-bit storage change what retrieval returns?
#
# Both stores are mounted on the SAME node and queried with the SAME real query
# embeddings, so this isolates format loss cleanly. Latency measured here is
# meaningless for the 31 GB PC (a 200 GB node caches everything) -- the point is
# purely recall vs the canonical fp32 ranking.
#
# Structural check first: counts, indexed_vectors_count and quantization config,
# because `green` only means nothing is QUEUED, not that vectors are indexed.

set -uo pipefail

WORKDIR=/scratch/devon7y/westbury_rag
SRC_STORE=$WORKDIR/qdrant_final
U8_STORE=$WORKDIR/qdrant_fp16_4096
QDRANT_SIF=$WORKDIR/qdrant_latest.sif
PY=$WORKDIR/venv_westbury/bin/python
QUERIES=$WORKDIR/query_vectors.json

SRC_HTTP=7100; SRC_GRPC=7101
U8_HTTP=7200;  U8_GRPC=7201

mkdir -p "$WORKDIR/logs"
PIDS=()
cleanup () { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; sleep 5; }
trap cleanup EXIT TERM

module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true
CACERT=$("$PY" -c "import certifi; print(certifi.where())" 2>/dev/null || echo "")
BIND_CA=""
[ -n "$CACERT" ] && BIND_CA="--bind $CACERT:/etc/ssl/certs/ca-bundle.crt"

# Stage BOTH stores to node-local NVMe. Concurrent random reads over Lustre blow
# Qdrant's 60s read cap -- that killed two conversion jobs before staging fixed it.
LOCAL_FREE_GB=$(df -BG --output=avail "${SLURM_TMPDIR:-/tmp}" 2>/dev/null | tail -1 | tr -dc '0-9')
echo "[$(date)] node-local free: ${LOCAL_FREE_GB:-0}G"
if [ "${LOCAL_FREE_GB:-0}" -ge 250 ]; then
    echo "[$(date)] staging both stores to NVMe..."
    rsync -a "$SRC_STORE/" "$SLURM_TMPDIR/src/" && SRC_STORE=$SLURM_TMPDIR/src
    rsync -a "$U8_STORE/"  "$SLURM_TMPDIR/u8/"  && U8_STORE=$SLURM_TMPDIR/u8
    echo "[$(date)] staged"
else
    echo "[$(date)] insufficient local space; reading from Lustre (slower, riskier)"
fi

warm_apptainer () {
    for i in 1 2 3 4 5; do
        apptainer exec "$QDRANT_SIF" /bin/true >/dev/null 2>&1 && return 0
        sleep 20
    done
    return 1
}
warm_apptainer || { echo "apptainer unusable"; exit 1; }

start_q () {
    local store=$1 http=$2 grpc=$3
    # shellcheck disable=SC2086
    apptainer run --writable-tmpfs --pwd /qdrant \
        --env QDRANT__TELEMETRY_DISABLED=true \
        --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
        --env SSL_CERT_DIR=/etc/ssl/certs \
        --env QDRANT__SERVICE__HTTP_PORT="$http" \
        --env QDRANT__SERVICE__GRPC_PORT="$grpc" \
        --env QDRANT__STORAGE__OPTIMIZERS__MAX_OPTIMIZATION_THREADS=0 \
        $BIND_CA --bind "$store:/qdrant/storage" "$QDRANT_SIF" \
        > "$WORKDIR/logs/qverify_${http}_${SLURM_JOB_ID}.log" 2>&1 &
    PIDS+=($!)
    sleep 25
}

start_q "$SRC_STORE" $SRC_HTTP $SRC_GRPC
start_q "$U8_STORE"  $U8_HTTP  $U8_GRPC

for port in $SRC_HTTP $U8_HTTP; do
    ok=0
    for i in $(seq 1 360); do
        curl -sf "http://localhost:$port/healthz" >/dev/null 2>&1 && { ok=1; break; }
        sleep 5
    done
    [ "$ok" = "1" ] && echo "[$(date)] qdrant :$port ready" \
        || { echo "[$(date)] ERROR :$port never ready"; exit 1; }
done

echo ""
echo "=== STRUCTURAL CHECK (fp16 store) ==="
for COLL in lightrag_vdb_chunks lightrag_vdb_entities lightrag_vdb_relationships; do
    curl -sf "http://localhost:$U8_HTTP/collections/$COLL" 2>/dev/null | "$PY" -c "
import json,sys
r=json.load(sys.stdin)['result']
q=r['config'].get('quantization_config')
v=r['config']['params']['vectors']
print(f\"  {'$COLL':32s} {r['status']:7s} pts={r['points_count']:>10,} \"
      f\"idx={r['indexed_vectors_count']:>10,} dtype={v.get('datatype')} \"
      f\"quant={'BQ' if q else 'none'}\")
" 2>/dev/null || echo "  $COLL: query failed"
done

echo ""
echo "=== RECALL vs canonical fp32 ==="
"$PY" "$WORKDIR/compare_fp16_stores.py" \
    --src "http://localhost:$SRC_HTTP" \
    --fp16 "http://localhost:$U8_HTTP" \
    --label fp16 \
    --queries "$QUERIES"

echo "[$(date)] verification done"
