#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=qdrant_merge_par
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/qdrant_merge_par_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/qdrant_merge_par_%j.err
#SBATCH --time=12:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=256G
#SBATCH --signal=B:TERM@1800
# ^ SIGTERM to this shell 30 min BEFORE the wall. The trap stops Qdrant
#   gracefully and rsyncs the node-local destination back to Lustre. Without it
#   SLURM's ~30s KillWait discards the whole merge — the first attempt at this
#   job had no trap and would have thrown away 8 CPU-hours at the wall.

# Endgame merge for the corpus reembed. NO GPU — pure data movement.
#
# The relationships stage was sharded across clusters (REBUILD_SHARD=k/N), each
# shard committing into its own Qdrant store. Qdrant stores CANNOT be merged at
# the file level (segment dirs carry random UUIDs), so this merges at the API
# level via scripts/merge_qdrant_collections.py: scroll every point out of a
# source instance, upsert into the destination. Point IDs are content-derived,
# so the base range shared by every store re-upserts idempotently.
#
# Sources (all relationship-only stores) and the destination:
#   qdrant_tail_race   chunks=445394 entities=3586043 relationships=360880 <- DEST seed
#   qdrant_rel_s1      relationships=3287031   (base + shard 1/8)
#   qdrant_rel_s1nibi4 relationships=4561091   (base + shard 3/4 + shard 5/8)
#   qdrant_rel_ror     relationships=5198123   (base + shard 0/2 evens)
#
# Shard coverage proof: evens (i%2==0) + odds-q3 (i%4==3) + s18 (i%8==1) +
# s58 (i%8==5) partitions every edge index, so the union MUST be exactly
# 8,096,245 relationships. Any other number means a shard is short.
#
# SAFETY: qdrant_tail_race holds the only copy of the chunks and entities
# collections and is NEVER modified. Output goes to a new dir, qdrant_final.
#
# RESUMABLE: if qdrant_final already exists it is used as the seed instead of
# qdrant_tail_race, and merge_qdrant_collections.py skips points already in the
# destination — so a walltime kill costs only the current in-flight batch.

set -o pipefail

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR="${VENV_DIR:-$WORKDIR/venv}"
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
DST_SEED="$WORKDIR/qdrant_tail_race"
DST_OUT="$WORKDIR/qdrant_final"
COLL=lightrag_vdb_relationships

# PARALLEL VARIANT. Measured: HTTP 465 pts/s -> gRPC 548 pts/s, only 1.18x. That
# small gain is the evidence that the bottleneck is NOT the wire format but the
# client materialising 4096 Python floats per point (~2.2M allocations/s). A
# client-CPU bound scales near-linearly across processes, and we use ~1 of 32
# cores — so the remaining sources are merged CONCURRENTLY, one process each.
#
# Each entry is "store:http_port:grpc_port". Source 1 (qdrant_rel_s1) is omitted:
# the sequential job finishes it first, and re-listing it would force a pointless
# 3.29M-point re-scroll just to skip every point.
#
# Node-local budget: dest ~110G + 78G + 66G = ~254G of the 375G /localscratch.
SOURCES_PAR="qdrant_rel_s1nibi4:6333:6335 qdrant_rel_ror:6343:6345"

EXPECT_CHUNKS=445394
EXPECT_ENTITIES=3586043
EXPECT_RELATIONS=8096245

LOCAL="$SLURM_TMPDIR"
DST_LOCAL="$LOCAL/dst"
SRC_LOCAL="$LOCAL/src"
DST_PID=""
SRC_PID=""
SRC_PIDS=""
MERGE_PID=""

module load python/3.11 2>/dev/null || true
module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true
source "$VENV_DIR/bin/activate"

CACERT=$(python -c "import certifi; print(certifi.where())" 2>/dev/null)
echo "[$(date)] CA bundle: $CACERT"

