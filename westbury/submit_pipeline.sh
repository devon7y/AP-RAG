#!/bin/bash
# Submit the Westbury parallel RAG pipeline.
#
# Usage: bash westbury/submit_pipeline.sh [N_VLLM]
#   N_VLLM: number of vLLM nodes (default: 3)

N_VLLM=${1:-3}
WORKDIR=/home/devon7y/scratch/devon7y/westbury_rag

echo "Submitting Westbury parallel RAG pipeline ($N_VLLM vLLM nodes)..."

# Clean up any stale endpoint files from previous runs
ssh fir "mkdir -p $WORKDIR/{logs,vllm_endpoints,rag_storage} && \
  rm -f $WORKDIR/vllm_endpoints/*.txt && \
  echo 'Working directories ready.'"

# Upload scripts to HPC
rsync -avz \
  westbury/job_vllm.slurm \
  westbury/job_ingest_parallel.slurm \
  ingest_westbury_parallel.py \
  fir:$WORKDIR/

# Update N_VLLM in the ingest job to match the array size
ssh fir "sed -i 's/^N_VLLM=.*/N_VLLM=$N_VLLM/' $WORKDIR/job_ingest_parallel.slurm"

# Submit vLLM array job
JOB_VLLM=$(ssh fir "cd $WORKDIR && sbatch --array=1-${N_VLLM} --parsable job_vllm.slurm")
echo "vLLM array job:   $JOB_VLLM (tasks 1-$N_VLLM)"

# Submit ingestion job — starts once any vLLM task has begun running
# (the ingest script waits internally for all N endpoints to register)
JOB_INGEST=$(ssh fir "cd $WORKDIR && sbatch --parsable --dependency=after:${JOB_VLLM} job_ingest_parallel.slurm")
echo "Ingestion job:    $JOB_INGEST"

echo ""
echo "Pipeline submitted. Monitor with:"
echo "  ssh fir 'squeue -u devon7y'"
echo ""
echo "Watch ingestion progress:"
echo "  ssh fir 'tail -f $WORKDIR/logs/ingest_${JOB_INGEST}.out'"
