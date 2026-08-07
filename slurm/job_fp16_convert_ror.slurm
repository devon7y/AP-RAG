#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=fp16_convert
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/fp16_convert_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/fp16_convert_%j.err
#SBATCH --time=12:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=32
#SBATCH --mem=300G
# Sized to PLACE, not to be fast. Rorqual currently has 116 nodes draining, so
# large contiguous requests sit unschedulable ("Nodes required are DOWN,
# DRAINED or reserved") -- 192/mem=0 and 64/400G both did. 220G still clears
# the 118G MaxRSS the source qdrant reached loading the 197 GB store, and 24
# workers converted 445k chunks in 79s, so throughput is not the constraint.
#SBATCH --signal=B:TERM@1800
# ^ SIGTERM 30 min before the wall so the trap can rsync finished collections
#   back to Lustre. Without it SLURM's ~30s KillWait discards the whole run.
#
# Rebuild the canonical fp32 store as TWO float16 stores:
#     fp16 4096d -> ~99 GB   (halves rescore I/O)
#     uint8 4096d -> ~50 GB  (quarters it; qdrant has no fp8 -- 8-bit is uint8)
#
# BOTH are built in ONE read pass, then compared against the canonical fp32
# ranking on this node, so the winner is chosen on measured recall rather than
# assumption. Only the winner gets transferred to the PC.
#
# int8 matters more than it looks: it is the first format where the ENTITIES
# store (14.7 GB) fits the PC's ~14-16 GB of usable page cache, so `local` mode
# stops being disk-bound. fp16 leaves entities at 29.4 GB, still ~2x over.
#
# The 1024d Matryoshka variant was DROPPED: measured on the live PC against the
# real fp32 index it scored recall@10 = 0.792 / recall@40 = 0.810, as lossy as
# disabling rescore. Not worth building.
#
# Why on HPC: `datatype` is fixed at collection creation, so this is a full
# re-write of 12.1M x 4096 vectors, and the cost is client-side float handling.
# The PC has 8 cores and is serving live traffic; Ror has 192 idle ones and
# already holds the canonical fp32 store.
#
# NO GPU and NO re-embedding: this is a pure data transform of existing vectors.

set -uo pipefail

WORKDIR=/scratch/devon7y/westbury_rag
SRC_STORE=$WORKDIR/qdrant_final
QDRANT_SIF=$WORKDIR/qdrant_latest.sif
OUTU8=$WORKDIR/qdrant_fp16_4096
SCRIPT=$WORKDIR/fp16_convert_collections.py
# venv_westbury is the durable Ror env (httpx 0.28.1, py3.11); bare python3 on
# the compute nodes has no httpx.
PY=$WORKDIR/venv_westbury/bin/python
SHARDS=${SHARDS:-24}

SRC_HTTP=7100; SRC_GRPC=7101
DU8_HTTP=7300; DU8_GRPC=7301
# BOTH ports must be explicit for every instance. Qdrant serves gRPC on 6334 by
# default, so a second instance defaulting its gRPC port silently kills the
# first instance's gRPC -- and that is only ever logged in the sidecar log.

mkdir -p "$WORKDIR/logs"

# Targets go on node-local NVMe when there is room (HNSW build is random I/O and
# Lustre is bad at it), otherwise straight to Lustre.
LOCAL_FREE_GB=$(df -BG --output=avail "${SLURM_TMPDIR:-/tmp}" 2>/dev/null | tail -1 | tr -dc '0-9')
LOCAL_FREE_GB=${LOCAL_FREE_GB:-0}
echo "[$(date)] node-local free: ${LOCAL_FREE_GB}G"
if [ "$LOCAL_FREE_GB" -ge 200 ]; then
    DU8_DIR=$SLURM_TMPDIR/fp16_4096
    STAGED_LOCAL=1
else
    echo "[$(date)] not enough node-local space; building directly on Lustre"
    DU8_DIR=$OUTU8
    STAGED_LOCAL=0
fi
mkdir -p "$DU8_DIR" "$OUTU8"

