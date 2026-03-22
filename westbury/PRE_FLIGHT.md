# Pre-Flight Checklist — Westbury/CML Ingest Jobs

Run these checks before submitting any ingest or vLLM job.

---

## 1. Storage — Duplicate / Stale Doc Entries

Duplicate entries accumulate when the same PDF is ingested across runs that used different
`MAX_DOC_TOKENS` values (each truncation produces different text → different MD5 hash → new
doc entry). Each failed run compounds this.

```bash
ssh fir "python3 -c \"
import json, collections
with open('/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/kv_store_doc_status.json') as f:
    docs = json.load(f)
counts = collections.Counter(v['status'] for v in docs.values())
print('Total entries:', len(docs))
print('Status breakdown:', dict(counts))
\""
```

**Healthy:** total entries ≈ number of PDFs (≤ 1316 for Westbury).
**Red flag:** total entries >> paper count — e.g. 3000 for 1316 papers means ~2x duplicates.

**To clean for `rag_storage_westbury_qwen3_32b`:** wipe both files and start fresh.
`dedup_doc_status.py` is hardcoded for `rag_storage_octen` / `MAX_DOC_TOKENS=120_000` only.

```bash
ssh fir "python3 -c \"
import json
from pathlib import Path
s = Path('/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b')
for name in ('kv_store_doc_status.json', 'kv_store_full_docs.json'):
    p = s / name
    if p.exists():
        p.with_suffix('.json.bak').write_text(p.read_text())
        json.dump({}, open(p, 'w'))
        print(name, 'wiped')
\""
```

**WARNING:** Never reset `failed → pending` without first diagnosing *why* they failed
(see check 12). If failures are `'Content already exists'`, resetting status does nothing —
the duplicates must be wiped. If failures are API errors, diagnose vLLM first.

**Prefer targeted reset over full wipe.** If the processed docs are healthy and only the
failed ones need to be retried, reset just the failed entries rather than wiping storage:

```bash
ssh fir "python3 -c \"
import json
from pathlib import Path
p = Path('/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/kv_store_doc_status.json')
d = json.loads(p.read_text())
reset = sum(1 for v in d.values() if v.get('status') == 'failed')
for v in d.values():
    if v.get('status') == 'failed':
        v['status'] = 'pending'
p.write_text(json.dumps(d))
print(f'Reset {reset} failed -> pending')
\""
```

