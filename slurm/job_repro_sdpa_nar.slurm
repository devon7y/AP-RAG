#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=repro_sdpa
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/repro_sdpa_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/repro_sdpa_%j.err
#SBATCH --time=01:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --gpus=a100:1
# Narval (A100/sm80) leg of the cuDNN-SDPA segfault A/B repro (see
# scripts/repro_sdpa_crash.py + job_repro_sdpa_tril.slurm). Either result is
# informative: A crashes -> bug reproduces on Ampere too; A passes -> torch
# doesn't route these shapes to the cuDNN backend on sm80, so Narval could
# drain the tail even unpatched. Narval: 1h min walltime; --mem allowed.

export WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv

export HF_HOME=$WORKDIR/hf_cache
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TIKTOKEN_CACHE_DIR=$WORKDIR/cache/tiktoken
export XDG_CACHE_HOME=$WORKDIR/cache
export PYTHONFAULTHANDLER=1
export PYTHONPATH=$WORKDIR
# chunker settings — identical to the ingest runs
export PAPERS_SUBDIR=papers_full
export CHUNK_TARGET_TOKENS=512 CHUNK_MAX_TOKENS=640 CHUNK_MIN_TOKENS=192
export CHUNK_OVERLAP_TOKENS=51 CHUNK_EXCLUDE_REFS=1 CHUNK_EXCLUDE_ACK=1
export EMBED_BATCH=32 EMBEDDING_BATCH_NUM=128 EMBED_MAX_SEQ=4096

module load python/3.11 gcc/12.3 cuda/12.6 opencv
source "$VENV_DIR/bin/activate" || { echo "venv missing"; exit 1; }
ulimit -c 0

PDFS="Wittgenstein_1998.pdf Winograd_1972.pdf Wiles_Etal_1991.pdf"
cd "$WORKDIR"

echo "===== PHASE A: default SDPA backends ====="
python scripts/repro_sdpa_crash.py default $PDFS
RC_A=$?
echo "===== PHASE A rc=$RC_A ====="

echo "===== PHASE B: cuDNN SDPA disabled ====="
python scripts/repro_sdpa_crash.py nocudnn $PDFS
RC_B=$?
echo "===== PHASE B rc=$RC_B ====="

echo "VERDICT(A100): A(default)=$RC_A B(nocudnn)=$RC_B"
if [ "$RC_A" -ne 0 ] && [ "$RC_B" -eq 0 ]; then
  echo "VERDICT: cuDNN SDPA crash REPRODUCES on A100; disabling fixes it."
elif [ "$RC_A" -eq 0 ]; then
  echo "VERDICT: no crash on A100 — cuDNN backend not selected on sm80; Narval can embed these docs as-is."
fi