# ── helpers ───────────────────────────────────────────────────────────────────
# Point counts come from the exact count API. Parse with sed, NOT a bare
# grep -oE '[0-9]+': the JSON also carries a "time":0.00038 field and a lazy
# grep picks that up and invents progress.
qcount() {  # qcount <port> <collection>
    curl -sf -X POST "http://localhost:$1/collections/$2/points/count" \
        -H 'Content-Type: application/json' -d '{"exact":true}' 2>/dev/null \
        | sed -n 's/.*"count":\([0-9]*\).*/\1/p'
}

start_qdrant() {  # start_qdrant <storage_dir> <http_port> <grpc_port> -> echoes pid
    # BOTH ports must be explicit. Qdrant serves gRPC on 6334 by default, so a
    # second instance with HTTP_PORT=6334 silently kills the first instance's gRPC
    # ("Error while starting gRPC server: transport error") — which is exactly what
    # forced the slow HTTP/JSON path in the first two attempts at this merge.
    local dir="$1" port="$2" gport="$3"
    apptainer run --writable-tmpfs --pwd /qdrant \
        --env QDRANT__TELEMETRY_DISABLED=true \
        --env QDRANT__SERVICE__HTTP_PORT="$port" \
        --env QDRANT__SERVICE__GRPC_PORT="$gport" \
        --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
        --env SSL_CERT_DIR=/etc/ssl/certs \
        --env QDRANT__SERVICE__MAX_REQUEST_SIZE_MB=1024 \
        --bind "$CACERT:/etc/ssl/certs/ca-bundle.crt" \
        --bind "$dir:/qdrant/storage" "$QDRANT_SIF" \
        > "$WORKDIR/logs/qdrant_${SLURM_JOB_ID}_${port}.log" 2>&1 &
    echo $!
}

wait_ready() {  # wait_ready <port> ; large stores need time to load segments
    local port="$1"
    for i in $(seq 1 240); do
        curl -sf "http://localhost:$port/healthz" >/dev/null 2>&1 && {
            echo "[$(date)] Qdrant :$port ready after $((i * 5))s"; return 0; }
        sleep 5
    done
    echo "[$(date)] ERROR: Qdrant :$port did not become ready in 20 min"
    return 1
}

stop_qdrant() {  # stop_qdrant <pid> — graceful, so segments flush to disk
    local pid="$1"
    [ -z "$pid" ] && return 0
    kill "$pid" 2>/dev/null
    for i in $(seq 1 150); do
        kill -0 "$pid" 2>/dev/null || { echo "[$(date)] Qdrant $pid stopped"; return 0; }
        sleep 2
    done
    echo "[$(date)] WARNING: Qdrant $pid did not exit gracefully; forcing"
    kill -9 "$pid" 2>/dev/null
}

writeback() {
    [ -d "$DST_LOCAL" ] || return 0
    echo "[$(date)] Syncing merged store to $DST_OUT ..."
    mkdir -p "$DST_OUT"
    rsync -a --delete "$DST_LOCAL/" "$DST_OUT/" \
        && echo "[$(date)] Writeback complete ($(du -sh "$DST_OUT" | cut -f1))." \
        || echo "[$(date)] ERROR: writeback failed"
}

on_term() {
    echo "[$(date)] SIGTERM (walltime approaching) — saving partial merge."
    for p in $MERGE_PID; do kill "$p" 2>/dev/null; done
    for p in $SRC_PIDS $SRC_PID; do stop_qdrant "$p"; done
    stop_qdrant "$DST_PID"
    writeback
    echo "[$(date)] Partial merge saved. Resubmit to continue (skip-existing makes it cheap)."
    exit 0
}
trap on_term TERM

# ── 0. wait for the cross-cluster staging to finish ───────────────────────────
# qdrant_rel_s1nibi4 arrives from Nibi over Globus. Queue wait and transfer
# overlap, so the job may start first — staging a half-transferred store would
# silently merge a short shard. The sentinel is touched only after Globus
# reports SUCCEEDED and the arrived store's .last_sync_counts verifies.
READY="$WORKDIR/.merge_sources_ready"
for i in $(seq 1 240); do
    [ -f "$READY" ] && { echo "[$(date)] Sources ready after $((i * 30))s"; break; }
    [ $i -eq 240 ] && { echo "[$(date)] ERROR: $READY never appeared (2h)"; exit 1; }
    sleep 30
