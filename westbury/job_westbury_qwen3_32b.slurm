#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_qwen3_32b
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_qwen3_32b_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_qwen3_32b_%j.err
#SBATCH --time=10:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=120G
#SBATCH --gpus=h100:1

# Single-GPU run: vLLM (Qwen3-32B, FP8-quantized at load time) + Octen-Embedding-8B-INT8.
#
# Memory budget (80GB H100):
#   vLLM  --gpu-memory-utilization 0.75 → 60GB claimed
#         Qwen3-32B BF16 weights ~64GB → quantized to FP8 at load = ~32GB
#         KV cache (~25GB available after weights + overhead)
#   Octen Embedding-8B-INT8            ~10GB in the remaining ~20GB
#
# max-model-len 36000: Qwen3-32B config.json has max_position_embeddings=40960.
#   Sequences beyond that cause RoPE out-of-bounds → CUDA assert → engine crash.
#   36000 gives headroom and allows ~5x concurrency in the KV cache.
#   MAX_DOC_TOKENS=25000 ensures no contextualize_chunks prompt exceeds this.
#
# Prerequisites: run job_setup_env.slurm once first to populate:
#   $WORKDIR/venv/          — persistent Python environment
#   $WORKDIR/hf_cache/      — pre-downloaded model weights

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
ENDPOINTS_DIR=$WORKDIR/vllm_endpoints_westbury_qwen3_32b
PORT=8001

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=/home/devon7y/scratch/devon7y/westbury_rag/cache/flashinfer
export BNB_CUDA_VERSION=126

mkdir -p "$ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/rag_storage_westbury_qwen3_32b" "$WORKDIR/cache" "/home/devon7y/scratch/devon7y/westbury_rag/cache/flashinfer"

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

# ── Activate persistent venv (created by job_setup_env.slurm) ────────────────
if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run job_setup_env.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

# ── Step 1: Start vLLM in background ─────────────────────────────────────────
# --quantization fp8: loads BF16 weights and quantizes to FP8 at startup,
#   halving weight memory (~64GB → ~32GB) and freeing KV cache headroom.
echo "[$(date)] Starting Qwen/Qwen3-32B with FP8 quantization (36K context)..."
vllm serve Qwen/Qwen3-32B \
  --host 0.0.0.0 \
  --port $PORT \
  --tensor-parallel-size 1 \
  --max-model-len 36000 \
  --gpu-memory-utilization 0.65 \
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

# ── Step 2: Wait for vLLM (allows time for model download on first run) ───────
echo "[$(date)] Waiting for vLLM server (up to 60 min — includes download if needed)..."
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

# ── Step 3: Run ingest — Octen loads AFTER vLLM has claimed its memory ───────
echo "[$(date)] Starting ingestion (rag_storage_westbury_qwen3_32b)..."
export PYTORCH_ALLOC_CONF=expandable_segments:True
WORKDIR=$WORKDIR \
N_VLLM=1 \
ENDPOINTS_SUBDIR=vllm_endpoints_westbury_qwen3_32b \
PAPERS_SUBDIR=papers \
STORAGE_SUBDIR=rag_storage_westbury_qwen3_32b \
LLM_MODEL=Qwen/Qwen3-32B \
PARALLEL_DOCS=4 \
LLM_MAX_ASYNC=8 \
MAX_DOC_TOKENS=20000 \
EMBED_FUNC_MAX_ASYNC=1 \
  python "$WORKDIR/ingest_cml_octen.py"

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

# ── Cleanup (also handled by trap) ─────────────────────────────────────────
cleanup
exit $EXIT_CODE
