#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_vllm
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_vllm_%j.err
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=24
#SBATCH --mem=128G
#SBATCH --gpus=h100:2

# vLLM-only: Qwen3.6-35B-A3B (MoE, BF16) on 2× H100 (tensor-parallel-size 2).
# Paired with a separate ingest job that runs the Qwen3 embedder on its own GPU/MIG.
#
# BF16 MoE across 2 dedicated H100s (gpu-memory-utilization 0.90):
#   Model weights (BF16): ~70 GiB total (~35 GiB per GPU)
#   Leaves large KV-cache headroom across the 2× 80 GiB H100s.
#   3B active params/token → high decode throughput despite 35B total.
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
# max-model-len 36000 is well under the model's native context (262144). Ingest
# contextualization caps full-doc context at MAX_DOC_TOKENS (ingest scripts set
# 20000), so 36000 covers it comfortably; raise both together if you ever need more.
echo "[$(date)] Starting Qwen/Qwen3.6-35B-A3B (BF16, MoE) on 2× H100 (TP=2, 36K context, gpu-util 0.90)..."
vllm serve Qwen/Qwen3.6-35B-A3B \
  --host 0.0.0.0 \
  --port $PORT \
  --tensor-parallel-size 2 \
  --max-model-len 36000 \
  --gpu-memory-utilization 0.90 \
  --dtype bfloat16 \
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
