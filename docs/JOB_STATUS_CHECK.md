# Job Status Check — Westbury RAG Pipeline

Run these checks in order when asked to check job status. Report all findings.

---

## 1. SSH Connection

```bash
ssh -O check fir 2>&1; echo "exit:$?"
```

If exit code is non-zero, re-authenticate:

```bash
sshpass -P "Passcode" -f ~/.claude/hpc_passcode ssh -fN fir
```

If that fails, ask the user for a new passcode.

---

## 2. Queue Status

```bash
ssh fir "bash -l -c 'squeue -u devon7y --noheader -o \"%.10i %.20j %.8T %.10M %.10l %R\"'"
```

Report: job IDs, names, state (RUNNING/PENDING), elapsed time, walltime limit, and node.

If no jobs are running, say so and skip remaining checks.

Note the **ingest job ID** and **vLLM node hostname** — you need them for later steps.

---

## 3. Doc Status Snapshot

This is the most important check. It shows actual extraction state, not just job submission state.

```bash
ssh fir "TZ=America/Edmonton python3 -c \"
import json, collections
from pathlib import Path
from datetime import datetime
p = '/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/kv_store_doc_status.json'
d = json.loads(Path(p).read_text())
doc_only = {k:v for k,v in d.items() if k.startswith('doc-')}
dup_only = {k:v for k,v in d.items() if k.startswith('dup-')}
doc_counts = collections.Counter(v['status'] for v in doc_only.values())
dup_counts = collections.Counter(v['status'] for v in dup_only.values())
print('Updated:', datetime.fromtimestamp(Path(p).stat().st_mtime).isoformat())
print('Doc total:', len(doc_only))
print('Doc statuses:', dict(doc_counts))
print('Dup total:', len(dup_only))
print('Dup statuses:', dict(dup_counts))
\""
```

Report:
- `doc-*` processed, processing, pending, failed counts
- `dup-*` counts separately
- `kv_store_doc_status.json` mtime

**Key interpretation:**
- `doc-*` entries are the real paper-processing records.
- `dup-*` entries are duplicate-tracking records. Treat them separately from real extraction failures.
- Empty PDFs never enter `doc_status`, so `Doc total` can be lower than the PDF count.
- On resumed runs, compare `processed` against the start-of-run baseline from Step 4, not just against zero.
- `processed` increasing over time = pipeline is working.
- `processed` unchanged and `doc_status` mtime not moving over repeated checks = pipeline is stalled.
- `processing` should be a small number (1–8). If it equals `MAX_PARALLEL_INSERT`, that's normal.
- `failed > 0` in `doc-*` = check real failed doc errors (Step 6).

---

## 4. Ingest Log Check

Replace `<INGEST_JOB_ID>` with the ingest job ID from Step 2.

```bash
ssh fir "head -40 /home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_<INGEST_JOB_ID>.out"
```

```bash
ssh fir "rg -n '\[STATUS\]|already known|✓|✗|Empty — skipping' /home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_<INGEST_JOB_ID>.out | tail -80"
```

```bash
ssh fir "tail -30 /home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_<INGEST_JOB_ID>.out"
```

Look for:
- The log header's initial `Current doc status:` block. This is the start-of-run baseline for resumed jobs.
- `[STATUS]` lines — these show the current `doc_status` snapshot, but the rate is based on cumulative `processed` count already on disk.
- `✓` lines — `await rag.ainsert(...)` returned without exception for that PDF. This is stronger than simple enqueueing, but Step 3 is still the source of truth for final `processed` counts.
- `already known — skipping` — the script hashed the PDF text and found an existing `processed`/`pending`/`processing` doc ID. This is scan progress, not extraction progress.
- `✗` lines — immediate per-file failures printed by the wrapper script.
- `⚠ Empty — skipping` — harmless, PDF had no extractable text
- `last_progress` near the end of the corpus with no new `✓` lines means the job scanned files without making forward progress.

**Red flags:**
- Log is dominated by `already known — skipping` lines.
- No `✓` lines after 20-30 min.
- `processed` in `[STATUS]` never exceeds the baseline from the log header.
- `rate` can look healthy on resumed runs even when no new docs are being processed. Do not trust `rate` by itself.

---

## 5. Error Log Check

Replace `<INGEST_JOB_ID>` with the ingest job ID from Step 2.

```bash
ssh fir "rg -ni '✗|Traceback|Exception|APIConnectionError|Connection error|CUDA out of memory|Worker execution timeout|execution timeout|Stream has ended unexpectedly|Task forcefully terminated' \
  /home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_<INGEST_JOB_ID>.out \
  /home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_<INGEST_JOB_ID>.err | tail -40"
```

**Common errors and meaning:**
- `LLM func: Worker execution timeout` — single doc took too long, will be retried
- `Embedding func: Task forcefully terminated due to execution timeout` — embedding OOM or timeout
- `CUDA out of memory` — reduce `EMBED_FUNC_MAX_ASYNC`
- `Connection error` / `APIConnectionError` — vLLM crashed, check vLLM log
- `Content already exists` — duplicate PDFs in corpus, harmless
- `pypdf` warnings — harmless PDF parsing warnings

