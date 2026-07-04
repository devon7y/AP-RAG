# Canonical Ingest Parameters

**Current canonical set (2026-07-02):** the production TUNE values validated on the
2026-07-01 run (282 docs in 4 h, ~75 docs/hr, 0 failures, 0 OOM — Qwen3.6-35B-A3B
BF16 TP=2, in-process Qwen3-Embedding-8B). These are now **baked into the SLURM
scripts as defaults**, together with the efficiency knobs from
[INGEST_EFFICIENCY_OPEN_PROBLEMS.md](INGEST_EFFICIENCY_OPEN_PROBLEMS.md) — a plain
`sbatch job_westbury_ingest_v2_<cluster>.slurm` gets all of this with no `--export`.

## Parameters (SLURM-script defaults)

| Parameter | Value | Note |
| --- | --- | --- |
| `N_VLLM` | 1 (nibi/fir/ror), 3 (tril) | endpoints to wait for; extra vLLMs registered later are auto-adopted (`ENDPOINT_REFRESH_S`) |
| `PARALLEL_DOCS` | 24 | streaming mode: bounds concurrent PDF reads |
| `LLM_MAX_ASYNC` | 48 | extraction concurrency (LightRAG role queue) |
| `CONTEXT_MAX_ASYNC` | 48 | **now a true global cap** (was per-doc → ×MAX_PARALLEL_INSERT) |
| `EMBED_FUNC_MAX_ASYNC` | 2 | in-process 8B bf16 embedder OOMs ≥3 (98.5% VRAM measured) |
| `EMBED_BATCH` / `EMBEDDING_BATCH_NUM` | 64 / 128 | batch size is the embed throughput lever, not async |
| `MAX_PARALLEL_INSERT` | 24 | real document-level concurrency knob |
| `MAX_DOC_TOKENS` | 20000 | context-prompt doc cap |
| `LLM_TEMPERATURE` / `LLM_SEED` | 0.0 / 42 | deterministic → caches hit across restarts (P2) |
| `LLM_MAX_TOKENS` / `CONTEXT_MAX_TOKENS` | 4096 / 300 | no runaway decodes (P5) |
| `CONTEXT_CACHE` / `CONTEXT_WARM_FIRST` / `CONTEXT_AFFINITY` | 1 / 1 / 1 | blurb cache + prefix warm-up + per-doc endpoint pinning (P1/P2) |
| `KV_FLUSH_INTERVAL` | 300 | throttled ordered storage flush (P9); 0 = per-doc upstream |
| `STREAM_OVERLAP` | 1 | drain starts after the first enqueue batch (P8) |
| `MAX_GLEANING` | 1 | LightRAG default; `0` halves extraction LLM calls (quality A/B first) |
| `FORCE_LLM_SUMMARY_ON_MERGE` / `SUMMARY_MAX_TOKENS` | 8 / 1200 | LightRAG defaults; raising them cuts hub-entity re-summarization calls on a big corpus |

## Submission Command (Rorqual, single cycle — never chain)

```bash
rm -f /scratch/devon7y/westbury_rag/vllm_endpoints_westbury_qwen3_32b/*
VLLM1=$(sbatch --parsable --time=Xh:00:00 job_westbury_vllm_ror.slurm)
# optional second endpoint: VLLM2=$(sbatch --parsable ... job_westbury_vllm_ror.slurm)
# optional dedicated embedder (P4): EMB=$(sbatch --parsable ... job_westbury_embed.slurm)
sbatch --time=Xh:00:00 --dependency=after:$VLLM1 job_westbury_ingest_v2_ror.slurm
```

Defaults cover everything; override individual knobs only when experimenting, e.g.
`--export=ALL,VLLM_KV_CACHE_DTYPE=fp8` on the vLLM job or
`--export=ALL,MAX_PARALLEL_INSERT=32` on the ingest job.

## Defer-mode summarization (MANDATORY since 2026-07-03)

Every ingest cycle MUST export the three defer vars (they ride the standard TUNE):

```
FORCE_LLM_SUMMARY_ON_MERGE=1000000000
SUMMARY_MAX_TOKENS=1000000000
SUMMARY_CONTEXT_SIZE=1000000000
```

They turn OFF LightRAG's in-line entity/relation merge summaries (which reached ~45%
of extraction-side LLM calls by ~700 docs and capped throughput at ~15 docs/hr).
Merges become pure fragment concatenation; the one-time tidy-up runs at corpus end
via `scripts/finalize_summaries.py` (see INGEST_EFFICIENCY_OPEN_PROBLEMS.md §10).
Launching a cycle WITHOUT these silently reintroduces the rewrites. Validation
signal: `grep -c LLMmrg <ingest .err>` must stay 0 during ingest.

## Notes

- Always clean stale endpoint files before submitting vLLM jobs (the ingest also
  validates + deletes stale ones itself, and re-scans every `ENDPOINT_REFRESH_S`).
- Stranded `processing` docs are self-healed to `pending` at startup; failed
  extractions are skipped via the extract ledger (`RETRY_EXTRACT_FAILED=1` to retry).
- Tune against the `[VLLM]` status lines: target kv% ~60–80 with waiting≈0 and
  prefix_hit% high; see INGEST_EFFICIENCY_OPEN_PROBLEMS.md §7 for the full playbook.

## Historical

The pre-2026-07 canonical set (Trillium jobs 402010/405147: 32/32/32/16/16, 3×vLLM
Qwen3-32B FP8) is superseded by the table above.