Only wipe storage if: (a) settings changed (different `MAX_DOC_TOKENS`, `contextualize_chunks`, etc.)
or (b) failures are `'Content already exists'` (duplicate entries, reset won't help).

---

## 2. Paper Count

```bash
ssh fir "ls /home/devon7y/scratch/devon7y/westbury_rag/papers/ | wc -l"
```

Expected: **1316** for Westbury, check CML separately.
If count differs, check for accidental deletions or new additions before starting a run.

---

## 3. vLLM Endpoint Files

Stale endpoint files from previous (dead) vLLM jobs will cause the ingest to connect to
a dead server and time out on every request.

```bash
ssh fir "ls -la /home/devon7y/scratch/devon7y/westbury_rag/vllm_endpoints_westbury_qwen3_32b/"
```

Cross-check each file's job ID against running jobs:

```bash
ssh fir "bash -l -c 'squeue -u devon7y --noheader -o \"%.10i %.12j %.8T\"'"
```

**Action:**
- If the vLLM job IS running → keep its endpoint file, do not clear.
- If the vLLM job is NOT running → delete its endpoint file before submitting ingest.

**Warning: `trap cleanup` does not reliably fire on `scancel`.** SLURM sends SIGTERM
then SIGKILL with a short grace period. If the job is killed before the trap runs, the
endpoint file is left behind. Always manually check and clean the endpoint directory
before every submission — do not rely on the trap alone.

---

## 4. Job Submission — vLLM and Ingest Must Run Concurrently

The ingest needs a live vLLM for every LLM call throughout its entire run. If the vLLM
expires or hasn't started yet, all documents silently fail.

**Always submit them together using a job dependency:**

```bash
cd /home/devon7y/scratch/devon7y/westbury_rag

VLLM_JOB=$(sbatch --parsable job_westbury_vllm.slurm)
echo "vLLM: $VLLM_JOB"

sbatch --dependency=after:$VLLM_JOB job_westbury_ingest.slurm
```

`--dependency=after:$VLLM_JOB` means the ingest won't start until the vLLM job has begun
running (node allocated). The ingest then waits up to 60 min for the endpoint file to appear
before proceeding, giving the vLLM time to load the model.

**Walltime alignment:** vLLM walltime must be ≥ ingest walltime. Both are currently `10:00:00`.
If the ingest might run long, increase vLLM walltime first.

---

## 5. vLLM Health Check + Model Name Verification

**Critical:** the model name the ingest script sends MUST match what the vLLM is actually serving.
The `--served-model-name` alias in the vLLM SLURM script is **not respected by vLLM nightly** —
the real model name is always returned. Always verify before submitting ingest:

```bash
# What name is the vLLM actually serving?
ssh fir "curl -s http://<NODE>:8000/v1/models | python3 -m json.tool"
# e.g. returns: "id": "Qwen/Qwen3.5-27B-FP8"
```

Then confirm `LLM_MODEL` in `ingest_cml_octen.py` matches that id exactly.

```bash
# Check recent log lines
ssh fir "tail -5 /home/devon7y/scratch/devon7y/westbury_rag/logs/vllm_fp8_<JOB_ID>.out"
```

Look for:
- `200 OK` responses
- Non-zero token throughput (`Avg generation throughput: N tokens/s`)
- KV cache % (should be < 80%; high % = vLLM near saturation)

Red flags:
- `CUDA out of memory`
- `Worker execution timeout`
- `FlashAttention` import errors (fix: ensure `--enable-chunked-prefill=False`)
- `404 - model does not exist` → model name mismatch, ingest will silently fail everything

---

## 6. Ingest Parallelism Settings

**LightRAG 1.4.x uses a single pipeline worker.** Regardless of `PARALLEL_DOCS`, only one
`apipeline_process_enqueue_documents` worker runs at a time (global asyncio lock). All
concurrent `ainsert()` calls beyond the first just set `request_pending=True` and return
immediately. The single worker processes all pending docs with `max_parallel_insert=2`.

This means `PARALLEL_DOCS` only controls PDF reading and submission parallelism, not
entity extraction. Keep it low (4) to avoid event loop contention.

**Single-GPU settings (current):**

| Setting | Value | Notes |
| --- | --- | --- |
| `PARALLEL_DOCS` | 4 | PDF read/submit concurrency only |
| `LLM_MAX_ASYNC` | 8 | Max concurrent LLM calls to vLLM |
| `contextualize_chunks` | False | See check 13 — leave off for single GPU |
| `embedding_func_max_async` | **1** | See check 15 — must be 1 on shared GPU |
| `MAX_DOC_TOKENS` | 20000 | See check 13 |

**Multi-GPU settings (original 64-node array):**

| Setting | Value | Notes |
| --- | --- | --- |
| `PARALLEL_DOCS` | 20 | |
| `LLM_MAX_ASYNC` | 128 | ~2 per GPU node |
| `contextualize_max_async` | 128 | |

Monitor KV cache %. If consistently < 20%, increase `LLM_MAX_ASYNC`. If > 70%, decrease.

---

## 7. Walltime vs. Remaining Work

Estimate whether the walltime is sufficient:

```bash
ssh fir "python3 -c \"
import json, collections
with open('/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/kv_store_doc_status.json') as f:
    docs = json.load(f)
counts = collections.Counter(v['status'] for v in docs.values())
remaining = counts.get('pending', 0) + counts.get('failed', 0)
print(f'Remaining: {remaining}')
print(f'At 60/hr (5x target): {remaining/60:.1f}h needed')
print(f'At 12/hr (baseline):  {remaining/12:.1f}h needed')
\""
```

Current walltime: **10h** (`job_ingest_westbury_fp8.slurm`).
Max walltime on Fir: **7 days**.

---

## 8. SLURM Queue — Node Availability

Check for scheduling problems before submitting:

```bash
ssh fir "bash -l -c 'sinfo -p gpu --noheader | head -10'"
```

If nodes are showing `drain` or `down`, check Alliance status:

```bash
curl -s https://status.alliancecan.ca/system/Fir/feed.rss | grep -A3 "<title>"
```

---

## 9. Storage Space

```bash
ssh fir "df -h /home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/"
```

The vector DB files (`vdb_*.json`, `kv_store_full_docs.json`) grow large as papers are
ingested. The full 1316-paper run is estimated at ~5–10 GB total storage.

---

## 10. LLM Cache Size

The LLM response cache (`kv_store_llm_response_cache.json`) grows with every extraction.
This is useful for resuming, but check it isn't abnormally large (sign of repeated failures
being cached):

