#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_ingest
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_ingest_%j.err
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --partition=compute_h200
#SBATCH --gpus-per-node=h200:1
#SBATCH --signal=B:TERM@300
# Ported from job_westbury_ingest_v2_nibi.slurm (the canonical H100 leg) for Trillium
# H200. Trillium (SciNet) differences baked in: NO --mem / --cpus-per-task (rejected;
# 1 GPU auto-bundles 24 CPU + ~386 GiB), --gpus-per-node (not --gpus), $HOME read-only
# on compute -> redirected below. @300 = SIGTERM 5 min before walltime for graceful sync.

export WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril

# Persistent data dirs. --export from sbatch overrides these (we pass STORAGE_SUBDIR=rag_storage_full).
export STORAGE_SUBDIR="${STORAGE_SUBDIR:-rag_storage_full}"
QDRANT_SUBDIR="${QDRANT_SUBDIR:-qdrant_storage_aprag}"

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export BNB_CUDA_VERSION=126
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

mkdir -p "$WORKDIR/logs" "$WORKDIR/$STORAGE_SUBDIR" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env_tril.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

# Trillium mounts $HOME READ-ONLY on compute nodes -> apptainer/torch/flashinfer caches
# to ~/.cache/* fail. Redirect HOME to node-local NVMe AFTER module load + venv activate
# (which needed the real HOME). All persistent data uses absolute $WORKDIR paths.
export HOME="$SLURM_TMPDIR"
export FLASHINFER_WORKSPACE_BASE="$SLURM_TMPDIR"
export TORCHINDUCTOR_CACHE_DIR="$SLURM_TMPDIR/inductor"
mkdir -p "$SLURM_TMPDIR/inductor"

echo "[$(date)] Current doc status:"
python3 - <<'PYEOF'
import json
import os
from pathlib import Path

storage = Path(os.environ["WORKDIR"]) / os.environ["STORAGE_SUBDIR"]
status_path = storage / "kv_store_doc_status.json"

if not status_path.exists():
    print("  No doc status file found (fresh run).")
    exit()

status = json.loads(status_path.read_text())
counts = {}
for k, v in status.items():
    if k.startswith("doc-"):
        s = v.get("status", "unknown")
        counts[s] = counts.get(s, 0) + 1

total = sum(counts.values())
print(f"  Total entries: {total}")
for s in ("processed", "processing", "pending", "failed"):
    print(f"    {s}: {counts.get(s, 0)}")
PYEOF

# ── Qdrant sidecar via Apptainer (node-local NVMe storage; NOT NFS/Lustre) ──
QDRANT_SIF="$WORKDIR/qdrant_latest.sif"
QDRANT_LUSTRE="$WORKDIR/$QDRANT_SUBDIR"
QDRANT_LOCAL="$SLURM_TMPDIR/qdrant_storage"
QDRANT_PID=""

qdrant_counts() {
    local out="" c n
    for c in chunks entities relationships; do
        n=$(curl -sf -X POST "http://localhost:6333/collections/lightrag_vdb_${c}/points/count" \
             -H 'Content-Type: application/json' -d '{"exact":true}' 2>/dev/null \
             | grep -o '"count":[0-9]*' | cut -d: -f2)
        out="$out ${c}=${n:-na}"
    done
    echo "$out"
}

