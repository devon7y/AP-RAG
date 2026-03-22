#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=cml_vllm_2gpu
#SBATCH --output=/home/devon7y/scratch/devon7y/rag_testing/logs/vllm_2gpu_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/rag_testing/logs/vllm_2gpu_%j.err
#SBATCH --time=06:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=80G
#SBATCH --gpus-per-node=h100:2
#SBATCH --exclude=fc10512

WORKDIR=/home/devon7y/scratch/devon7y/rag_testing
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_cml_2gpu
PORT=8000

mkdir -p $ENDPOINTS_DIR $WORKDIR/logs

module load python/3.11 gcc/12.3 opencv/4.13.0

echo "[$(date)] Setting up vLLM on $(hostname)..."
python -m venv $SLURM_TMPDIR/venv
source $SLURM_TMPDIR/venv/bin/activate

pip install --quiet vllm
echo "[$(date)] vLLM installed."

# 2x H100 (160GB), TP=2. Qwen2.5-72B BF16 weights ~144GB total (72GB/GPU).
# gpu-memory-utilization 0.97 → ~76GB/GPU budgeted; ~4GB/GPU (~8GB total) for KV cache.
# max-model-len 16384 needs ~5GB KV cache total — fits comfortably.
echo "[$(date)] Starting Qwen2.5-72B on 2x H100 (16K context, BF16)..."
VLLM_ALLOW_LONG_MAX_MODEL_LEN=1 vllm serve Qwen/Qwen2.5-72B-Instruct \
  --host 0.0.0.0 \
  --port $PORT \
  --tensor-parallel-size 2 \
  --max-model-len 16384 \
  --dtype bfloat16 \
  --gpu-memory-utilization 0.97 &
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
