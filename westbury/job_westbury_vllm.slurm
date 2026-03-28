#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_vllm
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.err
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=64G
#SBATCH --gpus=h100:1

# vLLM-only: Qwen3-32B with FP8 quantization on a dedicated H100.
# Paired with a separate ingest job that runs Octen on its own MIG instance.
#
# With a dedicated GPU, we can use higher gpu-memory-utilization (0.90):
#   Model weights (FP8): ~32 GiB
#   KV cache: ~38 GiB → ~4.3x concurrency at 36K context
#   No Octen contention.
#
# Walltime 12h: 2h buffer over the 10h ingest job to absorb queue delays.
# See PRE_FLIGHT.md check 4: vLLM walltime >= ingest walltime.

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_westbury_qwen3_32b
PORT=8001

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer

mkdir -p "$ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

# ── Start vLLM ──────────────────────────────────────────────────────────────
# PRE_FLIGHT check 13: max-model-len 36000 < max_position_embeddings 40960
echo "[$(date)] Starting Qwen/Qwen3-32B with FP8 quantization (36K context, gpu-util 0.90)..."
vllm serve Qwen/Qwen3-32B \
  --host 0.0.0.0 \
  --port $PORT \
  --tensor-parallel-size 1 \
  --max-model-len 36000 \
  --gpu-memory-utilization 0.90 \
  --quantization fp8 \
  --default-chat-template-kwargs '{"enable_thinking": false}' &
VLLM_PID=$!

# Ensure endpoint file is cleaned up even if SLURM kills us at walltime.
cleanup() {
  kill $VLLM_PID 2>/dev/null
  wait $VLLM_PID 2>/dev/null
  rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
  echo "[$(date)] Cleanup done."
}
trap cleanup EXIT SIGTERM

# ── Wait for vLLM to be ready ──────────────────────────────────────────────
echo "[$(date)] Waiting for vLLM server (up to 60 min)..."
for i in $(seq 1 360); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "[$(date)] vLLM ready after $((i * 10))s"
    break
  fi
  if [ $i -eq 360 ]; then
    echo "[$(date)] ERROR: vLLM did not start within 60 minutes"
    kill $VLLM_PID 2>/dev/null
    exit 1
  fi
  sleep 10
done

echo "http://$(hostname):$PORT/v1" > "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
echo "[$(date)] Endpoint registered: http://$(hostname):$PORT/v1"

# ── Keep running until walltime or vLLM exits ──────────────────────────────
wait $VLLM_PID
EXIT_CODE=$?

# ── Cleanup (also handled by trap) ─────────────────────────────────────────
cleanup
exit $EXIT_CODE