Notes:
- Real per-file failures can appear in the `.out` log, not only in `.err`.
- `.err` is often mostly `pypdf` warnings. Do not treat that alone as pipeline failure.
- If Step 3 shows failed docs but the logs are quiet, inspect `error_msg` in Step 6.

---

## 6. Failed Doc Errors

Only run if Step 3 showed any `doc-*` or `dup-*` failures:

```bash
ssh fir "python3 -c \"
import json, collections
d = json.loads(open('/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/kv_store_doc_status.json').read())
doc_failed = [v for k, v in d.items() if k.startswith('doc-') and v.get('status') == 'failed']
dup_failed = [v for k, v in d.items() if k.startswith('dup-') and v.get('status') == 'failed']
print('doc_failed:', len(doc_failed))
print('dup_failed:', len(dup_failed))
if not doc_failed:
    print('No failures')
else:
    errs = collections.Counter(v.get('error_msg','(none)')[:120] for v in doc_failed)
    for msg, n in errs.most_common(10):
        print(f'{n}x {msg}')
\""
```

Entries starting with `dup-` and saying `Content already exists` are duplicate-tracking records, not real extraction failures.

---

## 7. vLLM Health and GPU Utilization

Replace `<VLLM_NODE>` with the vLLM node hostname from Step 2 (e.g., `fc10506`).
The vLLM port is **8001**.

```bash
ssh fir "curl -s --max-time 5 http://<VLLM_NODE>:8001/metrics 2>/dev/null | grep -E 'vllm:num_requests_(running|waiting)\{|vllm:kv_cache_usage_perc\{|vllm:request_success_total.*finished_reason'"
```

**Key metrics:**
- `num_requests_running` — active LLM requests. Should be > 0 when pipeline is working. 0 = GPU idle.
- `num_requests_waiting` — queued requests. > 0 means vLLM is saturated (good).
- `kv_cache_usage_perc` — KV cache usage (0.0–1.0). Target: 0.3–0.8. Above 0.8 = near saturation. 0.0 = GPU idle.
- `request_success_total{finished_reason="stop"}` — total completed requests (cumulative)

**Interpretation:**
- `running: 0, waiting: 0, cache: 0.0` = GPU completely idle. Pipeline is stuck or between batches.
- `running: 1–4, waiting: 0, cache: < 0.3` = GPU underutilized. Could increase `MAX_PARALLEL_INSERT` or `LLM_MAX_ASYNC`.
- `running: 4+, waiting: > 0, cache: 0.5–0.8` = GPU well-utilized. Good.
- `running: 4+, waiting: > 10, cache: > 0.8` = GPU saturated. May need to reduce parallelism or add another GPU.

Note:
- The ingest script sends one startup test prompt (`Reply with exactly: OK`). `request_success_total=1` with otherwise idle metrics usually means only the startup probe ran.

---

## 8. Stuck Pipeline Detection

The pipeline is **stuck** if ALL of these are true after 20-30 minutes of runtime:
1. `doc-* processed` in Step 3 is not increasing relative to the Step 4 baseline or a repeat check.
2. `kv_store_doc_status.json` mtime in Step 3 is not moving.
3. Step 4 is dominated by `already known — skipping` lines or has no new `✓` lines.
4. Step 7 shows `num_requests_running: 0`, `num_requests_waiting: 0`, and `kv_cache_usage_perc: 0.0`.
5. `request_success_total` is still `1` or otherwise not increasing beyond the startup probe.

**If stuck:** Report it to the user and suggest cancelling. Do NOT cancel without asking.

Common causes:
- Resume-state mismatch: many docs are already marked `pending`/`processing`, so the wrapper skips files while LightRAG does no new work.
- Async deadlock from high parallelism settings (fix: reduce `MAX_PARALLEL_INSERT`)
- vLLM crashed (fix: check vLLM error log)
- Embedding worker stuck (fix: reduce `EMBED_FUNC_MAX_ASYNC`)

---

## Summary Template

Report findings in this format:

```
**Queue:** [job states and elapsed times]
**Doc Status:** [processed now] docs processed (delta [+/0/-] since start), [pending] pending, [processing] processing, doc_status updated [timestamp]
**Log:** [last_progress], [already_known] already-known skips, [✓] returned, [✗] failures
**Failures:** [doc_failed] real doc failures, [dup_failed] duplicate-tracking failures ([brief cause])
**GPU:** KV cache [X]%, [N] running, [M] waiting, request_success_total [T]
**Status:** [Working / Stuck / Completed / Error]
```

---

## Current Settings Reference

These are the SLURM defaults (may be overridden at submission time):

| Setting | Value |
|---|---|
| `MAX_PARALLEL_INSERT` | 8 |
| `LLM_MAX_ASYNC` | 32 |
| `CONTEXT_MAX_ASYNC` | 32 |
| `EMBED_FUNC_MAX_ASYNC` | 1 |
| `MAX_DOC_TOKENS` | 20000 |
| vLLM model | Qwen/Qwen3-32B (FP8) |
| vLLM port | 8001 |
| Embedding model | Octen/Octen-Embedding-8B-INT8 |
| Storage | `rag_storage_westbury_qwen3_32b` |
| Papers | `papers/` (1316 PDFs) |
| Endpoints | `vllm_endpoints_westbury_qwen3_32b/` |
