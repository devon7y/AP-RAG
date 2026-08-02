#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=qdrant_index
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/qdrant_index_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/qdrant_index_%j.err
#SBATCH --time=12:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=256G
#SBATCH --signal=B:TERM@1800

# Build the HNSW index on the merged store. NO GPU.
#
# WHY THIS EXISTS: the merge disables indexing during bulk load
# (indexing_threshold=0) and restores it afterwards. That restore was lost twice:
#   1. The sequential job was TERMed mid-merge. Python's DEFAULT SIGTERM handler
#      exits WITHOUT running finally blocks, so the restore never ran and 0 was
#      persisted into the collection config inside qdrant_final.
#   2. The parallel job then seeded from qdrant_final, so BOTH merge processes
#      read 0 as the "original" threshold and dutifully restored 0.
# Net effect: all 8,096,245 points present but only ~209k vectors indexed, and
# status=green was misleading — with indexing disabled there is nothing queued,
# so "green" means "nothing to do", not "fully indexed".
#
# This job sets the true original threshold (10000) and waits for the optimizer
# to actually finish, gating on indexed_vectors_count — NOT on status alone.

set -o pipefail

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR="${VENV_DIR:-$WORKDIR/venv}"
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
STORE="$WORKDIR/qdrant_final"
THRESHOLD="${INDEXING_THRESHOLD:-10000}"

EXPECT_CHUNKS=445394
EXPECT_ENTITIES=3586043
EXPECT_RELATIONS=8096245

LOCAL="$SLURM_TMPDIR/idx"
QPID=""

module load python/3.11 2>/dev/null || true
module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true
source "$VENV_DIR/bin/activate"
CACERT=$(python -c "import certifi; print(certifi.where())" 2>/dev/null)

api() { curl -sf "http://localhost:6334/collections/lightrag_vdb_$1" 2>/dev/null; }

field() {  # field <collection> <json key>
    api "$1" | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)['result']
except Exception:
    print(''); raise SystemExit
k = '$2'
v = r['config']['optimizer_config'].get(k) if k == 'indexing_threshold' else r.get(k)
print(v if v is not None else '')
"
}

writeback() {
    [ -d "$LOCAL" ] || return 0
    echo "[$(date)] Syncing indexed store back to $STORE ..."
    rsync -a --delete "$LOCAL/" "$STORE/" \
        && echo "[$(date)] Writeback complete." \
        || echo "[$(date)] ERROR: writeback failed"
}

on_term() {
    echo "[$(date)] SIGTERM — stopping Qdrant and saving indexed state."
    kill "$QPID" 2>/dev/null
    for i in $(seq 1 150); do kill -0 "$QPID" 2>/dev/null || break; sleep 2; done
    writeback
    exit 0
}
trap on_term TERM

echo "[$(date)] Seeding from $STORE ..."
mkdir -p "$LOCAL"
rsync -a "$STORE/" "$LOCAL/" || { echo "ERROR: seed rsync failed"; exit 1; }
echo "[$(date)] Seeded ($(du -sh "$LOCAL" | cut -f1))."

apptainer run --writable-tmpfs --pwd /qdrant \
    --env QDRANT__TELEMETRY_DISABLED=true \
    --env QDRANT__SERVICE__HTTP_PORT=6334 \
    --env QDRANT__SERVICE__GRPC_PORT=6336 \
    --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    --bind "$CACERT:/etc/ssl/certs/ca-bundle.crt" \
    --bind "$LOCAL:/qdrant/storage" "$QDRANT_SIF" \
    > "$WORKDIR/logs/qdrant_index_${SLURM_JOB_ID}.log" 2>&1 &
QPID=$!
for i in $(seq 1 240); do
    curl -sf http://localhost:6334/healthz >/dev/null 2>&1 && { echo "[$(date)] Qdrant ready after $((i*5))s"; break; }
    [ $i -eq 240 ] && { echo "ERROR: Qdrant not ready in 20 min"; exit 1; }
    sleep 5
done

for c in chunks entities relationships; do
    echo "[$(date)] BEFORE $c: points=$(field $c points_count)" \
         "indexed=$(field $c indexed_vectors_count)" \
         "status=$(field $c status) threshold=$(field $c indexing_threshold)"
done

echo "[$(date)] Setting indexing_threshold=$THRESHOLD on all three collections ..."
for c in chunks entities relationships; do
    curl -sf -X PATCH "http://localhost:6334/collections/lightrag_vdb_$c" \
        -H 'Content-Type: application/json' \
        -d "{\"optimizers_config\":{\"indexing_threshold\":$THRESHOLD}}" >/dev/null \
        && echo "  $c -> $THRESHOLD" || echo "  $c PATCH FAILED"
done

# Gate on indexed_vectors_count, not status. With a freshly-raised threshold the
# optimizer needs a moment to queue work, so "green" can briefly be stale.
echo "[$(date)] Waiting for HNSW build (polling indexed_vectors_count)..."
sleep 60
for i in $(seq 1 660); do
    rp=$(field relationships points_count); ri=$(field relationships indexed_vectors_count)
    rs=$(field relationships status)
    cp=$(field chunks indexed_vectors_count); ep=$(field entities indexed_vectors_count)
    [ $((i % 5)) -eq 1 ] && echo "[$(date)] rel $ri/$rp ($rs) | chunks_idx=$cp entities_idx=$ep"
    if [ "$rs" = "green" ] && [ -n "$ri" ] && [ -n "$rp" ] && [ "$ri" -ge "$rp" ]; then
        echo "[$(date)] *** HNSW BUILD COMPLETE after $((i)) minutes ***"; break
    fi
    [ $i -eq 660 ] && echo "[$(date)] WARNING: still building after 11h — writing back anyway"
    sleep 60
done

echo ""
echo "=============================================================="
for c in chunks entities relationships; do
    echo "  $c: points=$(field $c points_count) indexed=$(field $c indexed_vectors_count)" \
         "status=$(field $c status) threshold=$(field $c indexing_threshold)"
done
FC=$(field chunks points_count); FE=$(field entities points_count); FR=$(field relationships points_count)
echo "  TOTAL: $((FC + FE + FR))  (expect $((EXPECT_CHUNKS + EXPECT_ENTITIES + EXPECT_RELATIONS)))"
echo "=============================================================="

OK=1
[ "$FC" = "$EXPECT_CHUNKS" ]    || { echo "MISMATCH: chunks";        OK=0; }
[ "$FE" = "$EXPECT_ENTITIES" ]  || { echo "MISMATCH: entities";      OK=0; }
[ "$FR" = "$EXPECT_RELATIONS" ] || { echo "MISMATCH: relationships"; OK=0; }

kill "$QPID" 2>/dev/null
for i in $(seq 1 150); do kill -0 "$QPID" 2>/dev/null || break; sleep 2; done
echo "[$(date)] Qdrant stopped."

writeback
echo "chunks=$FC entities=$FE relationships=$FR" > "$STORE/.last_sync_counts"

[ $OK -eq 1 ] && { echo "[$(date)] *** INDEXED STORE VERIFIED: $((FC+FE+FR)) vectors ***"; exit 0; }
echo "[$(date)] *** COUNT MISMATCH — inspect before deploying ***"
exit 2