```bash
ssh fir "ls -lh /home/devon7y/scratch/devon7y/westbury_rag/rag_storage_octen/kv_store_llm_response_cache.json"
```

---

## 11. Post-Submit — First 10 Minutes

After submitting the ingest job, watch the log for the first signs of activity:

```bash
ssh fir "tail -f /home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_<JOB_ID>.out"
```

Expected sequence:
1. `Packages installed` (pip setup, ~3–5 min)
2. `Embedding model ready` (Octen loads on GPU, ~1 min)
3. `Discovered 1 vLLM endpoint(s)` (finds the running vLLM)
4. `[ep] → OK` (LLM connectivity test passes)
5. First `✓ Ingested` lines appearing, 20 concurrent

If stuck at step 3 for > 5 min, the endpoint file is missing or the vLLM is down.

---

## 12. Post-Run — Verify Actual Completion

**WARNING:** `✓` marks in the ingest log mean `ainsert()` returned without raising an exception.
They do NOT mean entity extraction succeeded. LightRAG's pipeline swallows LLM failures
internally, marks the doc as `failed` in `kv_store_doc_status.json`, and lets the caller
return cleanly. A run showing `Succeeded: 1289` can have `0` truly processed docs.

**Step 1 — Check doc_status counts:**

```bash
ssh fir "python3 -c \"
import json, collections
path = '/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/kv_store_doc_status.json'
docs = json.load(open(path))
print('Total entries:', len(docs))
print(dict(collections.Counter(v['status'] for v in docs.values())))
\""
```

**Step 2 — Check graph mtime (must be recent):**

```bash
ssh fir "ls -lh /home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/graph_chunk_entity_relation.graphml"
```

If the graph mtime hasn't changed since before the job ran, nothing was truly processed.

**Step 3 — Diagnose failures by reading error_msg:**

```bash
ssh fir "python3 -c \"
import json, collections
docs = json.load(open('/home/devon7y/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/kv_store_doc_status.json'))
failed = [v for v in docs.values() if v['status'] == 'failed']
cats = collections.Counter(v.get('error_msg','(none)')[:60] for v in failed)
for msg, n in cats.most_common(10):
    print(n, repr(msg))
\""
```

**Interpreting error_msg:**

- `'Content already exists'` → duplicate doc entries. Wipe storage and resubmit (see check 1). Resetting failed→pending will NOT help.
- `'Connection error'` / `'APIConnectionError'` → vLLM crashed. Check vLLM log for cause before resubmitting.
- `'at least N input tokens'` / `'maximum context length'` → prompt too long. Reduce `MAX_DOC_TOKENS` or check `contextualize_chunks` (see check 13).
- `'Document content not found'` → stale doc_status entry with no matching full_docs entry. Wipe and restart.

---

## 13. vLLM: max_model_len Must Not Exceed Model's RoPE Limit

**Critical.** The model's actual positional encoding limit is in `config.json` as
`max_position_embeddings`. Sequences beyond this cause RoPE out-of-bounds → CUDA
device-side assert in FlashAttention3 → entire vLLM engine dies, all subsequent requests
fail with `Connection error`.

Qwen3-32B: `max_position_embeddings = 40960`. Use `--max-model-len 36000` (buffer).
Do NOT use `VLLM_ALLOW_LONG_MAX_MODEL_LEN=1` to exceed this — it bypasses the check
but does not fix the underlying crash.

Check what vLLM actually reports at startup:

```text
Maximum concurrency for N tokens per request: X.XXx
```

If X < 1.5, the KV cache can barely fit 1 request — increase `--gpu-memory-utilization`
or decrease `--max-model-len`.

---

## 14. contextualize_chunks and MAX_DOC_TOKENS

**`contextualize_chunks=True` is required.** This is not optional — disabling it produces
a lower-quality knowledge graph. Always verify it is `True` in `ingest_cml_octen.py` before
submitting.

When `contextualize_chunks=True`, LightRAG sends the **full document** as context for
every chunk before entity extraction. This creates prompts of roughly
`doc_size + chunk_size + template_overhead` and roughly doubles total LLM call volume.

**Tokenizer mismatch hazard:** `MAX_DOC_TOKENS` is counted in tiktoken `cl100k_base` tokens,
but vLLM uses the model's own tokenizer. For Qwen3-32B, 1 cl100k token ≈ 1.3–1.4 Qwen3
tokens for English academic text. A 25,000 cl100k document ≈ 33,000+ Qwen3 tokens.

