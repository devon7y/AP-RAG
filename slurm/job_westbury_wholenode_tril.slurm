#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_wholenode
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_wholenode_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_wholenode_%j.err
#SBATCH --partition=compute_full_node
#SBATCH --gpus-per-node=h100:4
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --signal=B:TERM@300
#
# SELF-CONTAINED whole-node ingest: 3 FP8 vLLMs + the ingest (embedder) inside ONE
# exclusive allocation. Replaces the split "N vLLM jobs + 1 ingest job" layout,
# which kept mis-timing: 1-GPU vLLMs scheduled in ~1.5h while the whole-node ingest
# queued ~7h, so the vLLMs expired hours before the ingest ever started.
#
# GPU map (4x H100 80GB): 0,1,2 = vLLM (each --gpu-memory-utilization 0.90)
#                         3     = ingest embedder (Qwen3-Embedding-8B, ~16GB)
# A 4th vLLM would leave no GPU for the embedder, hence 3.
#
# Whole node also solves the memory ceiling: 745 GiB here vs 188 GiB for a 1-GPU
# job — the ingest peaked at 187.5 GiB even with REDUCED settings, so full
# canonical concurrency only fits on a whole node.
#
# Trillium rules baked in: no --mem/--cpus (auto-bundled), --gpus-per-node (not
# --gpus), whole-node jobs MUST use the compute_full_node partition, and $HOME is
# read-only on compute nodes (redirected below).

export WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril

export STORAGE_SUBDIR="${STORAGE_SUBDIR:-rag_storage_full}"
QDRANT_SUBDIR="${QDRANT_SUBDIR:-qdrant_storage_aprag}"
ENDPOINTS_DIR="$WORKDIR/${ENDPOINTS_SUBDIR:-vllm_endpoints_westbury_qwen3_32b}"

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export BNB_CUDA_VERSION=126
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export PYTHONFAULTHANDLER=1     # native crashes print a Python stack instead of a bare SIGSEGV

mkdir -p "$WORKDIR/logs" "$WORKDIR/$STORAGE_SUBDIR" "$WORKDIR/cache" \
         "$WORKDIR/cache/flashinfer" "$WORKDIR/cache/triton" "$ENDPOINTS_DIR"

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR"; exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

# Trillium mounts $HOME READ-ONLY on compute nodes -> flashinfer/torch-inductor
# caches to ~/.cache/* fail with PermissionError. Redirect AFTER module load +
# venv activate (which need the real HOME). All persistent data uses $WORKDIR.
export HOME="$SLURM_TMPDIR"
export FLASHINFER_WORKSPACE_BASE="$SLURM_TMPDIR"
export TORCHINDUCTOR_CACHE_DIR="$SLURM_TMPDIR/inductor"
mkdir -p "$SLURM_TMPDIR/inductor"

# ── vLLM fleet: 3 FP8 servers on GPUs 0,1,2 ──────────────────────────────────
N_VLLM_LOCAL=${N_VLLM_LOCAL:-3}
LOAD_MODEL="Qwen/Qwen3.6-35B-A3B-FP8"
SERVE_NAME="Qwen/Qwen3.6-35B-A3B"
MODEL_DIR="models--Qwen--Qwen3.6-35B-A3B-FP8"
VLLM_PIDS=""

# Stage the FP8 weights on node-local NVMe ONCE (35GB), shared by all 3 servers.
echo "[$(date)] Staging FP8 weights to node-local NVMe (once, shared)…"
mkdir -p "$SLURM_TMPDIR/hf_cache/hub"
cp -a "$WORKDIR/hf_cache/hub/$MODEL_DIR" "$SLURM_TMPDIR/hf_cache/hub/" || { echo "ERROR: weight copy failed"; exit 1; }
ls "$SLURM_TMPDIR/hf_cache/hub/$MODEL_DIR/snapshots/"*/config.json >/dev/null 2>&1 \
  || { echo "ERROR: FP8 snapshot incomplete after copy"; exit 1; }
echo "[$(date)] Weights staged."

