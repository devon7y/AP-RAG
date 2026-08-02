#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=fp8_replay_test
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/fp8_test_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/fp8_test_%j.err
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=12
#SBATCH --mem=100G
#SBATCH --gpus=h100:1

# FP8 validation: serve Qwen3.6-35B-A3B-FP8 on ONE H100 (TP=1 — the intended
# production shape; BF16 needs TP=2), replay cached BF16 extraction prompts
# from the LightRAG response cache, and diff outputs + measure throughput.
# Deliberately does NOT register in the vLLM endpoints dir — the ingest jobs
# must never adopt this endpoint.

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv
MODEL_NAME="Qwen/Qwen3.6-35B-A3B-FP8"
MODEL_DIR="models--Qwen--Qwen3.6-35B-A3B-FP8"

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

# Stage FP8 weights on node-local NVMe (same pattern as the production vLLM job)
echo "[$(date)] Copying FP8 weights to local NVMe..."
mkdir -p "$SLURM_TMPDIR/hf_cache/hub"
cp -a "$WORKDIR/hf_cache/hub/$MODEL_DIR" "$SLURM_TMPDIR/hf_cache/hub/"
export HF_HOME="$SLURM_TMPDIR/hf_cache"
ls "$SLURM_TMPDIR/hf_cache/hub/$MODEL_DIR/snapshots/"*/config.json >/dev/null 2>&1 \
  || { echo "ERROR: FP8 snapshot has no config.json — download incomplete?"; exit 1; }

# Node-local JIT caches (GDN kernels JIT-compile lazily; keep writes off Lustre)
mkdir -p "$SLURM_TMPDIR/triton_cache" "$SLURM_TMPDIR/flashinfer_cache"
rsync -a "$WORKDIR/cache/triton/" "$SLURM_TMPDIR/triton_cache/" 2>/dev/null || true
rsync -a "$WORKDIR/cache/flashinfer/" "$SLURM_TMPDIR/flashinfer_cache/" 2>/dev/null || true
export TRITON_CACHE_DIR="$SLURM_TMPDIR/triton_cache"
export FLASHINFER_CACHE_DIR="$SLURM_TMPDIR/flashinfer_cache"
export VLLM_SKIP_FLASHINFER_AUTOTUNE=1
# DeepGEMM JIT-compiles FP8 kernels via nvcc at startup and that compile fails
# on Alliance compute nodes ("NVCC compilation failed", job 49405662). The
# Triton block-FP8 path (already chosen for MoE) handles everything instead.
export VLLM_USE_DEEP_GEMM=0

PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0',0)); print(s.getsockname()[1]); s.close()")
ENGINE_LOG="$WORKDIR/logs/fp8_engine_${SLURM_JOB_ID}.log"
echo "[$(date)] Starting $MODEL_NAME TP=1 on port $PORT (engine log: $ENGINE_LOG)"
vllm serve "$MODEL_NAME" \
  --host 127.0.0.1 --port $PORT \
  --tensor-parallel-size 1 \
  --max-model-len 40000 \
  --gpu-memory-utilization 0.90 \
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

# Small prewarm to force lazy JIT now, not during the timed replay.
# wait on EXPLICIT pids only — a bare `wait` blocks on the vLLM server too
# (background job of this shell) and hangs until walltime (job 49446491).
for c in 1 4 8; do
  PIDS=""
  for j in $(seq 1 $c); do
    curl -sf -m 180 "http://127.0.0.1:$PORT/v1/chat/completions" -H 'Content-Type: application/json' \
      -d '{"model":"'"$MODEL_NAME"'","messages":[{"role":"user","content":"Count from 1 to 60, comma separated."}],"max_tokens":256,"temperature":0}' >/dev/null 2>&1 &
    PIDS="$PIDS $!"
  done
  wait $PIDS
done
echo "[$(date)] Prewarm done. Running replay..."

python "$WORKDIR/fp8_replay_test.py" \
  --cache "$WORKDIR/rag_storage_full/kv_store_llm_response_cache.json" \
  --endpoint "http://127.0.0.1:$PORT/v1" \
  --model "$MODEL_NAME" \
  --n "${REPLAY_N:-600}" \
  --concurrency "${REPLAY_CONC:-16}" \
  --report "$WORKDIR/logs/fp8_replay_report_${SLURM_JOB_ID}.json" \
  --pairs "$WORKDIR/logs/fp8_replay_pairs_${SLURM_JOB_ID}.jsonl"
RC=$?
echo "[$(date)] Replay finished rc=$RC"
exit $RC
