#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_mineru
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_mineru_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_mineru_%j.err
#SBATCH --time=03:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --gpus=nvidia_h100_80gb_hbm3_3g.40gb:1

# MinerU PDF parser service for the native multimodal (VLM) ingest path.
#
# This serves MinerU's self-hosted HTTP API (pipeline backend). LightRAG's MinerU
# client (MINERU_API_MODE=local) auto-detects the server by probing /tasks,
# /file_parse, /health — so the stock `mineru-api` server works; we just publish the
# BASE URL (no path) into MINERU_LOCAL_ENDPOINT via an endpoint file, mirroring the
# vLLM job pattern. The ingest job reads it (see job_westbury_ingest_v2.slurm,
# INGEST_VLM=1). MinerU only EXTRACTS figures/tables/formulas; LightRAG's `vlm` role
# (Qwen3.6, from the vLLM job) does the captioning — so we keep MinerU's own image
# analysis OFF (set in the ingest job via MINERU_LOCAL_IMAGE_ANALYSIS=false).
#
# Walltime should cover the paired ingest run (3h buffer like the vLLM job).
#
# NOTE (validate on first Fir run): the exact `mineru-api` entrypoint / flags and the
# model-download step depend on the installed MinerU version (see job_setup_mineru.slurm).

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_mineru
ENDPOINTS_DIR=$WORKDIR/mineru_endpoints
PORT=8100

export HF_HOME=$WORKDIR/hf_cache
export XDG_CACHE_HOME=$WORKDIR/cache
export MINERU_MODEL_SOURCE=${MINERU_MODEL_SOURCE:-huggingface}   # 'local' for offline clusters
export MINERU_DEVICE_MODE=cuda

mkdir -p "$ENDPOINTS_DIR" "$WORKDIR/logs" "$WORKDIR/cache"

module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6

if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "[$(date)] ERROR: MinerU venv not found at $VENV_DIR. Run job_setup_mineru.slurm first."
  exit 1
fi
source "$VENV_DIR/bin/activate"
echo "[$(date)] Environment ready (venv_mineru activated)."

# ── Start the MinerU API server (pipeline backend) ─────────────────────────────
echo "[$(date)] Starting mineru-api on port $PORT (pipeline backend)..."
mineru-api --host 0.0.0.0 --port "$PORT" &
MINERU_PID=$!

cleanup() {
  kill $MINERU_PID 2>/dev/null
  wait $MINERU_PID 2>/dev/null
  rm -f "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
  echo "[$(date)] Cleanup done."
}
trap cleanup EXIT SIGTERM

# ── Wait for the server to be ready (probe /health) ────────────────────────────
echo "[$(date)] Waiting for MinerU server (up to 30 min)..."
for i in $(seq 1 180); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1 \
     || curl -sf "http://localhost:$PORT/docs" > /dev/null 2>&1; then
    echo "[$(date)] MinerU ready after $((i * 10))s"
    break
  fi
  if [ $i -eq 180 ]; then
    echo "[$(date)] ERROR: MinerU did not start within 30 minutes"
    kill $MINERU_PID 2>/dev/null
    exit 1
  fi
  sleep 10
done

# Publish the BASE URL (LightRAG's MinerU client rejects endpoints that include an API path).
echo "http://$(hostname):$PORT" > "$ENDPOINTS_DIR/${SLURM_JOB_ID}.txt"
echo "[$(date)] MinerU endpoint registered: http://$(hostname):$PORT"

wait $MINERU_PID
EXIT_CODE=$?
cleanup
exit $EXIT_CODE