if [ -f "$QDRANT_SIF" ]; then
    mkdir -p "$QDRANT_LOCAL" "$QDRANT_LUSTRE"

    if [ "$(ls -A "$QDRANT_LUSTRE" 2>/dev/null)" ]; then
        echo "[$(date)] Seeding Qdrant local storage from scratch..."
        rsync -a "$QDRANT_LUSTRE/" "$QDRANT_LOCAL/"
        echo "[$(date)] Seeded $(du -sh "$QDRANT_LOCAL" | cut -f1) from scratch."
    fi

    module load apptainer 2>/dev/null || module load apptainer/1.4.5 2>/dev/null || true
    CACERT=$(python -c "import certifi; print(certifi.where())" 2>/dev/null)
    echo "[$(date)] Binding CA bundle into Qdrant: $CACERT"
    apptainer run --writable-tmpfs --pwd /qdrant \
    --env QDRANT__TELEMETRY_DISABLED=true \
    --env SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt \
    --env SSL_CERT_DIR=/etc/ssl/certs \
    --env QDRANT__SERVICE__MAX_REQUEST_SIZE_MB=256 \
    --bind "$CACERT:/etc/ssl/certs/ca-bundle.crt" \
    --bind "$QDRANT_LOCAL:/qdrant/storage" "$QDRANT_SIF" &
    QDRANT_PID=$!
    for i in $(seq 1 72); do
        if curl -sf "http://localhost:6333/healthz" > /dev/null 2>&1; then
            echo "[$(date)] Qdrant ready after $((i * 5))s"
            break
        fi
        if [ $i -eq 72 ]; then
            echo "[$(date)] WARNING: Qdrant did not start in 6 min. Falling back to NanoVectorDB."
            kill $QDRANT_PID 2>/dev/null
            QDRANT_PID=""
        fi
        sleep 5
    done
else
    echo "[$(date)] No Qdrant SIF found at $QDRANT_SIF — using NanoVectorDB."
fi

QDRANT_URL=""
if [ -n "$QDRANT_PID" ] && kill -0 $QDRANT_PID 2>/dev/null; then
    QDRANT_URL="http://localhost:6333"
    SEED_COUNTS=$(qdrant_counts)
    echo "[$(date)] [QDRANT-SEED] points:$SEED_COUNTS"
fi

# ── Neo4j graph-store sidecar (sets GRAPH_STORAGE=Neo4JStorage + NEO4J_URI/USERNAME/PASSWORD) ──
GRAPH_BACKEND=${GRAPH_BACKEND:-networkx}
GRAPH_STORAGE="${GRAPH_STORAGE:-}"
if [ -f "$WORKDIR/slurm/neo4j_sidecar.sh" ]; then
    source "$WORKDIR/slurm/neo4j_sidecar.sh"
    neo4j_guard || exit 1
    neo4j_start || exit 1
elif [ "$GRAPH_BACKEND" = "neo4j" ]; then
    echo "[$(date)] FATAL: GRAPH_BACKEND=neo4j but $WORKDIR/slurm/neo4j_sidecar.sh is not deployed."
    exit 1
fi

# ── Early SIGTERM → graceful stop with time to sync ──────
PYTHON_PID=""
TIMED_OUT=0
trap 'echo "[$(date)] SIGTERM — stopping ingest for graceful sync"; TIMED_OUT=1; [ -n "$PYTHON_PID" ] && kill $PYTHON_PID 2>/dev/null' SIGTERM SIGINT

REBUILD_EMBEDDINGS=${REBUILD_EMBEDDINGS:-0}
if [ "$REBUILD_EMBEDDINGS" = "1" ]; then
    echo "[$(date)] REBUILD EMBEDDINGS MODE — no vLLM needed, recomputing vectors from cache..."
else
    echo "[$(date)] Starting ingestion v2 ($STORAGE_SUBDIR, 1x H200)..."
fi

# ── (reembed) Refresh the GraphML snapshot from Neo4j ─────────────────
# REBUILD_EMBEDDINGS reads entities/relations via nx.read_graphml, and its
# freshness guard aborts on a snapshot older than the last Neo4j-backed run.
# Export while the sidecar is up so the rebuild sees the current graph.
if [ "$REBUILD_EMBEDDINGS" = "1" ] && [ -n "${NEO4J_URI:-}" ]; then
    GRAPHML_OUT="$WORKDIR/${STORAGE_SUBDIR:-rag_storage_westbury_qwen3_32b}/graph_chunk_entity_relation.graphml"
    GRAPH_MARKER="$WORKDIR/${STORAGE_SUBDIR:-rag_storage_westbury_qwen3_32b}/.graph_backend"
    # Skip the ~21min re-export when a previous run already wrote a snapshot
    # NEWER than the backend marker — that is exactly the condition the python
    # Fix-graph guard checks, so reusing it is safe and makes restarts cheap.
    if [ -s "$GRAPHML_OUT" ] && [ -f "$GRAPH_MARKER" ] && [ "$GRAPHML_OUT" -nt "$GRAPH_MARKER" ]; then
        echo "[$(date)] [reembed] GraphML already fresh (newer than .graph_backend) — skipping re-export."
        ls -la "$GRAPHML_OUT"
    else
    echo "[$(date)] [reembed] Exporting fresh GraphML from Neo4j -> $GRAPHML_OUT"
    if ! PYTHONPATH="$WORKDIR" python "$WORKDIR/scripts/export_neo4j_graphml.py" --out "$GRAPHML_OUT"; then
        echo "[$(date)] FATAL: GraphML export failed — the rebuild would abort on a stale snapshot."
        exit 1
    fi
    ls -la "$GRAPHML_OUT"
    fi