done

for entry in $SOURCES_PAR; do
    s="${entry%%:*}"
    [ -d "$WORKDIR/$s" ] || { echo "[$(date)] ERROR: missing source $WORKDIR/$s"; exit 1; }
done

# ── 1. seed the destination onto node-local NVMe ──────────────────────────────
SEED_FROM="$DST_SEED"
if [ -d "$DST_OUT" ] && [ "$(ls -A "$DST_OUT" 2>/dev/null)" ]; then
    # Non-empty check, NOT a .last_sync_counts check: the TERM trap writes back
    # without that marker, and keying off it would discard a partial merge.
    SEED_FROM="$DST_OUT"
    echo "[$(date)] RESUME: seeding from previous merge output in $DST_OUT"
fi
echo "[$(date)] Seeding destination from $SEED_FROM ..."
mkdir -p "$DST_LOCAL"
rsync -a "$SEED_FROM/" "$DST_LOCAL/" || { echo "ERROR: dest seed rsync failed"; exit 1; }
echo "[$(date)] Destination seeded ($(du -sh "$DST_LOCAL" | cut -f1))."

DST_PID=$(start_qdrant "$DST_LOCAL" 6334 6336)
wait_ready 6334 || exit 1
echo "[$(date)] DEST seed counts: chunks=$(qcount 6334 lightrag_vdb_chunks)" \
     "entities=$(qcount 6334 lightrag_vdb_entities)" \
     "relationships=$(qcount 6334 $COLL)"

# ── 2. merge the remaining sources CONCURRENTLY ───────────────────────────────
# Stage both first (Lustre reads overlap), then run one merge process per source.
for entry in $SOURCES_PAR; do
    s="${entry%%:*}"
    echo "[$(date)] staging $s ..."
    rm -rf "$LOCAL/src_$s"; mkdir -p "$LOCAL/src_$s"
    rsync -a "$WORKDIR/$s/" "$LOCAL/src_$s/" || { echo "ERROR: rsync $s failed"; exit 1; }
    echo "[$(date)] $s staged ($(du -sh "$LOCAL/src_$s" | cut -f1))."
done
df -h "$LOCAL" | tail -1

SRC_PIDS=""
MERGE_PIDS=""
for entry in $SOURCES_PAR; do
    s="${entry%%:*}"; rest="${entry#*:}"; hp="${rest%%:*}"; gp="${rest##*:}"
    p=$(start_qdrant "$LOCAL/src_$s" "$hp" "$gp")
    SRC_PIDS="$SRC_PIDS $p"
    if ! wait_ready "$hp"; then echo "ERROR: $s qdrant not ready"; stop_qdrant "$p"; exit 1; fi
    echo "[$(date)] $s relationships=$(qcount $hp $COLL)"
done

for entry in $SOURCES_PAR; do
    s="${entry%%:*}"; rest="${entry#*:}"; hp="${rest%%:*}"; gp="${rest##*:}"
    echo "[$(date)] MERGING $s (http=$hp grpc=$gp) in parallel"
    python "$WORKDIR/scripts/merge_qdrant_grpc.py" \
        --src-http "$hp" --src-grpc "$gp" --dst-http 6334 --dst-grpc 6336 \
        --collection "$COLL" --batch 4000 --inflight 8 --restore-threshold 10000 \
        > "$WORKDIR/logs/merge_${SLURM_JOB_ID}_${s}.log" 2>&1 &
    MERGE_PIDS="$MERGE_PIDS $!"
done
MERGE_PID="$MERGE_PIDS"   # so the TERM trap can kill them all