# Stage the SOURCE to node-local NVMe. This is NOT optional and NOT about
# Lustre being "degraded": single-stream Lustre measures 180 MB/s right now,
# but 24 workers doing CONCURRENT RANDOM reads over a 197 GB Lustre-resident
# store saturate it and blow Qdrant's 60s internal read cap. That killed jobs
# 18272758 and 18306609 in exactly the same way. Retries cannot help when every
# attempt exceeds the cap. NVMe absorbs the random-read pattern; Lustre does not.
#
# Only ONE target is built: 197 GB source + 115 GB fp16 = 312 GB fits the 374 GB
# local disk; two targets would not.
#
# uint8 was tried and is UNUSABLE: qdrant's `datatype: uint8` truncates floats
# toward zero, and every value in these cosine-normalised embeddings has |x| < 1,
# so all 12.1M vectors stored as ZERO. It still reported green with idx == pts
# and BQ applied -- recall vs fp32 measured 0.000. Signed embeddings cannot be
# stored as unsigned bytes: an additive shift would be needed, and cosine is not
# invariant under a shift.
if [ "$LOCAL_FREE_GB" -ge 270 ]; then
    echo "[$(date)] staging source store to node-local NVMe (197 GB, sequential)..."
    SRC_LOCAL=$SLURM_TMPDIR/src_store
    mkdir -p "$SRC_LOCAL"
    if rsync -a "$SRC_STORE/" "$SRC_LOCAL/"; then
        SRC_STORE=$SRC_LOCAL
        echo "[$(date)] source staged: $(du -sh "$SRC_LOCAL" 2>/dev/null | cut -f1)"
    else
        echo "[$(date)] ERROR: source staging failed"; exit 1
    fi
else
    echo "[$(date)] ERROR: only ${LOCAL_FREE_GB}G local, need 270G to stage source"
    exit 1
fi

sync_back () {
    [ "$STAGED_LOCAL" = "1" ] || { echo "[$(date)] built in place, no sync"; return; }
    echo "[$(date)] syncing targets back to Lustre..."
    rsync -a --delete "$DU8_DIR/" "$OUTU8/" && echo "[$(date)] fp16_4096 synced"
}

PIDS=()
cleanup () {
    echo "[$(date)] cleanup: stopping qdrant instances"
    for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
    sleep 10
}
on_term () { echo "[$(date)] SIGTERM -- wall approaching"; sync_back; cleanup; exit 143; }
trap on_term TERM
trap cleanup EXIT

module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true

# Qdrant 1.17 PANICS at startup without a CA bundle ("No CA certificates were
# loaded from the system" -> InferenceService::init_global unwrap). Same fix the
# ingest/merge jobs already carry; omitting it killed job 18235010.
CACERT=$("$PY" -c "import certifi; print(certifi.where())" 2>/dev/null || echo "")
BIND_CA=""
[ -n "$CACERT" ] && BIND_CA="--bind $CACERT:/etc/ssl/certs/ca-bundle.crt"
echo "[$(date)] CA bundle: ${CACERT:-NONE FOUND (qdrant will panic)}"

# CVMFS serves the apptainer runtime over squashfuse, which times out at 10s if
# several containers try to mount it at once ("squashfuse_ll failed to mount ...
# in 10s" -> FATAL, container never starts). Warm it with one trivial exec
# before launching the real instances, and stagger + retry the launches.
warm_apptainer () {
    for i in 1 2 3 4 5; do
        if apptainer exec "$QDRANT_SIF" /bin/true >/dev/null 2>&1; then
            echo "[$(date)] apptainer/CVMFS warm after attempt $i"; return 0
        fi
        echo "[$(date)] apptainer warm attempt $i failed; retrying in 20s"
        sleep 20
    done
    echo "[$(date)] ERROR: apptainer never became usable"; return 1
}

start_qdrant () {
    local store=$1 http=$2 grpc=$3 opt_threads=${4:-8}
    local log="$WORKDIR/logs/qdrant_${http}_${SLURM_JOB_ID}.log"
    mkdir -p "$store"
    local attempt
    for attempt in 1 2 3; do
        : > "$log"
        _launch_qdrant "$store" "$http" "$grpc" "$opt_threads" "$log"
        local pid=$!
        sleep 25
        if grep -qE 'FATAL|container creation failed' "$log" 2>/dev/null; then
            echo "[$(date)] :$http container FATAL on attempt $attempt (CVMFS race); retrying"
            kill "$pid" 2>/dev/null || true
            sleep 20
            continue
        fi
        PIDS+=("$pid")
        echo "[$(date)] :$http container launched (attempt $attempt, pid $pid)"
        return 0
    done
    echo "[$(date)] ERROR :$http container failed to start after 3 attempts"
    return 1
}