fi

# ── (reembed) Local multi-GPU embedder fan-out ────────────────────────────
# 12.1M vectors (3.59M entities + 8.10M relations + 445k chunks) is far too many
# for one GPU. The rebuild PROCESS is CPU/RAM-bound (6.9GB GraphML parse + Qdrant
# upserts), so it does not need a GPU of its own: give every GPU in this
# allocation its own embedder server and let pipeline.ingest round-robin across
# them (EMBED_ENDPOINTS). Sharding the rebuild instead would re-parse the graph
# once per shard and multiply a ~100GB RAM footprint by N.
LOCAL_EMBED_SERVERS=${LOCAL_EMBED_SERVERS:-0}
EMBED_SRV_PIDS=""
if [ "$LOCAL_EMBED_SERVERS" -gt 0 ] 2>/dev/null; then
    echo "[$(date)] [reembed] Starting $LOCAL_EMBED_SERVERS local embedder server(s), one per GPU..."
    for i in $(seq 0 $((LOCAL_EMBED_SERVERS - 1))); do
        p=$((18000 + i))
        ( cd "$WORKDIR/scripts" && \
          CUDA_VISIBLE_DEVICES=$i \
          EMBED_MODEL_ID=${EMBED_MODEL_ID:-Qwen/Qwen3-Embedding-8B} \
          EMBED_DEVICE=cuda \
          EMBED_TORCH_DTYPE=${EMBED_TORCH_DTYPE:-bfloat16} \
          EMBED_BATCH=${EMBED_BATCH:-64} \
          python -m uvicorn server:app --host 127.0.0.1 --port $p \
            > "$WORKDIR/logs/embed_srv_${SLURM_JOB_ID}_$i.log" 2>&1 ) &
        EMBED_SRV_PIDS="$EMBED_SRV_PIDS $!"
    done
    EMBED_ENDPOINT=""
    # Poll ALL servers each cycle against ONE global deadline. Polling them
    # sequentially with a per-server timeout silently drops slow loaders: on a
    # contended node (Nibi 18603636) GPU0 and GPU1 each burned the full 15-min
    # per-server wait and were excluded, then came up healthy moments later —
    # the run used 2 of 4 GPUs and went 14x slower than Ror. Never drop a server
    # just because it loaded more slowly than a fixed timer.
    READY=""
    for t in $(seq 1 240); do
        allready=1
        for i in $(seq 0 $((LOCAL_EMBED_SERVERS - 1))); do
            case " $READY " in *" $i "*) continue ;; esac
            p=$((18000 + i))
            if curl -sf "http://127.0.0.1:$p/health" >/dev/null 2>&1; then
                READY="$READY $i"
                echo "[$(date)] [reembed]   GPU $i embedder ready on :$p ($((t * 5))s)"
            else
                allready=0
            fi
        done
        [ $allready -eq 1 ] && break
        sleep 5
    done
    for i in $READY; do
        p=$((18000 + i))
        if [ -z "$EMBED_ENDPOINT" ]; then EMBED_ENDPOINT="http://127.0.0.1:$p"
        else EMBED_ENDPOINT="$EMBED_ENDPOINT,http://127.0.0.1:$p"; fi
    done
    nready=$(echo $READY | wc -w)
    [ "$nready" != "$LOCAL_EMBED_SERVERS" ] && echo "[$(date)] [reembed] WARNING: only $nready/$LOCAL_EMBED_SERVERS embedders registered — throughput will scale down accordingly."
    if [ -z "$EMBED_ENDPOINT" ]; then
        echo "[$(date)] FATAL: no local embedder server became healthy — see $WORKDIR/logs/embed_srv_${SLURM_JOB_ID}_*.log"
        exit 1
    fi
    export EMBED_ENDPOINT
    echo "[$(date)] [reembed] EMBED_ENDPOINT=$EMBED_ENDPOINT"
