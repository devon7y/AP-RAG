#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_1gpu
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_1gpu_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_1gpu_%j.err
#SBATCH --time=10:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=120G
#SBATCH --gpus=h100:1
#SBATCH --exclude=fc10512

# Single-GPU run: vLLM (Qwen3.5-27B-FP8) + Octen-Embedding-8B-INT8 on one H100.
#
# Memory budget (80GB H100):
#   vLLM  --gpu-memory-utilization 0.85 → 68GB claimed
#         Qwen3.5-27B-FP8 weights ~27GB, KV cache ~41GB (fits 128K context)
#   Octen Embedding-8B-INT8            ~10GB in the remaining ~12GB
#
# vLLM MUST be fully loaded before the ingest script starts so it claims
# its memory share before sentence-transformers allocates anything.
#
# Prerequisites: run job_setup_env.slurm once first to populate:
#   $WORKDIR/venv/          — persistent Python environment
#   $WORKDIR/hf_cache/      — pre-downloaded model weights

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_westbury_1gpu
PORT=8000

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=/home/devon7y/scratch/devon7y/westbury_rag/cache/flashinfer
export BNB_CUDA_VERSION=126

mkdir -p "$ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/rag_storage_westbury_1gpu" "$WORKDIR/cache" "/home/devon7y/scratch/devon7y/westbury_rag/cache/flashinfer"

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

# ── Activate persistent venv (created by job_setup_env.slurm) ────────────────
if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

# ── Step 1: Start vLLM in background ─────────────────────────────────────────
echo "[$(date)] Starting Qwen3.5-27B-FP8 (gpu-util 0.85, 128K context)..."
VLLM_ALLOW_LONG_MAX_MODEL_LEN=1 vllm serve Qwen/Qwen3.5-27B-FP8 \
  --host 0.0.0.0 \
  --port $PORT \
  --tensor-parallel-size 1 \
  --max-model-len 131072 \
  --gpu-memory-utilization 0.85 \
  --language-model-only \
  --default-chat-template-kwargs '{"enable_thinking": false}' &
VLLM_PID=$!

# ── Step 2: Wait for vLLM to be fully loaded before Octen allocates anything ─
echo "[$(date)] Waiting for vLLM server..."
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

# ── Step 3: Run ingest — Octen loads AFTER vLLM has claimed its 68GB ─────────
echo "[$(date)] Starting ingestion (rag_storage_westbury_1gpu)..."
WORKDIR=$WORKDIR \
N_VLLM=1 \
ENDPOINTS_SUBDIR=vllm_endpoints_westbury_1gpu \
PAPERS_SUBDIR=papers \
STORAGE_SUBDIR=rag_storage_westbury_1gpu \
  python "$WORKDIR/ingest_cml_octen.py"

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

# ── Cleanup ───────────────────────────────────────────────────────────────────
kill $VLLM_PID 2>/dev/null
wait $VLLM_PID 2>/dev/null
rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"

exit $EXIT_CODE
