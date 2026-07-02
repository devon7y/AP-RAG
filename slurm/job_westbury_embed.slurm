#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_embed
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/westbury_embed_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/westbury_embed_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --gpus=h100:1

# Dedicated embedding server (P4 in docs/INGEST_EFFICIENCY_OPEN_PROBLEMS.md).
#
# Serves scripts/server.py (OpenAI-compatible /v1/embeddings, task-aware Qwen3
# instruction hook) on its own H100 and registers the endpoint in
# $WORKDIR/embed_endpoints/<jobid>.txt. The ingest jobs auto-adopt a healthy
# registered endpoint (EMBED_ENDPOINT), which:
#   - frees the ingest job's GPU (or lets the ingest job drop its GPU request),
#   - decouples embedding throughput from the LLM/ingest lifecycle,
#   - removes the in-process VRAM ceiling (EMBED_FUNC_MAX_ASYNC=3 peaked 98.5%
#     alongside the ingest process; alone on a card there is full headroom).
#
# OPTIONAL: the default topology (embedder in-process on the ingest job's GPU)
# keeps working when this job isn't running — nothing depends on it.
#
# Cluster notes: WORKDIR default fits Rorqual/Nibi (/scratch/...). On Fir submit
# with --export=ALL,WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag; on
# Trillium add VENV_DIR=$WORKDIR/venv_tril. fastapi/uvicorn ship with the vLLM
# install, and the embedding model is already staged in HF_HOME by the setup job.

WORKDIR=${WORKDIR:-/scratch/devon7y/westbury_rag}
VENV_DIR=${VENV_DIR:-$WORKDIR/venv}
EMBED_ENDPOINTS_DIR="$WORKDIR/${EMBED_ENDPOINTS_SUBDIR:-embed_endpoints}"

export HF_HOME=${HF_HOME:-$WORKDIR/hf_cache}
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export XDG_CACHE_HOME=$WORKDIR/cache
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

mkdir -p "$EMBED_ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/cache"

module load python/3.11 gcc/12.3 cuda/12.6 opencv

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: venv not found at $VENV_DIR. Run the setup job first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv activated)."

PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0', 0)); print(s.getsockname()[1]); s.close()")
echo "[$(date)] Starting Qwen3-Embedding-8B server on port $PORT (bf16, full H100)..."

cd "$WORKDIR/scripts"
EMBED_MODEL_ID=${EMBED_MODEL_ID:-Qwen/Qwen3-Embedding-8B} \
EMBED_DEVICE=cuda \
EMBED_TORCH_DTYPE=${EMBED_TORCH_DTYPE:-bfloat16} \
EMBED_BATCH=${EMBED_BATCH:-64} \
  python -m uvicorn server:app --host 0.0.0.0 --port "$PORT" &
EMBED_PID=$!

cleanup() {
  kill $EMBED_PID 2>/dev/null
  wait $EMBED_PID 2>/dev/null
  rm -f "$EMBED_ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
  echo "[$(date)] Cleanup done."
}
trap cleanup EXIT SIGTERM

echo "[$(date)] Waiting for embedding server (up to 15 min — model load ~1 min)..."
for i in $(seq 1 90); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "[$(date)] Embedding server ready after $((i * 10))s"
    break
  fi
  if ! kill -0 "$EMBED_PID" 2>/dev/null; then
    echo "[$(date)] ERROR: embedding server exited during startup (see .err). Aborting."
    exit 1
  fi
  if [ $i -eq 90 ]; then
    echo "[$(date)] ERROR: embedding server did not start within 15 minutes"
    kill $EMBED_PID 2>/dev/null
    exit 1
  fi
  sleep 10
done

# Registered WITHOUT /v1 — the ingest health-checks "$ep/health" and its
# _remote_embed appends /v1/embeddings itself.
echo "http://$(hostname):$PORT" > "$EMBED_ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
echo "[$(date)] Endpoint registered: http://$(hostname):$PORT"

wait $EMBED_PID
EXIT_CODE=$?
cleanup
exit $EXIT_CODE
