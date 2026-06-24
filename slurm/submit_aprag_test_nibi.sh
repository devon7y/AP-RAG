#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# 3-H100 APRAG test ingest on Nibi  —  DO NOT RUN UNTIL PRECONDITIONS ARE MET
# ─────────────────────────────────────────────────────────────────────────────
# Submits two jobs = 3 H100s total:
#   1) vLLM server : Qwen3.6-35B-A3B (BF16 MoE, TP=2) -> 2x H100, 1 endpoint
#   2) ingest job  : Qwen3-Embedding-8B               -> 1x H100   (N_VLLM=1)
#
# Writes FRESH storage:  rag_storage_aprag/  +  qdrant_storage_aprag/
# (April's rag_storage_westbury_qwen3_32b is left untouched.)
#
# PRECONDITIONS:
#   [DONE] venv built (job_setup_env_nibi.slurm)
#   [DONE] models in hf_cache (Qwen3.6-35B-A3B 67G, Qwen3-Embedding-8B 15G)
#   [DONE] fresh rag_storage_aprag/ + qdrant_storage_aprag/ exist
#   [TODO] finalized Papers staged at  $WORKDIR/papers/  (replace old contents)
#
# Override walltime with:  WALL=06:00:00 bash submit_aprag_test_nibi.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd /scratch/devon7y/westbury_rag

WALL="${WALL:-04:00:00}"
ENDPOINTS_DIR=vllm_endpoints_westbury_qwen3_32b

# Clear stale vLLM endpoint files from any previous run
rm -f "$ENDPOINTS_DIR"/* 2>/dev/null || true

# 1) vLLM server (2x H100). Registers its endpoint when ready.
VLLM=$(sbatch --parsable --time="$WALL" job_westbury_vllm_nibi.slurm)
echo "vLLM   job: $VLLM   (2x H100, Qwen3.6-35B-A3B TP=2)"

# 2) Ingest (1x H100). Starts once vLLM is RUNNING, then polls for the healthy
#    endpoint itself (N_VLLM=1). Writes rag_storage_aprag + qdrant_storage_aprag.
ING=$(sbatch --parsable --time="$WALL" --dependency=after:"$VLLM" \
  --export=ALL,N_VLLM=1 \
  job_westbury_ingest_v2_nibi.slurm)
echo "ingest job: $ING   (1x H100, depends on $VLLM)"

echo
echo "Submitted 3-H100 test ingest. Monitor with:"
echo "  squeue -u devon7y"
echo "  tail -f logs/westbury_vllm_${VLLM}.out"
echo "  tail -f logs/westbury_ingest_${ING}.out"
