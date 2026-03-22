#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_rag
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/%x_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/%x_%j.err
#SBATCH --time=24:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=24
#SBATCH --mem=128G
#SBATCH --gpus-per-node=h100:4

module load python/3.11 gcc/12.3 opencv/4.13.0

echo "[$(date)] Setting up virtualenv..."
python -m venv $SLURM_TMPDIR/venv
source $SLURM_TMPDIR/venv/bin/activate

echo "[$(date)] Installing packages..."
pip install --quiet vllm pypdf openai python-dotenv
pip install --quiet "git+https://github.com/devon7y/LightRAG.git"
echo "[$(date)] pip install done. vllm: $(which vllm)"

cd /home/devon7y/scratch/devon7y/westbury_rag
mkdir -p logs rag_storage

echo "[$(date)] Starting vLLM with Qwen2.5-72B-Instruct BF16 across 4x H100..."
vllm serve Qwen/Qwen2.5-72B-Instruct \
  --host 0.0.0.0 \
  --port 8000 \
  --tensor-parallel-size 4 \
  --max-model-len 32768 \
  --dtype bfloat16 &
VLLM_PID=$!

echo "[$(date)] Waiting for vLLM server..."
for i in $(seq 1 90); do
  if curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    echo "[$(date)] vLLM server ready (attempt $i)"
    break
  fi
  if [ $i -eq 90 ]; then
    echo "[$(date)] ERROR: vLLM server did not start in time"
    kill $VLLM_PID 2>/dev/null
    exit 1
  fi
  sleep 10
done

echo "[$(date)] Starting Westbury paper ingestion with Contextual Retrieval enabled..."
PAPERS_DIR=/home/devon7y/scratch/devon7y/westbury_rag/papers \
STORAGE_DIR=/home/devon7y/scratch/devon7y/westbury_rag/rag_storage \
LLM_BINDING_HOST=http://localhost:8000/v1 \
LLM_MODEL=Qwen/Qwen2.5-72B-Instruct \
LLM_BINDING_API_KEY=EMPTY \
OPENAI_API_KEY=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 \
  python /home/devon7y/scratch/devon7y/rag_testing/ingest.py

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."

echo "[$(date)] Shutting down vLLM."
kill $VLLM_PID 2>/dev/null
wait $VLLM_PID 2>/dev/null

exit $EXIT_CODE
