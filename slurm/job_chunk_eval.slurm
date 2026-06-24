#!/bin/bash
#SBATCH --account=def-jcaplan
#SBATCH --job-name=chunk_eval
#SBATCH --output=/home/devon7y/scratch/devon7y/westbury_rag/chunk_eval/logs/%x_%j.out
#SBATCH --error=/home/devon7y/scratch/devon7y/westbury_rag/chunk_eval/logs/%x_%j.err
#SBATCH --time=01:30:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G
# MIG slice (proven in run-1; full h100:1 hit a CUDA-init crash on a bad node and
# queued ~77 min). MIG schedules fast and fits the 8B BF16 model in 40 GB.
#SBATCH --gpus=nvidia_h100_80gb_hbm3_3g.40gb:1
#
# Chunk-size A/B eval (Chroma methodology) with the production asymmetric
# Qwen3-Embedding-8B (BF16). Reuses the ingest venv + HF cache. The official
# chunking_evaluation package is installed into an ISOLATED --target dir on
# PYTHONPATH so it can't perturb the production venv; run_eval.py falls back to
# replicated chunkers/locator if it's unavailable.
#
# Prereqs on Fir ($WORKDIR): pipeline/ + scripts/chunk_eval/ synced; chunk_eval/
# {corpus.jsonl, qa.jsonl} uploaded. Submit:  sbatch slurm/job_chunk_eval.slurm

set -euo pipefail
WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag
EVAL_DIR=$WORKDIR/chunk_eval
LIBS=$EVAL_DIR/_libs
mkdir -p "$EVAL_DIR/logs" "$LIBS"

# HF cache that already holds Qwen3-Embedding-8B on Fir (verified location).
export HF_HOME=${HF_HOME:-/home/devon7y/links/scratch/huggingface}
module load python/3.11 gcc/12.3 opencv/4.13.0 cuda/12.6
source "$WORKDIR/venv/bin/activate"

# Official Chroma code for the cross-check (isolated; never touches the venv).
# --no-deps keeps it from churning the production torch/transformers/etc.
# rapidfuzz sharpens the fallback locator; chunking_evaluation (best-effort, from
# PyPI not the wheelhouse) provides Chroma's own baseline chunkers when it imports.
# --no-deps keeps it from churning the production torch/transformers/etc.
echo "[$(date)] Installing rapidfuzz + chunking_evaluation into isolated $LIBS …"
pip install --no-input --no-deps --target="$LIBS" --index-url https://pypi.org/simple \
  rapidfuzz chunking_evaluation 2>&1 | tail -3 || \
  echo "[$(date)] official package install failed — run_eval.py will use replicated fallbacks"

export EMBED_MODEL_ID=${EMBED_MODEL_ID:-Qwen/Qwen3-Embedding-8B}
export EMBED_TORCH_DTYPE=${EMBED_TORCH_DTYPE:-bfloat16}
export EMBED_DEVICE=cuda
export EMBED_BATCH=${EMBED_BATCH:-32}
# MUST match scripts/server.py + pipeline/ingest.py (task-aware query instruction).
export EMBED_QUERY_INSTRUCTION=${EMBED_QUERY_INSTRUCTION:-"Given a question about scientific literature, retrieve relevant passages from academic papers that answer the question"}

# File names are overridable so multiple runs (e.g. CML set) don't clobber each other.
CORPUS=${CORPUS:-corpus.jsonl}
QA=${QA:-qa.jsonl}
OUT=${OUT:-results.json}
echo "[$(date)] Running chunk-size eval ($CORPUS / $QA → $OUT)…"
cd "$WORKDIR"
PYTHONPATH="$WORKDIR:$LIBS" python "$WORKDIR/scripts/chunk_eval/run_eval.py" \
  --corpus "$EVAL_DIR/$CORPUS" \
  --qa "$EVAL_DIR/$QA" \
  --out "$EVAL_DIR/$OUT"

echo "[$(date)] Done. Results: $EVAL_DIR/$OUT"