_launch_qdrant () {
    local store=$1 http=$2 grpc=$3 opt_threads=$4 log=$5
    # shellcheck disable=SC2086
    # opt_threads=0 on the SOURCE: qdrant_final is the canonical fp32 store and
    # is bound read-write (qdrant needs WAL access to serve at all), so the
    # optimizer is disabled to stop it rewriting segments underneath us. The
    # store is already fully optimized, so it has no work to do anyway.
    apptainer run --writable-tmpfs --pwd /qdrant \
        --env QDRANT__TELEMETRY_DISABLED=true \
        --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
        --env SSL_CERT_DIR=/etc/ssl/certs \
        --env QDRANT__SERVICE__HTTP_PORT="$http" \
        --env QDRANT__SERVICE__GRPC_PORT="$grpc" \
        --env QDRANT__SERVICE__MAX_REQUEST_SIZE_MB=1024 \
        --env QDRANT__STORAGE__OPTIMIZERS__MAX_OPTIMIZATION_THREADS="$opt_threads" \
        $BIND_CA \
        --bind "$store:/qdrant/storage" "$QDRANT_SIF" \
        > "$log" 2>&1 &
}

# Second arg = max wait in seconds. The SOURCE opens a 197 GB store with an
# 8.1M-point collection and needs far longer than an empty target; 10 min was
# not enough in job 18235010 (it was still in "Loading collection" when the
# wait expired).
wait_ready () {
    local port=$1 max=${2:-600}
    for i in $(seq 1 $((max / 5))); do
        curl -sf "http://localhost:$port/healthz" >/dev/null 2>&1 && {
            echo "[$(date)] qdrant :$port ready after $((i*5))s"; return 0; }
        # fail fast on a dead process (startup panic / container mount failure)
        # instead of waiting out the clock -- neither surfaces in job stdout.
        grep -qE "Panic occurred|FATAL|container creation failed" \
            "$WORKDIR/logs/qdrant_${port}_${SLURM_JOB_ID}.log" 2>/dev/null && {
            echo "[$(date)] ERROR qdrant :$port died at startup:"
            grep -E -A2 "Panic occurred|FATAL" \
                "$WORKDIR/logs/qdrant_${port}_${SLURM_JOB_ID}.log" | tail -5
            return 1; }
        sleep 5
    done
    echo "[$(date)] ERROR qdrant :$port never became ready within ${max}s"; return 1
}

qcount () {
    curl -sf --max-time 600 "http://localhost:$1/collections/$2/points/count" \
        -H 'Content-Type: application/json' -d '{"exact":true}' 2>/dev/null \
        | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["result"]["count"])' \
        2>/dev/null || echo 0
}

warm_apptainer || exit 1

echo "[$(date)] starting qdrant instances (staggered)"
start_qdrant "$SRC_STORE" $SRC_HTTP $SRC_GRPC 0 || exit 1
start_qdrant "$DU8_DIR"   $DU8_HTTP $DU8_GRPC 8 || exit 1
wait_ready $DU8_HTTP 300  || exit 1   # empty targets come up in seconds
wait_ready $SRC_HTTP 3600 || exit 1   # 197 GB store on Lustre: allow an hour

SRC=http://localhost:$SRC_HTTP
DU8=http://localhost:$DU8_HTTP