start_vllm() {   # $1 = GPU index
  local gpu=$1
  local port ep_file engine_log
  port=$(python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0',0)); print(s.getsockname()[1]); s.close()")
  ep_file="$ENDPOINTS_DIR/${SLURM_JOB_ID}_gpu${gpu}.txt"
  engine_log="$WORKDIR/logs/vllm_wholenode_${SLURM_JOB_ID}_gpu${gpu}.log"
  (
    export CUDA_VISIBLE_DEVICES="$gpu"
    export HF_HOME="$SLURM_TMPDIR/hf_cache"          # staged copy (vLLM only)
    export HOME="$SLURM_TMPDIR/vllm${gpu}"           # per-server caches: no JIT races
    export FLASHINFER_WORKSPACE_BASE="$SLURM_TMPDIR/vllm${gpu}"
    export TRITON_CACHE_DIR="$SLURM_TMPDIR/vllm${gpu}/triton"
    export FLASHINFER_CACHE_DIR="$SLURM_TMPDIR/vllm${gpu}/flashinfer"
    export FLASHINFER_DISABLE_VERSION_CHECK=1
    export VLLM_ENGINE_READY_TIMEOUT_S=1800
    export VLLM_USE_DEEP_GEMM=0            # DeepGEMM nvcc JIT fails on Alliance compute nodes
    export VLLM_SKIP_FLASHINFER_AUTOTUNE=1 # autotune is a ~30min stall on a cold cache
    mkdir -p "$HOME/triton" "$HOME/flashinfer"
    echo "[$(date)] [gpu$gpu] starting vLLM on port $port (log: $engine_log)"
    # No --enforce-eager: TP=1 has no shm hang, CUDA graphs are faster.
    vllm serve "$LOAD_MODEL" \
      --served-model-name "$SERVE_NAME" \
      --host 0.0.0.0 --port "$port" \
      --tensor-parallel-size 1 \
      --max-model-len 40000 \
      --gpu-memory-utilization 0.90 \
      --enable-prefix-caching \
      --default-chat-template-kwargs '{"enable_thinking": false}' \
      >> "$engine_log" 2>&1 &
    local vpid=$!
    # Register only once healthy; the ingest deletes files whose job left squeue.
    for _ in $(seq 1 360); do
      if curl -sf "http://localhost:$port/health" >/dev/null 2>&1; then
        echo "http://$(hostname):$port/v1" > "$ep_file"
        echo "[$(date)] [gpu$gpu] READY -> $(cat "$ep_file")"
        break
      fi
      kill -0 $vpid 2>/dev/null || { echo "[$(date)] [gpu$gpu] ERROR: vLLM died during startup (see $engine_log)"; break; }
      sleep 10
    done
    wait $vpid
    rm -f "$ep_file"
  ) &
  VLLM_PIDS="$VLLM_PIDS $!"
}

for g in $(seq 0 $((N_VLLM_LOCAL - 1))); do start_vllm "$g"; done
echo "[$(date)] Launched $N_VLLM_LOCAL vLLM server(s) on GPUs 0..$((N_VLLM_LOCAL - 1)); ingest embedder will use GPU $N_VLLM_LOCAL."

echo "[$(date)] Current doc status:"
python3 - <<'PYEOF'
import json, os
from pathlib import Path
storage = Path(os.environ["WORKDIR"]) / os.environ["STORAGE_SUBDIR"]
status_path = storage / "kv_store_doc_status.json"
if not status_path.exists():
    print("  No doc status file found (fresh run)."); raise SystemExit
status = json.loads(status_path.read_text())
counts = {}
for k, v in status.items():
    if k.startswith("doc-"):
        counts[v.get("status", "unknown")] = counts.get(v.get("status", "unknown"), 0) + 1
print(f"  Total entries: {sum(counts.values())}")
for s in ("processed", "processing", "pending", "failed"):
    print(f"    {s}: {counts.get(s, 0)}")
PYEOF

# ── Qdrant sidecar (node-local NVMe storage; NOT Lustre/NFS) ─────────────────
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
        [ $i -eq 72 ] && { echo "[$(date)] WARNING: Qdrant did not start; falling back to NanoVectorDB."; kill $QDRANT_PID 2>/dev/null; QDRANT_PID=""; }
        sleep 5
    done
else
    echo "[$(date)] No Qdrant SIF at $QDRANT_SIF — using NanoVectorDB."
fi

QDRANT_URL=""
if [ -n "$QDRANT_PID" ] && kill -0 $QDRANT_PID 2>/dev/null; then
    QDRANT_URL="http://localhost:6333"
    echo "[$(date)] [QDRANT-SEED] points:$(qdrant_counts)"
fi

# ── Neo4j sidecar (exports GRAPH_STORAGE + NEO4J_URI/USERNAME/PASSWORD) ──────
GRAPH_BACKEND=${GRAPH_BACKEND:-networkx}
GRAPH_STORAGE="${GRAPH_STORAGE:-}"
if [ -f "$WORKDIR/slurm/neo4j_sidecar.sh" ]; then
    source "$WORKDIR/slurm/neo4j_sidecar.sh"
    neo4j_guard || exit 1
    neo4j_start || exit 1
elif [ "$GRAPH_BACKEND" = "neo4j" ]; then
    echo "[$(date)] FATAL: GRAPH_BACKEND=neo4j but slurm/neo4j_sidecar.sh is missing."; exit 1
fi

# ── Graceful stop on the @300 SIGTERM: flush the ingest, then the sidecars ───
PYTHON_PID=""
trap 'echo "[$(date)] SIGTERM — stopping ingest for graceful sync"; [ -n "$PYTHON_PID" ] && kill $PYTHON_PID 2>/dev/null' SIGTERM SIGINT

REBUILD_EMBEDDINGS=${REBUILD_EMBEDDINGS:-0}
echo "[$(date)] Starting ingestion v2 ($STORAGE_SUBDIR, whole node: ${N_VLLM_LOCAL}x vLLM + embedder on GPU $N_VLLM_LOCAL)…"

# Ingest embedder gets the one GPU the vLLMs did not take.
CUDA_VISIBLE_DEVICES=$N_VLLM_LOCAL \
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
    wait $PYTHON_PID; EXIT_CODE=$?
fi
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

# ── Shut down: vLLMs first (they are pure compute), then Neo4j, then Qdrant ──
echo "[$(date)] Stopping vLLM fleet…"
rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}_gpu"*.txt
pkill -P $$ -f "vllm serve" 2>/dev/null
for p in $VLLM_PIDS; do kill $p 2>/dev/null; done

