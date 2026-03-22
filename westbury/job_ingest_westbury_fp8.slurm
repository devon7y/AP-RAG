#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_ingest_fp8
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/ingest_fp8_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/ingest_fp8_%j.err
#SBATCH --time=10:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G
#SBATCH --gpus=h100:1

# GPU needed to run Octen-Embedding-8B-INT8 (sentence-transformers, ~12GB VRAM)

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
N_VLLM=1

mkdir -p $WORKDIR/logs $WORKDIR/rag_storage_octen

module load python/3.11 gcc/12.3 opencv/4.13.0

echo "[$(date)] Setting up Python environment..."
python -m venv $SLURM_TMPDIR/venv
source $SLURM_TMPDIR/venv/bin/activate

pip install --quiet pypdf tiktoken
pip install --quiet "accelerate>=1.1.0" bitsandbytes sentence-transformers
pip install --quiet "git+https://github.com/devon7y/LightRAG.git"
echo "[$(date)] Packages installed."

# Do NOT clear endpoint files — the vLLM job may already be running

# Wait for vLLM endpoint
echo "[$(date)] Waiting for $N_VLLM vLLM endpoints..."
for i in $(seq 1 360); do
  N=$(ls $WORKDIR/vllm_endpoints/*.txt 2>/dev/null | wc -l)
  if [ "$N" -ge "$N_VLLM" ]; then
    echo "[$(date)] All $N vLLM endpoints ready."
    break
  fi
  if [ $i -eq 360 ]; then
    echo "[$(date)] WARNING: Only $N/$N_VLLM endpoints after 60min. Proceeding anyway."
    break
  fi
  echo "[$(date)] Waiting... ($N/$N_VLLM ready)"
  sleep 10
done

echo "[$(date)] Starting ingestion..."
WORKDIR=$WORKDIR \
N_VLLM=$N_VLLM \
ENDPOINTS_SUBDIR=vllm_endpoints \
PAPERS_SUBDIR=papers \
STORAGE_SUBDIR=rag_storage_octen \
  python $WORKDIR/ingest_cml_octen.py

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."
exit $EXIT_CODE
