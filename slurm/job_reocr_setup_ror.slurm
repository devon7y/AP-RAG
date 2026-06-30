#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=reocr_setup
#SBATCH --output=/scratch/devon7y/reocr/logs/setup_%j.out
#SBATCH --error=/scratch/devon7y/reocr/logs/setup_%j.err
#SBATCH --time=02:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G

# One-time setup for the Infinity-Parser2-Pro re-OCR step on Rorqual.
# Builds a DEDICATED venv (kept separate from the ingest venv) and downloads the
# 35B model into the shared HF cache. CPU-only (Rorqual compute nodes have
# internet for pip + hf download).
#
#   sbatch job_reocr_setup_ror.slurm
set -e

REOCR=/scratch/devon7y/reocr
HF_SHARED=/scratch/devon7y/huggingface
VENV=$REOCR/reocr_venv
export HF_HOME=$HF_SHARED
export XDG_CACHE_HOME=$REOCR/cache
mkdir -p "$REOCR/logs" "$REOCR/cache" "$REOCR/pdfs_in" "$REOCR/text_out" "$HF_SHARED"

module load python/3.12 gcc/12.3 cuda/12.6 opencv

echo "[$(date)] Building dedicated re-OCR venv at $VENV ..."
rm -rf "$VENV"
python -m venv "$VENV"
source "$VENV/bin/activate"
pip install --quiet --upgrade pip uv

echo "[$(date)] Installing infinity_parser2 (+ its vllm/transformers deps) ..."
uv pip install infinity_parser2 || pip install infinity_parser2
pip install --quiet pymupdf pdf2image "huggingface_hub[cli]"

python -c "import infinity_parser2 as ip; print('infinity_parser2', getattr(ip,'__version__','ok'))"
python -c "import vllm; print('vllm', vllm.__version__)" || echo "WARN: vllm import failed"

echo "[$(date)] Downloading infly/Infinity-Parser2-Pro into $HF_SHARED ..."
hf download infly/Infinity-Parser2-Pro || huggingface-cli download infly/Infinity-Parser2-Pro

echo "[$(date)] REOCR SETUP DONE"
