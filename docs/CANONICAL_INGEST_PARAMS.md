# Canonical Ingest Parameters

These are the parameters from the successful Trillium 10h/12h runs (jobs 402010, 405147)
that processed ~200+ docs per run. Use these for all future ingest jobs.

## Parameters

| Parameter | Value |
|---|---|
| `N_VLLM` | 3 |
| `PARALLEL_DOCS` | 32 |
| `LLM_MAX_ASYNC` | 32 |
| `CONTEXT_MAX_ASYNC` | 32 |
| `EMBED_FUNC_MAX_ASYNC` | 16 |
| `MAX_PARALLEL_INSERT` | 16 |
| `MAX_DOC_TOKENS` | 20000 |

## Submission Command (Rorqual)

```bash
rm -f /scratch/devon7y/westbury_rag/vllm_endpoints_westbury_qwen3_32b/*
VLLM1=$(sbatch --parsable --time=Xh:00:00 job_westbury_vllm_ror.slurm)
VLLM2=$(sbatch --parsable --time=Xh:00:00 job_westbury_vllm_ror.slurm)
VLLM3=$(sbatch --parsable --time=Xh:00:00 job_westbury_vllm_ror.slurm)
sbatch --time=Xh:00:00 --dependency=after:$VLLM1:$VLLM2:$VLLM3 \
  --export=ALL,N_VLLM=3,PARALLEL_DOCS=32,LLM_MAX_ASYNC=32,CONTEXT_MAX_ASYNC=32,EMBED_FUNC_MAX_ASYNC=16,MAX_PARALLEL_INSERT=16,MAX_DOC_TOKENS=20000 \
  job_westbury_ingest_v2_ror.slurm
```

## Notes

- Always clean pending/processing entries before resubmitting
- Always clear stale endpoint files before submitting vLLM jobs
- `PARALLEL_DOCS=32` was confirmed working on Trillium; monitor first Rorqual run for deadlocks
