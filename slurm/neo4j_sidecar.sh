# neo4j_sidecar.sh — Neo4j graph-store sidecar for ingest jobs (Fix-graph,
# docs/INGEST_SCALING_BOTTLENECK.md). Source this from a SLURM job, then:
#
#     GRAPH_BACKEND=${GRAPH_BACKEND:-networkx}       # neo4j | networkx
#     source "$WORKDIR/slurm/neo4j_sidecar.sh"
#     neo4j_guard || exit 1                           # marker vs requested backend
#     neo4j_start || exit 1                           # no-op unless GRAPH_BACKEND=neo4j
#     ... GRAPH_STORAGE="${GRAPH_STORAGE:-}" ... python -m pipeline.ingest & PYTHON_PID=$!
#     [ -n "$NEO4J_PID" ] && { neo4j_watchdog "$PYTHON_PID" & NEO4J_WATCHDOG_PID=$!; }
#     wait ...; [ -n "$NEO4J_WATCHDOG_PID" ] && kill $NEO4J_WATCHDOG_PID 2>/dev/null
#     neo4j_stop
#
# On success neo4j_start exports GRAPH_STORAGE=Neo4JStorage and NEO4J_URI/
# NEO4J_USERNAME/NEO4J_PASSWORD, which pipeline/ingest.py and LightRAG read.
# There is deliberately NO silent fallback to NetworkXStorage: after the store has
# been migrated, falling back would resume from the frozen GraphML and fork the
# graph, so a Neo4j start failure must kill the job (GPUs idle < forked graph).
#
# Data lives directly on scratch ($WORKDIR/$NEO4J_SUBDIR/data), NOT on node-local
# NVMe: the graph is THE expensive intermediate, and Neo4j's WAL makes commits
# durable at commit time — no rsync-back window to lose a cycle's delta to a
# walltime kill (the §3.11 Qdrant failure mode). Vectors can afford that window
# (rebuildable by reembed); the graph cannot.
#
# Env knobs (all optional): NEO4J_SUBDIR (neo4j_aprag), NEO4J_SIF
# ($WORKDIR/neo4j_5.26-community.sif), NEO4J_HEAP (6G), NEO4J_PAGECACHE (3G) —
# raise --mem when raising these; NEO4J_BOLT_PORT (7687), NEO4J_HTTP_PORT (7474).
# One-time staging (login node, has internet):
#     apptainer pull $WORKDIR/neo4j_5.26-community.sif docker://neo4j:5.26-community
# The generated per-store password persists in $NEO4J_DIR/.neo4j_password (0600) —
# it must outlive the job because it is baked into the Neo4j auth store on disk.

NEO4J_PID=""
NEO4J_WATCHDOG_PID=""

neo4j_guard() {
    # Cheap bash-side mirror of pipeline/ingest.py::check_graph_backend — abort
    # BEFORE burning GPU-queue time. The python guard remains authoritative.
    local marker="$WORKDIR/${STORAGE_SUBDIR:-rag_storage_aprag}/.graph_backend"
    local want="NetworkXStorage"
    [ "${GRAPH_BACKEND:-networkx}" = "neo4j" ] && want="Neo4JStorage"
    if [ -f "$marker" ] && [ "${GRAPH_BACKEND_OVERRIDE:-0}" != "1" ]; then
        local have
        have=$(cat "$marker")
        if [ -n "$have" ] && [ "$have" != "$want" ]; then
            echo "[$(date)] FATAL: store was last written with graph_storage=$have but this job requests $want."
            echo "         NetworkX->Neo4j: run slurm/job_graph_migrate_neo4j.slurm first."
            echo "         Neo4j->NetworkX rollback: export a fresh GraphML (scripts/export_neo4j_graphml.py), then GRAPH_BACKEND_OVERRIDE=1."
            return 1
        fi
    fi
    return 0
}