fi

# ── Optional dedicated embedder: adopt a live registered endpoint ────────
EMBED_ENDPOINTS_DIR="$WORKDIR/${EMBED_ENDPOINTS_SUBDIR:-embed_endpoints}"
EMBED_ENDPOINT="${EMBED_ENDPOINT:-}"
# APPEND remote endpoints even when local servers are already registered —
# gating on -z discarded job_westbury_embed.slurm GPUs whenever
# LOCAL_EMBED_SERVERS was set, silently capping a planned 4-local+N-remote
# fan-out at 4. Local list first, remotes appended; round-robin spreads load.
if ls "$EMBED_ENDPOINTS_DIR"/*.txt >/dev/null 2>&1; then
    for f in "$EMBED_ENDPOINTS_DIR"/*.txt; do
        ep=$(cat "$f")
        if [ -n "$ep" ] && curl -sf "$ep/health" >/dev/null 2>&1; then
            # Collect ALL healthy endpoints (comma-separated); pipeline.ingest
            # round-robins across them so N embedder GPUs share the load.
            if [ -z "$EMBED_ENDPOINT" ]; then EMBED_ENDPOINT="$ep"; else EMBED_ENDPOINT="$EMBED_ENDPOINT,$ep"; fi
        fi
    done
    [ -n "$EMBED_ENDPOINT" ] && echo "[$(date)] Dedicated embedder(s) adopted: $EMBED_ENDPOINT"
fi
[ -z "$EMBED_ENDPOINT" ] && echo "[$(date)] No dedicated embedder — embedding in-process on this job's GPU."

WORKDIR=$WORKDIR \
N_VLLM=${N_VLLM:-1} \
ENDPOINTS_SUBDIR=${ENDPOINTS_SUBDIR:-vllm_endpoints_westbury_qwen3_32b} \
PAPERS_SUBDIR=${PAPERS_SUBDIR:-papers} \
STORAGE_SUBDIR=${STORAGE_SUBDIR:-rag_storage_full} \
LLM_MODEL=${LLM_MODEL:-Qwen/Qwen3.6-35B-A3B} \
PARALLEL_DOCS=${PARALLEL_DOCS:-24} \
LLM_MAX_ASYNC=${LLM_MAX_ASYNC:-48} \
CONTEXT_MAX_ASYNC=${CONTEXT_MAX_ASYNC:-48} \
MAX_DOC_TOKENS=${MAX_DOC_TOKENS:-20000} \
EMBED_FUNC_MAX_ASYNC=${EMBED_FUNC_MAX_ASYNC:-2} \
EMBED_BATCH=${EMBED_BATCH:-64} \
EMBEDDING_BATCH_NUM=${EMBEDDING_BATCH_NUM:-128} \
EMBED_ENDPOINT="$EMBED_ENDPOINT" \
MAX_PARALLEL_INSERT=${MAX_PARALLEL_INSERT:-24} \
QDRANT_URL=$QDRANT_URL \
GRAPH_STORAGE="${GRAPH_STORAGE:-}" \
KV_FLUSH_INTERVAL=${KV_FLUSH_INTERVAL:-300} \
LLM_MAX_TOKENS=${LLM_MAX_TOKENS:-4096} \
CONTEXT_MAX_TOKENS=${CONTEXT_MAX_TOKENS:-300} \
LLM_TEMPERATURE=${LLM_TEMPERATURE:-0.0} \
LLM_SEED=${LLM_SEED:-42} \
CONTEXT_CACHE=${CONTEXT_CACHE:-1} \
CONTEXT_WARM_FIRST=${CONTEXT_WARM_FIRST:-1} \
CONTEXT_AFFINITY=${CONTEXT_AFFINITY:-1} \
STREAM_OVERLAP=${STREAM_OVERLAP:-1} \
ENDPOINT_REFRESH_S=${ENDPOINT_REFRESH_S:-300} \
MAX_GLEANING=${MAX_GLEANING:-1} \
FORCE_LLM_SUMMARY_ON_MERGE=${FORCE_LLM_SUMMARY_ON_MERGE:-100} \
SUMMARY_MAX_TOKENS=${SUMMARY_MAX_TOKENS:-1200} \
SUMMARY_CONTEXT_SIZE=${SUMMARY_CONTEXT_SIZE:-12000} \
REBUILD_EMBEDDINGS=$REBUILD_EMBEDDINGS \
CHUNK_TARGET_TOKENS=${CHUNK_TARGET_TOKENS:-512} \
CHUNK_MAX_TOKENS=${CHUNK_MAX_TOKENS:-640} \
CHUNK_MIN_TOKENS=${CHUNK_MIN_TOKENS:-192} \
CHUNK_OVERLAP_TOKENS=${CHUNK_OVERLAP_TOKENS:-51} \
CHUNK_EXCLUDE_REFS=${CHUNK_EXCLUDE_REFS:-1} \
CHUNK_EXCLUDE_ACK=${CHUNK_EXCLUDE_ACK:-1} \
  PYTHONPATH="$WORKDIR" python -m pipeline.ingest &
PYTHON_PID=$!
if [ -n "${NEO4J_PID:-}" ]; then
    neo4j_watchdog "$PYTHON_PID" &
    NEO4J_WATCHDOG_PID=$!
fi
wait $PYTHON_PID
EXIT_CODE=$?
if [ $EXIT_CODE -gt 128 ] && kill -0 $PYTHON_PID 2>/dev/null; then
    wait $PYTHON_PID
    EXIT_CODE=$?
fi
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

# ── Stop the Neo4j sidecar first (checkpoint must not race the Qdrant sync) ──
if [ -n "${NEO4J_WATCHDOG_PID:-}" ]; then
    kill $NEO4J_WATCHDOG_PID 2>/dev/null
    wait $NEO4J_WATCHDOG_PID 2>/dev/null
fi
if [ -n "$EMBED_SRV_PIDS" ]; then
    echo "[$(date)] Stopping local embedder server(s):$EMBED_SRV_PIDS"
    kill $EMBED_SRV_PIDS 2>/dev/null
    wait $EMBED_SRV_PIDS 2>/dev/null
fi
type neo4j_stop >/dev/null 2>&1 && neo4j_stop

# ── Stop Qdrant and sync data back to persistent scratch ─────────────
if [ -n "$QDRANT_PID" ]; then
    FINAL_COUNTS=""
    if kill -0 $QDRANT_PID 2>/dev/null; then
        FINAL_COUNTS=$(qdrant_counts)
        echo "[$(date)] [QDRANT-SYNC] points at shutdown:$FINAL_COUNTS"
    fi
    kill $QDRANT_PID 2>/dev/null
    wait $QDRANT_PID 2>/dev/null
    echo "[$(date)] Qdrant sidecar stopped."

    echo "[$(date)] Syncing Qdrant data back to persistent scratch..."
    if rsync -a --delete "$QDRANT_LOCAL/" "$QDRANT_LUSTRE/"; then
        echo "[$(date)] Qdrant sync complete ($(du -sh "$QDRANT_LUSTRE" | cut -f1))."
        [ -n "$FINAL_COUNTS" ] && echo "$FINAL_COUNTS" > "$QDRANT_LUSTRE/.last_sync_counts"
    else
        echo "[$(date)] ERROR: [QDRANT-SYNC] rsync-back FAILED — vector delta NOT persisted."
    fi
fi

exit $EXIT_CODE
