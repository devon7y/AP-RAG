#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_vllm
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --partition=compute
#SBATCH --gpus-per-node=h100:2

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_westbury_qwen3_32b
PORT=8001

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export FLASHINFER_DISABLE_VERSION_CHECK=1
export MPLCONFIGDIR=$WORKDIR/cache/matplotlib
export HOME=$WORKDIR/cache/home
export VLLM_ENGINE_READY_TIMEOUT_S=1800

mkdir -p "$ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env_tril.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

MODEL_PATH=$(python3 -c "
from pathlib import Path
hub = Path('$WORKDIR/hf_cache/hub/models--Qwen--Qwen3.6-35B-A3B')
commit = (hub / 'refs/main').read_text().strip()
print(hub / 'snapshots' / commit)
")
echo "[$(date)] Starting Qwen/Qwen3.6-35B-A3B (BF16, MoE) on 2× H100 (TP=2, 40K context, gpu-util 0.90)..."
echo "[$(date)] Model path: $MODEL_PATH"
# ── Node-local JIT caches + hang hardening (docs/VLLM_TP_CRASH_DEBUG.md) ──────
# Triton/FlashInfer JIT-compile the GDN/linear-attention decode kernels lazily
# DURING serving, and the shared caches above live on network storage — file
# locks + renames there stall or deadlock under concurrent compilation (2 TP
# ranks x N vLLM jobs writing one dir), a prime trigger for the mid-decode TP
# hang. Seed a node-local cache from the shared one (warm start), then keep ALL
# JIT writes on fast local disk. VLLM_LOCAL_JIT_CACHE=0 restores the old paths.
if [ "${VLLM_LOCAL_JIT_CACHE:-1}" = "1" ] && [ -n "$SLURM_TMPDIR" ]; then
  mkdir -p "$SLURM_TMPDIR/triton_cache" "$SLURM_TMPDIR/flashinfer_cache"
  rsync -a "$TRITON_CACHE_DIR/" "$SLURM_TMPDIR/triton_cache/" 2>/dev/null || true
  rsync -a "$FLASHINFER_CACHE_DIR/" "$SLURM_TMPDIR/flashinfer_cache/" 2>/dev/null || true
  export TRITON_CACHE_DIR="$SLURM_TMPDIR/triton_cache"
  export FLASHINFER_CACHE_DIR="$SLURM_TMPDIR/flashinfer_cache"
  echo "[$(date)] JIT caches on node-local disk (seeded from shared): $TRITON_CACHE_DIR"
fi
# - EXECUTE_MODEL RPC timeout 300s -> 1200s: a finite worker stall (e.g. a slow
#   mid-serve JIT compile) becomes a latency blip instead of engine death. True
#   deadlocks still die - and now leave py-spy stacks via the watchdog below.
# - Skip FlashInfer autotune: no mid-serve tuning/JIT churn; the heuristics path
#   is marginally slower but stable (autotune + TP + eager is a fragile combo).
export VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS=${VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS:-1200}
export VLLM_SKIP_FLASHINFER_AUTOTUNE=${VLLM_SKIP_FLASHINFER_AUTOTUNE:-1}

# ── P3: stability workarounds, parametrized (docs/INGEST_EFFICIENCY_OPEN_PROBLEMS.md)
# --enforce-eager costs ~10-20% throughput but stops the TP=2 shm-broadcast
# TimeoutError (mid-run recompile stall; crashed at ~2h50m). To A/B the recovery,
# submit with --export=ALL,VLLM_ENFORCE_EAGER=0 and soak >=4h before trusting.
# VLLM_KV_CACHE_DTYPE=fp8 ~doubles KV capacity (more 20k-token context prefixes
# stay cached -> fewer prefix evictions) at negligible quality cost - worth an A/B.
VLLM_ENFORCE_EAGER=${VLLM_ENFORCE_EAGER:-1}
VLLM_KV_CACHE_DTYPE=${VLLM_KV_CACHE_DTYPE:-auto}
VLLM_EXTRA_ARGS=${VLLM_EXTRA_ARGS:-}
STABILITY_FLAGS=""
if [ "$VLLM_ENFORCE_EAGER" = "1" ]; then
  STABILITY_FLAGS="--enforce-eager --disable-custom-all-reduce"
fi
KV_DTYPE_FLAGS=""
if [ "$VLLM_KV_CACHE_DTYPE" != "auto" ]; then
  KV_DTYPE_FLAGS="--kv-cache-dtype $VLLM_KV_CACHE_DTYPE"
fi

# ── Supervised serve: hang watchdog + auto-diagnostics + in-job restart ────────
# The TP=2 engine intermittently hangs mid-decode (a worker rank stops responding
# -> shm ring fills -> "RPC call to sample_tokens timed out" -> engine death).
# Evidence + root-cause work: docs/VLLM_TP_CRASH_DEBUG.md. This supervisor:
#   1) redirects the engine to its own log and watches it; on the FIRST
#      shm-broadcast stall warning it captures py-spy stacks of EVERY vLLM
#      process (EngineCore + TP workers) + nvidia-smi into
#      $WORKDIR/logs/vllm_hang_diag_<jobid>_rN.txt - the stack that names the
#      hung kernel is the single most valuable missing evidence;
#   2) if the engine dies, it deregisters the endpoint, restarts vLLM IN-PLACE
#      (no SLURM resubmission - job chains stay forbidden), pre-warms, and
#      re-registers. The ingest's failover + periodic endpoint re-discovery
#      (ENDPOINT_REFRESH_S) adopt the reincarnation automatically.
VLLM_MAX_RESTARTS=${VLLM_MAX_RESTARTS:-3}
VLLM_PREWARM=${VLLM_PREWARM:-1}
MODEL_NAME="Qwen/Qwen3.6-35B-A3B"
VLLM_PID=""
RESTARTS=0

descendants() {  # all descendant PIDs of $1 (vllm CLI -> EngineCore -> TP workers)
  local p
  for p in $(pgrep -P "$1" 2>/dev/null); do echo "$p"; descendants "$p"; done
}

capture_diag() {
  local reason=$1
  local diag="$WORKDIR/logs/vllm_hang_diag_${SLURM_JOB_ID}_r${RESTARTS}.txt"
  {
    echo "================ $(date) - $reason (incarnation $RESTARTS, port $PORT) ================"
    echo "--- nvidia-smi ---"
    nvidia-smi 2>&1
    local pid cmd
    for pid in $VLLM_PID $(descendants "$VLLM_PID"); do
      cmd=$(ps -o args= -p "$pid" 2>/dev/null | head -c 160)
      [ -n "$cmd" ] || continue
      echo "--- py-spy dump pid=$pid: $cmd ---"
      if command -v py-spy >/dev/null 2>&1; then
        py-spy dump --pid "$pid" 2>&1 || echo "(py-spy failed on $pid)"
      else
        echo "(py-spy not installed - rerun the setup job, it now installs it)"
      fi
    done
    echo "--- last 80 engine log lines ($ENGINE_LOG) ---"
    tail -n 80 "$ENGINE_LOG" 2>/dev/null
  } >> "$diag" 2>&1
  echo "[$(date)] Diagnostics captured -> $diag"
}

cleanup() {
  [ -n "$VLLM_PID" ] && kill $VLLM_PID 2>/dev/null
  wait $VLLM_PID 2>/dev/null
  rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
  echo "[$(date)] Cleanup done."
}
trap cleanup EXIT SIGTERM

prewarm() {
  [ "$VLLM_PREWARM" = "1" ] || return 0
  echo "[$(date)] Pre-warming decode kernels (forces the lazy Triton JIT now, not mid-serve)..."
  local conc i pids
  for conc in 1 4 8; do
    pids=""
    for i in $(seq 1 "$conc"); do
      curl -sf -m 180 "http://localhost:$PORT/v1/chat/completions" \
        -H 'Content-Type: application/json' \
        -d '{"model":"'"$MODEL_NAME"'","messages":[{"role":"user","content":"/no_think\nCount from 1 to 60, comma separated."}],"max_tokens":256,"temperature":0}' \
        > /dev/null 2>&1 &
      pids="$pids $!"
    done
    wait $pids 2>/dev/null
  done
  echo "[$(date)] Pre-warm complete."
}

while :; do
  # First incarnation keeps the historical fixed port; restarts pick a fresh one
  # (the old port can sit in TIME_WAIT after a crash).
  if [ "$RESTARTS" -gt 0 ]; then
    PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0', 0)); print(s.getsockname()[1]); s.close()")
  fi
  ENGINE_LOG="$WORKDIR/logs/vllm_engine_${SLURM_JOB_ID}_r${RESTARTS}.log"
  echo "[$(date)] Starting $MODEL_NAME (BF16, MoE, TP=2) on port $PORT - engine log: $ENGINE_LOG"
  vllm serve "$MODEL_PATH" \
    --host 0.0.0.0 \
    --port $PORT \
    --served-model-name Qwen/Qwen3.6-35B-A3B \
    --tensor-parallel-size 2 \
    $STABILITY_FLAGS \
    --max-model-len 40000 \
    --gpu-memory-utilization 0.90 \
    --dtype bfloat16 \
    --enable-prefix-caching \
    $KV_DTYPE_FLAGS $VLLM_EXTRA_ARGS \
    --default-chat-template-kwargs '{"enable_thinking": false}' \
    >> "$ENGINE_LOG" 2>&1 &
  VLLM_PID=$!

  echo "[$(date)] Waiting for vLLM server (up to 180 min)..."
  STARTED=0
  for i in $(seq 1 1080); do
    if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
      echo "[$(date)] vLLM ready after $((i * 10))s"
      STARTED=1
      break
    fi
    if ! kill -0 "$VLLM_PID" 2>/dev/null; then
      echo "[$(date)] ERROR: vLLM exited during startup (see $ENGINE_LOG)."
      break
    fi
    if [ $i -eq 1080 ]; then
      echo "[$(date)] ERROR: vLLM did not start within 180 minutes"
      kill $VLLM_PID 2>/dev/null
    fi
    sleep 10
  done

  if [ "$STARTED" = "1" ]; then
    prewarm
    echo "http://$(hostname):$PORT/v1" > "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
    echo "[$(date)] Endpoint registered: http://$(hostname):$PORT/v1"

    # Watchdog: liveness + first-stall diagnostics. The shm warning starts ~5-20
    # min BEFORE the fatal RPC timeout - that window is when the worker stack
    # capture is possible, so grab it on the first sighting.
    DIAG_DONE=0
    while kill -0 "$VLLM_PID" 2>/dev/null; do
      sleep 30
      if [ "$DIAG_DONE" = "0" ]; then
        WARNS=$(grep -c "No available shared memory broadcast block" "$ENGINE_LOG" 2>/dev/null)
        if [ "${WARNS:-0}" -gt 0 ]; then
          DIAG_DONE=1
          capture_diag "shm-broadcast stall detected (worker likely hung; engine may still recover)"
        fi
      fi
    done
    wait $VLLM_PID 2>/dev/null
    VLLM_EXIT=$?
    rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
    echo "[$(date)] vLLM (incarnation $RESTARTS) died with exit code $VLLM_EXIT."
    [ "$DIAG_DONE" = "0" ] && capture_diag "engine death post-mortem (no stall warning seen)"
  else
    wait $VLLM_PID 2>/dev/null
  fi

  RESTARTS=$((RESTARTS + 1))
  if [ "$RESTARTS" -gt "$VLLM_MAX_RESTARTS" ]; then
    echo "[$(date)] Exceeded VLLM_MAX_RESTARTS=$VLLM_MAX_RESTARTS - giving up."
    exit 1
  fi
  echo "[$(date)] Restarting vLLM in-place (attempt $RESTARTS/$VLLM_MAX_RESTARTS)..."
done