if [ -n "${NEO4J_WATCHDOG_PID:-}" ]; then
    kill $NEO4J_WATCHDOG_PID 2>/dev/null; wait $NEO4J_WATCHDOG_PID 2>/dev/null
fi
type neo4j_stop >/dev/null 2>&1 && neo4j_stop

if [ -n "$QDRANT_PID" ]; then
    FINAL_COUNTS=""
    kill -0 $QDRANT_PID 2>/dev/null && { FINAL_COUNTS=$(qdrant_counts); echo "[$(date)] [QDRANT-SYNC] points at shutdown:$FINAL_COUNTS"; }
    kill $QDRANT_PID 2>/dev/null; wait $QDRANT_PID 2>/dev/null
    echo "[$(date)] Syncing Qdrant back to persistent scratch…"
    if rsync -a --delete "$QDRANT_LOCAL/" "$QDRANT_LUSTRE/"; then
        echo "[$(date)] Qdrant sync complete ($(du -sh "$QDRANT_LUSTRE" | cut -f1))."
        [ -n "$FINAL_COUNTS" ] && echo "$FINAL_COUNTS" > "$QDRANT_LUSTRE/.last_sync_counts"
    else
        echo "[$(date)] ERROR: [QDRANT-SYNC] rsync-back FAILED — vector delta NOT persisted."
    fi
fi

exit $EXIT_CODE
