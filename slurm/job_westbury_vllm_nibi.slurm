#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_vllm
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=24
#SBATCH --mem=128G
#SBATCH --gpus=h100:2

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_westbury_qwen3_32b
# PORT is assigned dynamically (free ephemeral port) after the venv is active,
# to avoid collisions with other jobs sharing this GPU node.

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export FLASHINFER_DISABLE_VERSION_CHECK=1
export VLLM_ENGINE_READY_TIMEOUT_S=1800

mkdir -p "$ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env_nibi.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

# Nibi uses all-SSD VAST storage — no NVMe copy needed
# Model loads directly from scratch at full speed
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0', 0)); print(s.getsockname()[1]); s.close()")
echo "[$(date)] Selected free port $PORT for vLLM (avoids shared-node collisions)."
echo "[$(date)] Starting Qwen/Qwen3.6-35B-A3B (BF16, MoE) on 2× H100 (TP=2, 40K context, gpu-util 0.90)..."
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

vllm serve Qwen/Qwen3.6-35B-A3B \
  --host 0.0.0.0 \
  --port $PORT \
  --tensor-parallel-size 2 \
  $STABILITY_FLAGS \
  --max-model-len 40000 \
  --gpu-memory-utilization 0.90 \
  --dtype bfloat16 \
  --enable-prefix-caching \
  $KV_DTYPE_FLAGS $VLLM_EXTRA_ARGS \
  --default-chat-template-kwargs '{"enable_thinking": false}' &
VLLM_PID=$!

cleanup() {
  kill $VLLM_PID 2>/dev/null
  wait $VLLM_PID 2>/dev/null
  rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
  echo "[$(date)] Cleanup done."
}
trap cleanup EXIT SIGTERM

echo "[$(date)] Waiting for vLLM server (up to 180 min)..."
for i in $(seq 1 1080); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "[$(date)] vLLM ready after $((i * 10))s"
    break
  fi
  if ! kill -0 "$VLLM_PID" 2>/dev/null; then
    echo "[$(date)] ERROR: vLLM process exited during startup (see .err). Aborting."
    exit 1
  fi
  if [ $i -eq 1080 ]; then
    echo "[$(date)] ERROR: vLLM did not start within 180 minutes"
    kill $VLLM_PID 2>/dev/null
    exit 1
  fi
  sleep 10
done

echo "http://$(hostname):$PORT/v1" > "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
echo "[$(date)] Endpoint registered: http://$(hostname):$PORT/v1"

wait $VLLM_PID
EXIT_CODE=$?
cleanup
exit $EXIT_CODE
