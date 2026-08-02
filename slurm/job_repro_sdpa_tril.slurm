#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=repro_sdpa
#SBATCH --output=/scratch/devon7y/westbury_rag/logs/repro_sdpa_%j.out
#SBATCH --error=/scratch/devon7y/westbury_rag/logs/repro_sdpa_%j.err
#SBATCH --partition=compute
#SBATCH --gpus-per-node=h100:1
#SBATCH --time=00:45:00
#SBATCH --nodes=1
# A/B repro of the cuDNN-SDPA embedder segfault (see scripts/repro_sdpa_crash.py).
# Phase A (default backends) is EXPECTED to segfault (rc=139); phase B (cudnn
# SDPA disabled) is expected to succeed. Trillium rules: no --mem, gpus-per-node.

export WORKDIR=/scratch/devon7y/westbury_rag
VENV_DIR=$WORKDIR/venv_tril

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

# Trillium: $HOME is read-only on compute nodes
export HOME="$SLURM_TMPDIR"
ulimit -c 0   # we already have 5 cores; don't write 54GB more

PDFS="Wittgenstein_1998.pdf Winograd_1972.pdf Wiles_Etal_1991.pdf"
cd "$WORKDIR"

echo "===== PHASE A: default SDPA backends (expect SIGSEGV = rc 139) ====="
python scripts/repro_sdpa_crash.py default $PDFS
RC_A=$?
echo "===== PHASE A rc=$RC_A ====="

echo "===== PHASE B: cuDNN SDPA disabled (expect SUCCESS = rc 0) ====="
python scripts/repro_sdpa_crash.py nocudnn $PDFS
RC_B=$?
echo "===== PHASE B rc=$RC_B ====="

echo "VERDICT: A(default)=$RC_A B(nocudnn)=$RC_B"
if [ "$RC_A" -ne 0 ] && [ "$RC_B" -eq 0 ]; then
  echo "VERDICT: CONFIRMED — cuDNN SDPA backend is the crash; disabling it fixes embedding of these docs."
fi
