#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_vllm
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=64G
#SBATCH --gpus=h100:1

WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_westbury_qwen3_32b
PORT=8001

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export VLLM_ENGINE_READY_TIMEOUT_S=1800

mkdir -p "$ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/cache" "$WORKDIR/cache/flashinfer"

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

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
