#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=westbury_ingest
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/logs/ingest_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/logs/ingest_%j.err
#SBATCH --time=10:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G

WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
N_VLLM=20  # must match --array=1-N in job_vllm.slurm

mkdir -p $WORKDIR/logs $WORKDIR/rag_storage

module load python/3.11 gcc/12.3 opencv/4.13.0

echo "[$(date)] Setting up Python environment..."
python -m venv $SLURM_TMPDIR/venv
source $SLURM_TMPDIR/venv/bin/activate

pip install --quiet pypdf openai python-dotenv tiktoken
pip install --quiet "git+https://github.com/devon7y/LightRAG.git"
echo "[$(date)] Packages installed."

# Clear stale endpoint files from previous runs
rm -f $WORKDIR/vllm_endpoints/*.txt

# Wait for all vLLM nodes to register their endpoints
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

echo "[$(date)] Starting parallel ingestion..."
WORKDIR=$WORKDIR \
N_VLLM=$N_VLLM \
OPENAI_API_KEY=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 \
  python $WORKDIR/ingest_westbury_parallel.py

EXIT_CODE=$?
echo "[$(date)] Ingestion finished with exit code $EXIT_CODE."
exit $EXIT_CODE
