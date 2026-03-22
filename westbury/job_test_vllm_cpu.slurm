#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_vllm_test
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/vllm_test_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/vllm_test_%j.err
#SBATCH --time=00:40:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --gpus=nvidia_h100_80gb_hbm3_1g.10gb:1

# Minimal GPU smoke test for vLLM flag correctness.
#
# Uses Qwen/Qwen3.5-0.8B (same Qwen3_5ForConditionalGeneration architecture
# as the production Qwen3.5-27B-FP8) on a 1/8 H100 MIG slice (10GB VRAM).
# Model weights ~1.6GB BF16 — fits easily. Verifies:
#   1. --no-enable-chunked-prefill is accepted (catches =False syntax error)
#   2. vLLM starts and passes health check with real CUDA
#   3. A real inference request completes (exercises FlashInfer code paths)
#   4. No EngineCore fatal errors on first request

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
PORT=8765

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=/home/devon7y/scratch/devon7y/westbury_rag/cache/flashinfer

mkdir -p "$WORKDIR/logs" "$WORKDIR/cache" "/home/devon7y/scratch/devon7y/westbury_rag/cache/flashinfer"

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "ERROR: venv not found at $VENV_DIR. Run job_setup_env.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] venv activated."

# ── Start vLLM on CPU with the same flags as the production GPU job ───────────
VLLM_LOG=$WORKDIR/logs/vllm_test_${SLURM_JOB_ID}_vllm.log
echo "[$(date)] Starting Qwen3.5-0.8B on MIG 1/8 H100 (same flags as production)..."
echo "[$(date)] vLLM output → $VLLM_LOG"
# Unset CUDA_VISIBLE_DEVICES: SLURM sets it to the MIG UUID string which
# vLLM nightly cannot parse as an integer. Unsetting lets CUDA discover
# the MIG instance as device 0 naturally.
unset CUDA_VISIBLE_DEVICES
vllm serve Qwen/Qwen3.5-0.8B \
  --host 0.0.0.0 \
  --port $PORT \
  --max-model-len 4096 \
  --no-enable-chunked-prefill > "$VLLM_LOG" 2>&1 &
VLLM_PID=$!

# ── Wait for healthy ──────────────────────────────────────────────────────────
echo "[$(date)] Waiting for vLLM server..."
READY=0
for i in $(seq 1 240); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "[$(date)] vLLM ready after $((i * 5))s"
    READY=1
    break
  fi
  sleep 5
done

if [ $READY -eq 0 ]; then
  echo "[$(date)] FAIL: vLLM did not start within 20 minutes"
  echo "--- last 30 lines of vLLM log ---"
  tail -30 "$VLLM_LOG"
  kill $VLLM_PID 2>/dev/null
  exit 1
fi

# ── Send a real inference request ────────────────────────────────────────────
echo "[$(date)] Sending test inference request..."
RESPONSE=$(curl -sf "http://localhost:$PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3.5-0.8B",
    "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
    "max_tokens": 10
  }')

kill $VLLM_PID 2>/dev/null
wait $VLLM_PID 2>/dev/null

# ── Check result ─────────────────────────────────────────────────────────────
if echo "$RESPONSE" | python3 -c "
import json, sys
data = json.load(sys.stdin)
content = data['choices'][0]['message']['content'].strip()
print(f'Model replied: {content!r}')
sys.exit(0)
" 2>/dev/null; then
  echo "[$(date)] PASS: inference completed successfully"
  exit 0
else
  echo "[$(date)] FAIL: inference request failed or returned unexpected response"
  echo "Raw response: $RESPONSE"
  exit 1
fi
