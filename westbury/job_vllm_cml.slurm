#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=cml_vllm
#SBATCH --output=/home/devon7y/scratch/devon7y/rag_testing/logs/vllm_%A_%a.out
#SBATCH --error=/home/devon7y/scratch/devon7y/rag_testing/logs/vllm_%A_%a.err
#SBATCH --time=06:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=24
#SBATCH --mem=128G
#SBATCH --gpus-per-node=h100:4
#SBATCH --exclude=fc10512

# Submitted as: sbatch --array=1-3 job_vllm_cml.slurm

WORKDIR=/home/devon7y/scratch/devon7y/rag_testing
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_cml
PORT=8000

mkdir -p $ENDPOINTS_DIR $WORKDIR/logs

module load python/3.11 gcc/12.3 opencv/4.13.0

echo "[$(date)] Array task $SLURM_ARRAY_TASK_ID — setting up vLLM on $(hostname)..."
python -m venv $SLURM_TMPDIR/venv
source $SLURM_TMPDIR/venv/bin/activate

pip install --quiet vllm
echo "[$(date)] vLLM installed."

echo "[$(date)] Starting Qwen2.5-72B on 4x H100 (128K context window, BF16)..."
VLLM_ALLOW_LONG_MAX_MODEL_LEN=1 vllm serve Qwen/Qwen2.5-72B-Instruct \
  --host 0.0.0.0 \
  --port $PORT \
  --tensor-parallel-size 4 \
  --max-model-len 131072 \
  --dtype bfloat16 \
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
