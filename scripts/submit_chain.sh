#!/bin/bash
# submit_chain.sh — self-chaining ingest cycles on Nibi (replaces any external babysit).
# Each cycle = 2 vLLM (2xH100) + 1 ingest (1xH100) with the staged improvements
# (prefix caching in the vLLM script + resume-skip + tuned concurrency). Cycles run
# strictly sequentially via SLURM dependencies:
#   - cycle i's vLLM start after cycle i-1's ingest ENDS (afterany)
#   - cycle i's ingest starts after its own vLLM START and after cycle i-1's ingest ENDS
# The ingest self-heals (resets stranded in-flight -> pending) at startup and, with
# CHAIN_SELFTERMINATE=1, cancels the rest of the chain once 0 docs remain — so no dead
# cycle ever burns vLLM walltime. Stale endpoint files are auto-evicted by the ingest's
# endpoint validation, so no manual clearing is needed between cycles.
#
#   bash submit_chain.sh [N_CYCLES] [AFTER_JOBID]
#     N_CYCLES     cycles to chain (default 6; self-terminate kills the unused tail)
#     AFTER_JOBID  gate cycle 1 on this job ending (e.g. the currently-running ingest)
set -eu
cd "$(cd "$(dirname "$0")" && pwd)"

N=${1:-6}
AFTER=${2:-}
WALLTIME=${3:-03:00:00}
CLUSTER=${4:-nibi}   # selects job_westbury_{vllm,ingest_v2}_${CLUSTER}.slurm
# Nibi and Rorqual share WORKDIR=/scratch/devon7y/westbury_rag; the only per-cluster
# difference is HF_HOME (baked into each cluster's slurm scripts), so this same chain
# logic works on either — just pass the suffix. Fir uses a different WORKDIR.
# Concurrency: MAX_PARALLEL_INSERT=16 — the proven-healthy value (104/hr, 0 failures).
# Above ~16-20 the ingest's connections to the vLLM endpoints fail (APIConnectionError →
# RetryError → doc failed): 32 failed hundreds, 96 failed ~9k. Speed comes from prefix
# caching (84% hit on the 20k contextualization prefill) + resume-skip, NOT concurrency.
TUNE="N_VLLM=2,PARALLEL_DOCS=24,LLM_MAX_ASYNC=32,CONTEXT_MAX_ASYNC=32,EMBED_FUNC_MAX_ASYNC=16,MAX_PARALLEL_INSERT=16,MAX_DOC_TOKENS=20000,STORAGE_SUBDIR=rag_storage_full,QDRANT_SUBDIR=qdrant_storage_full,PAPERS_SUBDIR=papers_full,EMBED_MODEL_ID=Qwen/Qwen3-Embedding-8B,EMBEDDING_DIM=4096,ENQUEUE_BATCH=512,CHAIN_SELFTERMINATE=1"

prev=$AFTER
for i in $(seq 1 "$N"); do
  if [ -n "$prev" ]; then vdep="--dependency=afterany:$prev"; else vdep=""; fi
  v1=$(sbatch --parsable --time=$WALLTIME $vdep job_westbury_vllm_${CLUSTER}.slurm)
  v2=$(sbatch --parsable --time=$WALLTIME $vdep job_westbury_vllm_${CLUSTER}.slurm)
  idep="--dependency=after:$v1:$v2"
  [ -n "$prev" ] && idep="$idep,afterany:$prev"
  ing=$(sbatch --parsable --time=$WALLTIME --mem=64G --cpus-per-task=12 $idep --export=ALL,$TUNE job_westbury_ingest_v2_${CLUSTER}.slurm)
  echo "cycle $i: vllm=$v1,$v2 ingest=$ing (after prev=${prev:-none})"
  prev=$ing
done
echo "chain of $N cycles submitted; self-terminates when the corpus is done."
