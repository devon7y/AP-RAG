#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_vllm_fp8
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/vllm_fp8_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/vllm_fp8_%j.err
#SBATCH --time=10:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=6
#SBATCH --mem=40G
#SBATCH --gpus=h100:1
#SBATCH --exclude=fc10512

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints
PORT=8000

mkdir -p $ENDPOINTS_DIR $WORKDIR/logs

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

echo "[$(date)] Setting up vLLM on $(hostname)..."
python -m venv $SLURM_TMPDIR/venv
source $SLURM_TMPDIR/venv/bin/activate

pip install --quiet uv
uv pip install vllm --pre --extra-index-url https://wheels.vllm.ai/nightly
uv pip install git+https://github.com/huggingface/transformers.git
echo "[$(date)] vLLM nightly installed."

# Qwen3.5-27B-FP8 weights ~27GB on single H100 (80GB).
# 0.90 utilisation -> 72GB budget; ~45GB KV cache -> full 128K context.
# --served-model-name aliases so ingest_westbury_parallel.py works unchanged.
echo "[$(date)] Starting Qwen3.5-27B-FP8 on 1x H100 (128K context)..."
VLLM_ALLOW_LONG_MAX_MODEL_LEN=1 vllm serve Qwen/Qwen3.5-27B-FP8 \
  --served-model-name Qwen/Qwen2.5-72B-Instruct \
  --host 0.0.0.0 \
  --port $PORT \
  --tensor-parallel-size 1 \
  --max-model-len 131072 \
  --gpu-memory-utilization 0.90 &
VLLM_PID=$!

echo "[$(date)] Waiting for vLLM server..."
for i in $(seq 1 360); do
  if curl -sf http://localhost:$PORT/health > /dev/null 2>&1; then
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

echo "http://$(hostname):$PORT/v1" > $ENDPOINTS_DIR/${SLURM_JOB_ID}.txt
echo "[$(date)] Endpoint registered: http://$(hostname):$PORT/v1"

wait $VLLM_PID
echo "[$(date)] vLLM exited. Job done."