neo4j_start() {
    [ "${GRAPH_BACKEND:-networkx}" = "neo4j" ] || return 0

    NEO4J_SIF="${NEO4J_SIF:-$WORKDIR/neo4j_5.26-community.sif}"
    if [ ! -f "$NEO4J_SIF" ]; then
        echo "[$(date)] FATAL: GRAPH_BACKEND=neo4j but no image at $NEO4J_SIF."
        echo "         Stage it once from a login node (offline compute nodes cannot pull):"
        echo "         apptainer pull $NEO4J_SIF docker://neo4j:5.26-community"
        return 1
    fi

    NEO4J_DIR="$WORKDIR/${NEO4J_SUBDIR:-neo4j_aprag}"
    mkdir -p "$NEO4J_DIR/data" "$NEO4J_DIR/logs"
    chmod 700 "$NEO4J_DIR"

    # Per-store password: generated once, then required forever by the auth store
    # inside $NEO4J_DIR/data. Compute nodes are shared, so never use a guessable
    # default even on a localhost-only listener.
    if [ ! -s "$NEO4J_DIR/.neo4j_password" ]; then
        ( umask 077
          { openssl rand -hex 16 2>/dev/null \
            || python3 -c "import secrets; print(secrets.token_hex(16))"; } \
            > "$NEO4J_DIR/.neo4j_password" )
    fi
    NEO4J_PASSWORD=$(cat "$NEO4J_DIR/.neo4j_password")

    module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true

    local bolt="${NEO4J_BOLT_PORT:-7687}" http="${NEO4J_HTTP_PORT:-7474}"
    echo "[$(date)] Starting Neo4j sidecar (data: $NEO4J_DIR/data, heap ${NEO4J_HEAP:-16G} + pagecache ${NEO4J_PAGECACHE:-32G})..."
    # NEO4J_AUTH only takes effect on a fresh /data; afterwards the on-disk auth
    # store rules (which is why the password file above must persist).
    # --cleanenv: do NOT inherit the host environment. Neo4j treats every
    # NEO4J_*-prefixed env var as a config setting, so sidecar knobs like
    # NEO4J_SUBDIR/NEO4J_HEAP would leak in and trip strict config validation
    # ("Unrecognized setting: SUBDIR"). Only the explicit --env config below
    # (and NEO4J_AUTH) should reach the container.
    apptainer run --cleanenv --writable-tmpfs \
        --env NEO4J_AUTH="neo4j/$NEO4J_PASSWORD" \
        --env NEO4J_server_default__listen__address=127.0.0.1 \
        --env NEO4J_server_bolt_listen__address=127.0.0.1:$bolt \
        --env NEO4J_server_http_listen__address=127.0.0.1:$http \
        --env NEO4J_server_memory_heap_initial__size="${NEO4J_HEAP:-16G}" \
        --env NEO4J_server_memory_heap_max__size="${NEO4J_HEAP:-16G}" \
        --env NEO4J_server_memory_pagecache_size="${NEO4J_PAGECACHE:-32G}" \
        --env NEO4J_server_bolt_thread__pool__min__size="${NEO4J_BOLT_THREADS_MIN:-20}" \
        --env NEO4J_server_bolt_thread__pool__max__size="${NEO4J_BOLT_THREADS:-400}" \
        --env NEO4J_dbms_usage__report_enabled=false \
        --bind "$NEO4J_DIR/data:/data" \
        --bind "$NEO4J_DIR/logs:/logs" \
        "$NEO4J_SIF" \
        > "$NEO4J_DIR/logs/sidecar_${SLURM_JOB_ID:-manual}.out" 2>&1 &
    NEO4J_PID=$!

    # First boot after a hard kill can replay the WAL (~30 min for this graph) — allow up to 40 min.
    local i
    for i in $(seq 1 480); do
        if curl -sf "http://127.0.0.1:$http" > /dev/null 2>&1; then
            echo "[$(date)] Neo4j ready after $((i * 5))s"
            export GRAPH_STORAGE="Neo4JStorage"
            export NEO4J_URI="bolt://127.0.0.1:$bolt"
            export NEO4J_USERNAME="neo4j"
            export NEO4J_PASSWORD
            return 0
        fi
        if ! kill -0 "$NEO4J_PID" 2>/dev/null; then
            break
        fi
        sleep 5
    done
    echo "[$(date)] FATAL: Neo4j did not become ready (see $NEO4J_DIR/logs/sidecar_${SLURM_JOB_ID:-manual}.out)."
    echo "         NOT falling back to NetworkXStorage — that would fork the graph."
    kill "$NEO4J_PID" 2>/dev/null
    wait "$NEO4J_PID" 2>/dev/null
    NEO4J_PID=""
    return 1
}

neo4j_watchdog() {
    # If the sidecar dies mid-run every graph upsert fails after retries and docs
    # bleed into 'failed' for hours (INGEST_SCALING_BOTTLENECK.md risk list) —
    # instead SIGTERM the ingest (its handler flushes storages) and stop the loss.
    local ingest_pid="$1"
    while kill -0 "$ingest_pid" 2>/dev/null; do
        if ! kill -0 "$NEO4J_PID" 2>/dev/null; then
            echo "[$(date)] FATAL: Neo4j sidecar died mid-run — stopping ingest to avoid mass doc failures."
            kill "$ingest_pid" 2>/dev/null
            return 1
        fi
        sleep 30
    done
    return 0
}

neo4j_stop() {
    [ -n "$NEO4J_PID" ] || return 0
    echo "[$(date)] Stopping Neo4j sidecar (graceful checkpoint)..."
    kill "$NEO4J_PID" 2>/dev/null
    local i
    for i in $(seq 1 36); do   # up to 3 min for the final checkpoint
        kill -0 "$NEO4J_PID" 2>/dev/null || break
        sleep 5
    done
    if kill -0 "$NEO4J_PID" 2>/dev/null; then
        echo "[$(date)] WARNING: Neo4j still up after 3 min — SIGKILL (WAL recovery will replay next start)."
        kill -9 "$NEO4J_PID" 2>/dev/null
    fi
    wait "$NEO4J_PID" 2>/dev/null
    NEO4J_PID=""
    echo "[$(date)] Neo4j sidecar stopped."
}