Set `MAX_DOC_TOKENS` conservatively:

```text
MAX_DOC_TOKENS × 1.4 + chunk_token_size × 1.4 + template_tokens < max_model_len
```

For `max_model_len=36000` and `chunk_token_size=1200`: `MAX_DOC_TOKENS ≤ ~23000 cl100k`.
**Current setting: `MAX_DOC_TOKENS=20000`** (safe margin).

**KV cache impact:** Contextualization prompts are ~28K Qwen3 tokens each. vLLM at
`--gpu-memory-utilization 0.90` on a dedicated H100 has ~38 GB KV cache → roughly 4–5
concurrent contextualization requests at a time. Set `CONTEXT_MAX_ASYNC=16` to keep
vLLM's queue fed without OOM.

---

## 15. embedding_func_max_async Must Be 1 on a Shared GPU

**Critical for single-GPU runs where vLLM and Octen share the same H100.**

`embedding_func_max_async=N` allows N concurrent calls to the embedding function.
Each call runs `model.encode()` in a thread pool executor. Because PyTorch's caching
allocator does not release activation tensors until the call returns, N concurrent calls
means N × activation_memory coexist on GPU simultaneously.

For Octen-8B-INT8 with batch_size=16: ~2 GiB activations per call.

- `embedding_func_max_async=4`: 4 × 2 GiB = 8 GiB activations + 8 GiB model = ~16 GiB
- `embedding_func_max_async=1`: 1 × 2 GiB = 2 GiB activations + 8 GiB model = ~10 GiB

With vLLM at 0.65 gpu-util (~55 GiB PyTorch + ~4 GiB CUDA overhead = ~59 GiB):

- `embedding_func_max_async=4`: 59 + 16 = 75 GiB → only 4 GiB headroom → OOM
- `embedding_func_max_async=1`: 59 + 10 = 69 GiB → 10 GiB headroom → safe

**Current setting:** `EMBED_FUNC_MAX_ASYNC=1` (env var in job script).

Also set `export PYTORCH_ALLOC_CONF=expandable_segments:True` before the ingest to
allow PyTorch to return fragmented memory to CUDA.

**Red flag:** All failures have `error_msg = 'CUDA out of memory'` after the first N
docs succeed. Means embedding OOM, not vLLM. Fix: reduce `embedding_func_max_async`.
Safe to reset these failures → pending (unlike "Content already exists").

---

## 16. GPU Saturation — Findings

**The real bottleneck is `MAX_PARALLEL_INSERT`, not vLLM capacity.**

Early runs with `MAX_PARALLEL_INSERT=2` (LightRAG default) kept vLLM at 20–25% KV cache
utilization with ~12 concurrent requests. The GPU was mostly idle. Throughput: ~14 docs/hr.
Adding more vLLM nodes or a second GPU at this stage would have done nothing.

The pipeline worker is the gate: `MAX_PARALLEL_INSERT` controls how many documents go
through entity extraction simultaneously, which determines how many LLM requests are
generated. vLLM will only be as busy as the pipeline feeds it.

**With `contextualize_chunks=True`:** prompts grow to ~28K tokens, so fewer requests fit
in KV cache simultaneously. This makes it easier to saturate vLLM at lower `MAX_PARALLEL_INSERT`
values. `MAX_PARALLEL_INSERT=8` + `CONTEXT_MAX_ASYNC=16` + `LLM_MAX_ASYNC=32` should keep
the KV cache well-loaded.

**Current target settings (2-GPU split, contextualize_chunks=True):**

| Setting | Value | Notes |
| --- | --- | --- |
| `MAX_PARALLEL_INSERT` | 8 | Pipeline worker concurrency |
| `LLM_MAX_ASYNC` | 32 | Entity extraction (short prompts) |
| `CONTEXT_MAX_ASYNC` | 16 | Contextualization (long prompts, KV-cache limited) |
| `EMBED_FUNC_MAX_ASYNC` | 4 | Octen on dedicated MIG, no vLLM contention |
| `MAX_DOC_TOKENS` | 20000 | Safe under 36K Qwen3 token limit |

**To diagnose saturation:** watch the vLLM log for `GPU KV cache usage`. Target: 60–80%.

- Below 50%: increase `MAX_PARALLEL_INSERT` or `CONTEXT_MAX_ASYNC`
- Above 80% with `Waiting: N reqs > 0` consistently: consider a second vLLM GPU
