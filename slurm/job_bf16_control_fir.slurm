#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=bf16_control
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/bf16_ctrl_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/bf16_ctrl_%j.err
#SBATCH --time=01:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=24
#SBATCH --mem=128G
#SBATCH --gpus=h100:2

# BF16 CONTROL for the FP8 validation: replays the SAME 600 cached extraction
# prompts (seed=42 sampling is identical) against the ORIGINAL BF16 model at the
# SAME concurrency (16) as the FP8 run. This establishes the run-to-run noise
# floor (batched greedy decoding is not reproducible), so the FP8-vs-BF16 diff
# can be judged against BF16-vs-BF16 variance rather than against the cache.

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
MODEL_NAME="Qwen/Qwen3.6-35B-A3B"
MODEL_DIR="models--Qwen--Qwen3.6-35B-A3B"

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export XDG_CACHE_HOME=$WORKDIR/cache
export TRITON_CACHE_DIR=$WORKDIR/cache/triton
export FLASHINFER_CACHE_DIR=$WORKDIR/cache/flashinfer
export FLASHINFER_DISABLE_VERSION_CHECK=1
export VLLM_ENGINE_READY_TIMEOUT_S=1800

module load python/3.11 gcc/12.3 cuda/12.6 opencv
source "$VENV_DIR/bin/activate" || { echo "venv missing"; exit 1; }

echo "[$(date)] Copying BF16 weights to local NVMe..."
mkdir -p "$SLURM_TMPDIR/hf_cache/hub"
cp -a "$WORKDIR/hf_cache/hub/$MODEL_DIR" "$SLURM_TMPDIR/hf_cache/hub/"
export HF_HOME="$SLURM_TMPDIR/hf_cache"
ls "$SLURM_TMPDIR/hf_cache/hub/$MODEL_DIR/snapshots/"*/config.json >/dev/null 2>&1 \
  || { echo "ERROR: BF16 snapshot has no config.json"; exit 1; }

mkdir -p "$SLURM_TMPDIR/triton_cache" "$SLURM_TMPDIR/flashinfer_cache"
rsync -a "$WORKDIR/cache/triton/" "$SLURM_TMPDIR/triton_cache/" 2>/dev/null || true
rsync -a "$WORKDIR/cache/flashinfer/" "$SLURM_TMPDIR/flashinfer_cache/" 2>/dev/null || true
export TRITON_CACHE_DIR="$SLURM_TMPDIR/triton_cache"
export FLASHINFER_CACHE_DIR="$SLURM_TMPDIR/flashinfer_cache"
export VLLM_SKIP_FLASHINFER_AUTOTUNE=1

PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0',0)); print(s.getsockname()[1]); s.close()")
ENGINE_LOG="$WORKDIR/logs/bf16_ctrl_engine_${SLURM_JOB_ID}.log"
echo "[$(date)] Starting $MODEL_NAME BF16 TP=2 on port $PORT (engine log: $ENGINE_LOG)"
vllm serve "$MODEL_NAME" \
  --host 127.0.0.1 --port $PORT \
  --tensor-parallel-size 2 \
  --enforce-eager --disable-custom-all-reduce \
  --max-model-len 40000 \
  --gpu-memory-utilization 0.90 \
  --dtype bfloat16 \
  --enable-prefix-caching \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  >> "$ENGINE_LOG" 2>&1 &
VLLM_PID=$!
trap 'kill $VLLM_PID 2>/dev/null; wait $VLLM_PID 2>/dev/null' EXIT SIGTERM

echo "[$(date)] Waiting for vLLM (up to 60 min)..."
for i in $(seq 1 360); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { echo "[$(date)] vLLM ready after $((i*10))s"; break; }
  kill -0 $VLLM_PID 2>/dev/null || { echo "ERROR: vLLM died during startup"; tail -40 "$ENGINE_LOG"; exit 1; }
  [ $i -eq 360 ] && { echo "ERROR: startup timeout"; exit 1; }
  sleep 10
done

# Prewarm — explicit PID waits only (never bare `wait`; it would block on vLLM)
for c in 1 4 8; do
  PIDS=""
  for j in $(seq 1 $c); do
    curl -sf -m 180 "http://127.0.0.1:$PORT/v1/chat/completions" -H 'Content-Type: application/json' \
      -d '{"model":"'"$MODEL_NAME"'","messages":[{"role":"user","content":"Count from 1 to 60, comma separated."}],"max_tokens":256,"temperature":0}' >/dev/null 2>&1 &
    PIDS="$PIDS $!"
  done
  wait $PIDS
done
echo "[$(date)] Prewarm done. Running BF16 control replay..."

python "$WORKDIR/fp8_replay_test.py" \
  --cache "$WORKDIR/rag_storage_full/kv_store_llm_response_cache.json" \
  --endpoint "http://127.0.0.1:$PORT/v1" \
  --model "$MODEL_NAME" \
  --n "${REPLAY_N:-600}" \
  --concurrency "${REPLAY_CONC:-16}" \
  --report "$WORKDIR/logs/bf16_ctrl_report_${SLURM_JOB_ID}.json" \
  --pairs "$WORKDIR/logs/bf16_ctrl_pairs_${SLURM_JOB_ID}.jsonl"
echo "[$(date)] BF16 control replay finished rc=$?"
exit 0