# chunks first: smallest, so a config error surfaces in seconds not hours.
for COLL in lightrag_vdb_chunks lightrag_vdb_entities lightrag_vdb_relationships; do
    echo ""
    echo "================================================================"
    echo "[$(date)] $COLL  (src=$(qcount $SRC_HTTP $COLL))"
    echo "================================================================"

    IDS=$SLURM_TMPDIR/ids_$COLL.json
    "$PY" "$SCRIPT" --src "$SRC" --collection "$COLL" --dump-ids "$IDS" || exit 1

    # Create both destinations ONCE. Letting the 32 workers each try produced a
    # create race: one wins, 31 die on 409 Conflict.
    "$PY" "$SCRIPT" --src "$SRC" --collection "$COLL" \
        --dst "$DU8" --dims 4096 --datatype float16 --init-dest || exit 1

    echo "[$(date)] launching $SHARDS shard workers"
    # Collect worker PIDs and wait on THOSE ONLY. A bare `wait` also waits on
    # the three qdrant sidecars, which never exit -- job 18239318 finished the
    # chunks conversion in 79s and then hung for 8h49m on its own containers.
    WPIDS=()
    for k in $(seq 0 $((SHARDS-1))); do
        "$PY" "$SCRIPT" --src "$SRC" --collection "$COLL" --ids-file "$IDS" \
            --dst "$DU8" --dims 4096 --datatype float16 \
            --shard "$k" --num-shards "$SHARDS" \
            > "$WORKDIR/logs/conv_${COLL}_${k}_${SLURM_JOB_ID}.log" 2>&1 &
        WPIDS+=($!)
    done
    WFAIL=0
    for wp in "${WPIDS[@]}"; do
        wait "$wp" || WFAIL=$((WFAIL + 1))
    done
    [ "$WFAIL" -gt 0 ] && echo "[$(date)] WARNING: $WFAIL/$SHARDS workers exited non-zero"

    # Worker output goes to per-worker logs, so a crash is invisible in this
    # log. Gate on counts and surface a real traceback instead of proceeding
    # with a silently empty collection.
    SRCN=$(qcount $SRC_HTTP $COLL)
    GOTU8=$(qcount $DU8_HTTP $COLL)
    echo "[$(date)] $COLL loaded: src=$SRCN fp16=$GOTU8"

    # Retry ONLY the shards that died, rather than discarding the whole run.
    # Job 18302343 lost 8/24 workers to transient connection drops at 79% of
    # entities and threw away an hour of work. Re-upserting is idempotent
    # (content-derived ids), so a shard can simply be run again.
    if [ "$GOTU8" -lt "$SRCN" ]; then
        FAILED_SHARDS=$(grep -l 'Traceback' "$WORKDIR"/logs/conv_${COLL}_*_"${SLURM_JOB_ID}".log 2>/dev/null \
            | sed -E 's/.*_([0-9]+)_[0-9]+\.log$/\1/' | sort -n | tr '\n' ' ')
        if [ -n "$FAILED_SHARDS" ]; then
            echo "[$(date)] retrying failed shards: $FAILED_SHARDS"
            RPIDS=()
            for k in $FAILED_SHARDS; do
                "$PY" "$SCRIPT" --src "$SRC" --collection "$COLL" --ids-file "$IDS" \
                    --dst "$DU8" --dims 4096 --datatype float16 \
                    --shard "$k" --num-shards "$SHARDS" \
                    > "$WORKDIR/logs/conv_${COLL}_${k}_${SLURM_JOB_ID}.retry.log" 2>&1 &
                RPIDS+=($!)
            done
            for wp in "${RPIDS[@]}"; do wait "$wp" || true; done
            GOTU8=$(qcount $DU8_HTTP $COLL)
            echo "[$(date)] $COLL after shard retry: fp16=$GOTU8"
        fi
    fi

    if [ "$GOTU8" -lt "$SRCN" ]; then
        echo "[$(date)] ERROR: $COLL incomplete -- worker failure(s). Sample traceback:"
        FAILED=$(grep -l 'Traceback' "$WORKDIR"/logs/conv_${COLL}_*_"${SLURM_JOB_ID}".log 2>/dev/null | head -1)
        [ -n "$FAILED" ] && tail -15 "$FAILED"
        echo "[$(date)] failed worker logs: $(grep -lc 'Traceback' "$WORKDIR"/logs/conv_${COLL}_*_"${SLURM_JOB_ID}".log 2>/dev/null | wc -l)"
        exit 1
    fi
done

# Enable BQ + rebuild HNSW on both targets so the PC receives a ready-to-serve
# store (its 8 cores would otherwise spend ~15 min per collection on this).
echo ""
echo "[$(date)] enabling binary quantization and building indexes"
for PORT in $DU8_HTTP; do
    for COLL in lightrag_vdb_chunks lightrag_vdb_entities lightrag_vdb_relationships; do
        curl -sf -X PATCH "http://localhost:$PORT/collections/$COLL" \
            -H 'Content-Type: application/json' \
            -d '{"quantization_config":{"binary":{"always_ram":true}},
                 "optimizers_config":{"indexing_threshold":10000}}' >/dev/null
    done
done

# `green` only means nothing is QUEUED -- gate on indexed_vectors_count.
echo "[$(date)] waiting for indexing to converge"
for i in $(seq 1 240); do
    ALLOK=1
    for PORT in $DU8_HTTP; do
        for COLL in lightrag_vdb_chunks lightrag_vdb_entities lightrag_vdb_relationships; do
            read -r ST IDX PTS <<<"$(curl -sf "http://localhost:$PORT/collections/$COLL" \
                | "$PY" -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r["status"], r["indexed_vectors_count"], r["points_count"])' 2>/dev/null || echo "err 0 1")"
            [ "$ST" = "green" ] && [ "$IDX" -ge $((PTS * 95 / 100)) ] || ALLOK=0
        done
    done
    [ "$ALLOK" = "1" ] && { echo "[$(date)] indexing converged after $((i*30))s"; break; }
    sleep 30
done

echo ""
echo "[$(date)] FINAL COUNTS"
for COLL in lightrag_vdb_chunks lightrag_vdb_entities lightrag_vdb_relationships; do
    printf '  %-32s src=%-10s fp16=%s\n' "$COLL" \
        "$(qcount $SRC_HTTP $COLL)" "$(qcount $DU8_HTTP $COLL)"
done

sync_back
echo "[$(date)] done. output: $OUTU8"
