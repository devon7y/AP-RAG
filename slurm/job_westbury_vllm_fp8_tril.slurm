#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_vllm_fp8
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_vllm_fp8_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_vllm_fp8_%j.err
#SBATCH --partition=compute_h200
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --gpus-per-node=h200:1
# Trillium bundles resources per GPU: 1 H200 auto-grants ~24 CPUs + ~386 GiB host RAM.
# --mem and --cpus-per-task are REJECTED by Trillium's submit filter; do not add them.

# FP8 vLLM serve — Qwen3.6-35B-A3B-FP8 on ONE H200 (TP=1), Trillium trig0063.
# H200 is Hopper (native FP8, 141GB VRAM) -> same recipe as the Fir/Nibi H100 legs,
# NOT the Narval A100 build (no Marlin, no --max-num-seqs cap, no expandable_segments).
# Served under the base name Qwen/Qwen3.6-35B-A3B via --served-model-name so the ingest
# AND the LLM_MODEL-salted response cache are unchanged vs the H100 legs (FP8 ≈ BF16).
# CRITICAL env (do NOT drop): VLLM_USE_DEEP_GEMM=0 (DeepGEMM nvcc JIT fails on Alliance
# compute nodes -> Triton block-FP8 handles it); VLLM_SKIP_FLASHINFER_AUTOTUNE=1 (autotune
# is a ~30min stall on cold cache); no --enforce-eager (TP=1 has no shm hang -> CUDA graphs on).

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_westbury_qwen3_32b
LOAD_MODEL="Qwen/Qwen3.6-35B-A3B-FP8"
SERVE_NAME="Qwen/Qwen3.6-35B-A3B"
MODEL_DIR="models--Qwen--Qwen3.6-35B-A3B-FP8"

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export FLASHINFER_DISABLE_VERSION_CHECK=1
export VLLM_ENGINE_READY_TIMEOUT_S=1800
export VLLM_USE_DEEP_GEMM=0
export VLLM_SKIP_FLASHINFER_AUTOTUNE=1
mkdir -p "$ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/cache/triton" "$WORKDIR/cache/flashinfer"

module load python/3.11 gcc/12.3 cuda/12.6 opencv
source "$VENV_DIR/bin/activate" || { echo "venv missing"; exit 1; }

# Stage FP8 weights on node-local NVMe (fast load off Lustre)
echo "[$(date)] Copying FP8 weights to local NVMe..."
mkdir -p "$SLURM_TMPDIR/hf_cache/hub"
cp -a "$WORKDIR/hf_cache/hub/$MODEL_DIR" "$SLURM_TMPDIR/hf_cache/hub/"
export HF_HOME="$SLURM_TMPDIR/hf_cache"
ls "$SLURM_TMPDIR/hf_cache/hub/$MODEL_DIR/snapshots/"*/config.json >/dev/null 2>&1 \
  || { echo "ERROR: FP8 snapshot incomplete after copy"; exit 1; }

if [ -n "$SLURM_TMPDIR" ]; then
  mkdir -p "$SLURM_TMPDIR/triton_cache" "$SLURM_TMPDIR/flashinfer_cache"
  rsync -a "$WORKDIR/cache/triton/" "$SLURM_TMPDIR/triton_cache/" 2>/dev/null || true
  rsync -a "$WORKDIR/cache/flashinfer/" "$SLURM_TMPDIR/flashinfer_cache/" 2>/dev/null || true
  export TRITON_CACHE_DIR="$SLURM_TMPDIR/triton_cache"
  export FLASHINFER_CACHE_DIR="$SLURM_TMPDIR/flashinfer_cache"
fi

# Trillium (SciNet) mounts $HOME READ-ONLY on compute nodes. FlashInfer/torch-inductor
# default their caches to ~/.cache/* -> PermissionError and engine-init crash. Redirect
# HOME (and the explicit flashinfer workspace base) to node-local NVMe. Must be set
# BEFORE vllm/flashinfer import. This is the Trillium-specific fix the H100 legs never need.
export HOME="$SLURM_TMPDIR"
export FLASHINFER_WORKSPACE_BASE="$SLURM_TMPDIR"
export TORCHINDUCTOR_CACHE_DIR="$SLURM_TMPDIR/inductor"
mkdir -p "$SLURM_TMPDIR/inductor"

VLLM_MAX_RESTARTS=${VLLM_MAX_RESTARTS:-3}
RESTARTS=0; VLLM_PID=""
cleanup() { [ -n "$VLLM_PID" ] && kill $VLLM_PID 2>/dev/null; wait $VLLM_PID 2>/dev/null; rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"; echo "[$(date)] cleanup done"; }
trap cleanup EXIT SIGTERM

while :; do
  PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0',0)); print(s.getsockname()[1]); s.close()")
  ENGINE_LOG="$WORKDIR/logs/vllm_fp8_engine_${SLURM_JOB_ID}_r${RESTARTS}.log"
  echo "[$(date)] Starting $LOAD_MODEL (FP8, TP=1) served as '$SERVE_NAME' on port $PORT (engine log: $ENGINE_LOG)"
  vllm serve "$LOAD_MODEL" \
    --served-model-name "$SERVE_NAME" \
    --host 0.0.0.0 --port $PORT \
    --tensor-parallel-size 1 \
    --max-model-len 40000 \
    --gpu-memory-utilization 0.90 \
    --enable-prefix-caching \
    --default-chat-template-kwargs '{"enable_thinking": false}' \
    >> "$ENGINE_LOG" 2>&1 &
  VLLM_PID=$!

  STARTED=0
  echo "[$(date)] Waiting for vLLM (up to 60 min)..."
  for i in $(seq 1 360); do
    curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && { echo "[$(date)] vLLM ready after $((i*10))s"; STARTED=1; break; }
    kill -0 $VLLM_PID 2>/dev/null || { echo "[$(date)] ERROR: vLLM exited during startup (see $ENGINE_LOG)"; break; }
    sleep 10
  done

  if [ "$STARTED" = "1" ]; then
    for c in 1 4 8; do
      PIDS=""
      for j in $(seq 1 $c); do
        curl -sf -m 180 "http://localhost:$PORT/v1/chat/completions" -H 'Content-Type: application/json' \
          -d '{"model":"'"$SERVE_NAME"'","messages":[{"role":"user","content":"Count from 1 to 60, comma separated."}],"max_tokens":256,"temperature":0}' >/dev/null 2>&1 &
        PIDS="$PIDS $!"
      done
      wait $PIDS
    done
    echo "http://$(hostname):$PORT/v1" > "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
    echo "[$(date)] Endpoint registered: http://$(hostname):$PORT/v1"
    wait $VLLM_PID
    VLLM_EXIT=$?
    rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
    echo "[$(date)] vLLM (incarnation $RESTARTS) exited code $VLLM_EXIT."
  else
    wait $VLLM_PID 2>/dev/null
  fi

  RESTARTS=$((RESTARTS + 1))
  [ "$RESTARTS" -gt "$VLLM_MAX_RESTARTS" ] && { echo "[$(date)] Exceeded VLLM_MAX_RESTARTS — giving up."; exit 1; }
  echo "[$(date)] Restarting vLLM in-place (attempt $RESTARTS/$VLLM_MAX_RESTARTS)..."
done
