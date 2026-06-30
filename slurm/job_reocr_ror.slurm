#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=reocr
#SBATCH --output=/scratch/devon7y/reocr/logs/reocr_%j.out
#SBATCH --error=/scratch/devon7y/reocr/logs/reocr_%j.err
#SBATCH --time=04:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=24
#SBATCH --mem=128G
#SBATCH --gpus=h100:2

# Re-OCR non-digital PDFs with Infinity-Parser2-Pro (Qwen3.5-MoE VLM, 35B). Served
# by the EXISTING westbury vLLM (which already supports Qwen3_5MoeForConditionalGeneration),
# so no separate env/container. One self-contained job: serve locally -> wait ready
# -> run the client over LIST -> stop. Set LIST for pilot vs full:
#   sbatch --export=ALL,LIST=/scratch/devon7y/reocr/pilot_list.txt      job_reocr_ror.slurm
#   sbatch --export=ALL,LIST=/scratch/devon7y/reocr/nondigital_list.txt job_reocr_ror.slurm
set -e

WESTBURY=/scratch/devon7y/westbury_rag
REOCR=/scratch/devon7y/reocr
HF_SHARED=/scratch/devon7y/huggingface
LIST=${LIST:-$REOCR/pilot_list.txt}

export HF_HOME=$HF_SHARED HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export XDG_CACHE_HOME=$REOCR/cache TRITON_CACHE_DIR=$REOCR/cache/triton
export FLASHINFER_CACHE_DIR=$REOCR/cache/flashinfer FLASHINFER_DISABLE_VERSION_CHECK=1
mkdir -p $REOCR/logs $REOCR/text_out $REOCR/cache/triton $REOCR/cache/flashinfer

module load python/3.11 gcc/12.3 cuda/12.6 opencv
source $WESTBURY/venv/bin/activate

# Rorqual scratch is Lustre (slow 70GB loads) — stage the model on node-local NVMe.
echo "[$(date)] staging model to NVMe ..."
mkdir -p $SLURM_TMPDIR/hf/hub
cp -a $HF_SHARED/hub/models--infly--Infinity-Parser2-Pro $SLURM_TMPDIR/hf/hub/
export HF_HOME=$SLURM_TMPDIR/hf
MODELPATH=$(ls -d $SLURM_TMPDIR/hf/hub/models--infly--Infinity-Parser2-Pro/snapshots/*/ | head -1)
[ -f "$MODELPATH/config.json" ] || { echo "ERROR: model not staged"; exit 1; }

PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("0.0.0.0",0));print(s.getsockname()[1]);s.close()')
echo "[$(date)] starting vLLM serve on port $PORT (TP=2) ..."
vllm serve "$MODELPATH" --served-model-name infly/Infinity-Parser2-Pro \
  --trust-remote-code --reasoning-parser qwen3 --host 0.0.0.0 --port $PORT \
  --tensor-parallel-size 2 --gpu-memory-utilization 0.85 --max-model-len 65536 \
  --mm-encoder-tp-mode data --mm-processor-cache-type shm --enable-prefix-caching \
  --limit-mm-per-prompt '{"image":1}' > $REOCR/logs/vllm_${SLURM_JOB_ID}.log 2>&1 &
VLLM_PID=$!

echo "[$(date)] waiting for vLLM to be ready ..."
for i in $(seq 1 180); do
  if python3 -c "import urllib.request;urllib.request.urlopen('http://localhost:$PORT/health',timeout=3)" 2>/dev/null; then
    echo "[$(date)] vLLM ready after $((i*10))s"; READY=1; break
  fi
  kill -0 $VLLM_PID 2>/dev/null || { echo "ERROR: vLLM died during startup — see vllm_${SLURM_JOB_ID}.log"; tail -30 $REOCR/logs/vllm_${SLURM_JOB_ID}.log; exit 1; }
  sleep 10
done
[ "$READY" = 1 ] || { echo "ERROR: vLLM not ready in 30min"; tail -30 $REOCR/logs/vllm_${SLURM_JOB_ID}.log; kill $VLLM_PID; exit 1; }

echo "[$(date)] running re-OCR client over $LIST ..."
python $REOCR/reocr_client.py --endpoint http://localhost:$PORT/v1 \
  --list $LIST --pdf-dir $REOCR/pdfs_in --out $REOCR/text_out --dpi 170 --concurrency 12

echo "[$(date)] stopping vLLM ..."
kill $VLLM_PID 2>/dev/null || true
echo "[$(date)] REOCR RUN DONE"