rc=0
for p in $MERGE_PIDS; do wait "$p" || rc=1; done
for entry in $SOURCES_PAR; do
    s="${entry%%:*}"
    echo "===== merge log: $s ====="
    tail -4 "$WORKDIR/logs/merge_${SLURM_JOB_ID}_${s}.log"
done
for p in $SRC_PIDS; do stop_qdrant "$p"; done
SRC_PID=""
for entry in $SOURCES_PAR; do rm -rf "$LOCAL/src_${entry%%:*}"; done
if [ $rc -ne 0 ]; then
    echo "[$(date)] ERROR: at least one parallel merge failed"
    stop_qdrant "$DST_PID"; writeback; exit 1
fi
echo "[$(date)] After parallel merges: relationships=$(qcount 6334 $COLL)"
writeback

# ── 3. let the optimizer finish building HNSW before we stop Qdrant ───────────
# The merge disables indexing during load and restores the threshold at the end;
# indexing then proceeds as a background optimizer task. Stopping Qdrant early
# would leave unindexed segments (correct results, slow queries).
echo "[$(date)] Waiting for collection to finish indexing (status=green)..."
for i in $(seq 1 480); do
    st=$(curl -sf "http://localhost:6334/collections/$COLL" 2>/dev/null \
         | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["status"])' 2>/dev/null)
    idx=$(curl -sf "http://localhost:6334/collections/$COLL" 2>/dev/null \
         | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r.get("indexed_vectors_count",0), r.get("points_count",0))' 2>/dev/null)
    # Gate on indexed_vectors_count too: with indexing disabled the collection
    # reports green because nothing is QUEUED, not because anything is indexed.
    set -- $idx
    if [ "$st" = "green" ] && [ -n "$1" ] && [ "$1" -ge "${2:-0}" ] 2>/dev/null; then
        echo "[$(date)] Indexing complete after $((i * 30))s ($1/$2 indexed)"; break
    fi
    [ $((i % 10)) -eq 1 ] && echo "[$(date)] indexing: $idx status=$st"
    [ $i -eq 480 ] && echo "[$(date)] WARNING: still '$st' after 4h — continuing anyway"
    sleep 30
done

# ── 4. final verification while the destination is still live ─────────────────
FC=$(qcount 6334 lightrag_vdb_chunks)
FE=$(qcount 6334 lightrag_vdb_entities)
FR=$(qcount 6334 $COLL)
TOTAL=$((FC + FE + FR))
echo ""
echo "=============================================================="
echo "[$(date)] FINAL COUNTS"
echo "  chunks:        $FC   (expect $EXPECT_CHUNKS)"
echo "  entities:      $FE   (expect $EXPECT_ENTITIES)"
echo "  relationships: $FR   (expect $EXPECT_RELATIONS)"
echo "  TOTAL:         $TOTAL   (expect $((EXPECT_CHUNKS + EXPECT_ENTITIES + EXPECT_RELATIONS)))"
echo "=============================================================="

OK=1
[ "$FC" = "$EXPECT_CHUNKS" ]    || { echo "MISMATCH: chunks";        OK=0; }
[ "$FE" = "$EXPECT_ENTITIES" ]  || { echo "MISMATCH: entities";      OK=0; }
[ "$FR" = "$EXPECT_RELATIONS" ] || { echo "MISMATCH: relationships"; OK=0; }

stop_qdrant "$DST_PID"; DST_PID=""

# ── 5. write the merged store back ────────────────────────────────────────────
# Always sync back, even on a count mismatch: the merged data is expensive and a
# short count is diagnosable afterwards. qdrant_tail_race is never touched.
writeback
echo "chunks=$FC entities=$FE relationships=$FR" > "$DST_OUT/.last_sync_counts"

if [ $OK -eq 1 ]; then
    echo "[$(date)] *** MERGE VERIFIED: $TOTAL vectors in $DST_OUT ***"
    exit 0
fi
echo "[$(date)] *** MERGE COMPLETED WITH COUNT MISMATCH — inspect before deploying ***"
exit 2
