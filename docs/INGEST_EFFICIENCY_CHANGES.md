# Ingest Efficiency Changes — Complete Inventory

**Date:** 2026-07-02 (two efficiency passes + the vLLM TP-hang fix package, same day).
**Scope:** ingestion only (`pipeline/`, `slurm/`). All changes are **wrapper-side**
— nothing under `LightRAG/` was edited (the patch-free rule holds).
**Problem statements:** [INGEST_EFFICIENCY_OPEN_PROBLEMS.md](INGEST_EFFICIENCY_OPEN_PROBLEMS.md)
(P1–P8 from the 2026-07-01 validation session; P9–P12 found during the code review).
**Baseline to beat:** ~75 docs/hr (282 docs / 4 h, 2× vLLM, 0 failures).
**Current canonical params:** [CANONICAL_INGEST_PARAMS.md](CANONICAL_INGEST_PARAMS.md).

Every change is env-gated with defaults baked into the SLURM scripts; override any
knob at submit time with `--export=ALL,VAR=value`. Chunk size is **settled at
`CHUNK_TARGET_TOKENS=512`** (owner decision; the "512-vs-800 A/B" in older notes
is stale — 800 was an old configuration).

---

## 1. LLM-call efficiency (the dominant cost)

| Change | Problem | Where | Knob (default) |
| --- | --- | --- | --- |
| Deterministic sampling | P2 | `pipeline/ingest.py` `llm_func` | `LLM_TEMPERATURE` (0.0), `LLM_SEED` (42) |
| Global `max_tokens` cap | P5 | same | `LLM_MAX_TOKENS` (4096) |
| Blurb `max_tokens` cap | P5 | contextualizer `llm_kwargs` | `CONTEXT_MAX_TOKENS` (300) |
| Persistent contextualization cache | P2 | `pipeline/contextual_retrieval.py` + `STORAGE_DIR/context_cache.jsonl` | `CONTEXT_CACHE` (1) |
| Prefix warm-up (first uncached chunk runs alone) | P1 | `pipeline/contextual_retrieval.py` | `CONTEXT_WARM_FIRST` (1) |
| Per-doc endpoint affinity | P1 | contextualizer → `llm_func` `_endpoint_affinity` | `CONTEXT_AFFINITY` (1) |
| Global (not per-doc) context semaphore | P1 | `pipeline/ingest.py` main → wrapper | `CONTEXT_MAX_ASYNC` (48) |
| Gleaning / merge-summary knobs exposed | review | SLURM env passthrough (LightRAG reads env) | `MAX_GLEANING` (1), `FORCE_LLM_SUMMARY_ON_MERGE` (8), `SUMMARY_MAX_TOKENS` (1200) |

**Why determinism matters more than it looks:** LightRAG's entity-extraction cache
is content-addressed on the prompt, and the prompt contains the *contextualized*
chunk. With sampling on, every restart produced different blurbs → different chunk
content → **zero** extraction-cache hits (a 100k+-record cache gave ~0 hits on a
resume). With `temperature=0` **and** the blurb cache, a resume re-derives identical
chunks, so both caches hit and resume cost drops toward embedding-only.

**Why warm-up + affinity:** each context call carries the same ~20k-token document
prefix. vLLM's prefix cache only reuses *committed* KV blocks, so firing dozens of
identical-prefix requests simultaneously re-prefilled the same document up to
`CONTEXT_MAX_ASYNC` times; round-robin additionally paid one prefill per endpoint.
Warm-up commits the prefix once; affinity keeps a doc's calls on one endpoint. The
old semaphore was also **per-document**, so real concurrency was
`MAX_PARALLEL_INSERT × CONTEXT_MAX_ASYNC` (≈1,150 in-flight 20k-token prompts at
TUNE values) — enough to evict the very prefixes it was trying to reuse. It is now
one global semaphore.

**Cache-safety details:** blurb-cache keys are salted with
`LLM_MODEL|temperature|seed`, so switching models never reuses stale blurbs; the
cache file is append-only JSONL (a rewritten JSON here would recreate the O(N²)
flush problem); failed calls are never cached.

## 2. Storage I/O (P9 — found in review)

LightRAG 1.5.3 calls `index_done_callback()` on **every** storage after **every**
document, and the JSON/GraphML backends rewrite their entire file each time —
`kv_store_llm_response_cache.json` (245 MB at 1.5k docs), `kv_store_text_chunks.json`,
`kv_store_full_docs.json`, and `graph_chunk_entity_relation.graphml` (322 MB)
included. `JsonDocStatusStorage.upsert` additionally self-flushes on every status
change. Over 9.7k docs that is O(N²) bytes written plus multi-second synchronous
`json.dump` stalls **on the event loop** per document late in the run.

**Fix:** [`pipeline/kv_flush_throttle.py`](../pipeline/kv_flush_throttle.py) wraps
the `index_done_callback` attribute of the file-backed storages on the constructed
`LightRAG` instance (object-level, no library edits). One ordered flush per
`KV_FLUSH_INTERVAL` (default 300 s): **data stores first, `doc_status` LAST**, so
the on-disk status can never claim more than the data stores hold. A hard kill
loses at most the last interval (those docs simply re-process — cheap under the P2
caches). A SIGTERM handler in the ingest force-flushes immediately on walltime.
Non-file backends (Redis/Postgres via `KV_STORAGE`) and the vector DBs (whose
flush is where deferred embeddings actually happen) are deliberately not wrapped.
`KV_FLUSH_INTERVAL=0` restores upstream per-doc behavior. The dead
`INSERT_DONE_EVERY_N` knob was removed. Tests: `tests/test_kv_flush_throttle.py`.

## 3. Chunking (P10 + P12 — found in review)

**P10 — the prechunk cache was silently dead, and cold-cache chunking blocked the
loop.** `scripts/prechunk_papers.py` keys `chunk_cache.json` on md5 of
**pypdf**-extracted text, but the ingest extracts with **PyMuPDF**
(column-aware, `pipeline/pdf_extract.py`) — so the keys mismatch on every
two-column paper and "cached" chunking was actually live: synchronous Python
inside LightRAG's async worker → serialized across all `MAX_PARALLEL_INSERT`
workers, guarded by SIGALRM.

**Fix — chunk in the extraction subprocess** (`CHUNK_IN_EXTRACT`, default 1):
the per-PDF extraction child now also runs the structure-aware chunker (same
`CHUNKER_TYPE`/`CHUNK_*` env, tiktoken cl100k — same convention as the prechunk
script) and writes a `.chunks` sidecar; the parent seeds its in-memory chunk cache
so LightRAG's later `chunking_func` call is a dict hit. Consequences:

- chunking is **parallel** (one subprocess per PDF, `IO_THREADS`-wide) and **off
  the event loop**;
- a hung chunker is killed by the subprocess timeout (`PDF_EXTRACT_TIMEOUT`,
  default 300 s with chunking) instead of SIGALRM — and because the child writes
  the text file **atomically before chunking**, the completed text is *salvaged*
  and the doc just chunks live later;
- cache keys always match, because the chunks hash the exact text that gets
  enqueued.

The `[STATUS] Extract: chunk_cache_seeded=… salvaged_texts=…` line tracks it.
Tests: `tests/test_pdf_extract_chunks.py` (real subprocess round-trip, sidecar ==
direct chunking, parent seeding, salvage helpers).

**P12 — dead O(k²) tokenizer work.** `split_oversized_paragraph` re-tokenized the
accumulated chunk after every sentence append and discarded the result. Removed;
chunk output is byte-identical.

## 4. Pipeline overlap + restarts (P8)

| Change | Detail |
| --- | --- |
| Enqueue/drain overlap (`STREAM_OVERLAP`, 1) | The drain starts after the first 512-doc enqueue batch instead of letting the GPUs idle through the whole read phase; LightRAG's busy/request_pending driver refetches the queue as later batches land, and a final drain call covers stragglers. |
| Extraction skip ledger (`STORAGE_DIR/extract_skip_ledger.jsonl`) | Failed/empty extractions are recorded (basename + size) and skipped on resume — previously they re-paid a subprocess per restart because they never enter doc_status. A re-OCR'd replacement has a different size and retries automatically; `RETRY_EXTRACT_FAILED=1` forces a retry pass. |
| Rolling endpoint adoption (`ENDPOINT_REFRESH_S`, 300 s) | Endpoints registered mid-run are adopted, so a fresh vLLM job can replace one nearing walltime; previously re-discovery only happened after ALL endpoints died. |
| SIGTERM flush handler | On walltime/scancel the ingest flushes the throttled storages and the blurb cache, then exits 143. |

## 5. vLLM serving + environment (P3)

| Change | Detail |
| --- | --- |
| Stability flags parametrized | `VLLM_ENFORCE_EAGER` (1 = current stable `--enforce-eager --disable-custom-all-reduce`), `VLLM_KV_CACHE_DTYPE` (`auto`; try `fp8` — ~2× KV capacity → fewer prefix evictions, a direct P1 amplifier), `VLLM_EXTRA_ARGS`. The `VLLM_ENFORCE_EAGER=0` A/B recovers ~10–20% throughput but must pass a ≥4 h TP=2 soak (the shm-broadcast crash appeared at ~2h50m). |
| vLLM pin codified | Setup jobs previously installed an **unpinned** nightly (how the TP=2 regression got in). Now `VLLM_PIN=0.23.1rc1.dev245+g9037498c2`. |
| Trillium prefix caching | `job_westbury_vllm_tril.slurm` had **no `--enable-prefix-caching` at all** — every context call re-prefilled the full document there. Added (and to the generic job). |

## 6. Embedding (P4)

- New **dedicated embedder job** `slurm/job_westbury_embed.slurm`: serves
  `scripts/server.py` (Qwen3-Embedding-8B bf16) on its own H100 and registers
  `$WORKDIR/embed_endpoints/<jobid>.txt`; every ingest job **auto-adopts** a
  healthy registered endpoint into `EMBED_ENDPOINT`. Optional — without it the
  in-process default is unchanged.
- In-process safe ceiling baked in: `EMBED_FUNC_MAX_ASYNC=2` (3 peaked at 98.5%
  VRAM), `EMBED_BATCH=64`, `EMBEDDING_BATCH_NUM=128` (batch size, not async, is
  the embed throughput lever). The books scripts' stale `=16` default — which
  would OOM the bf16 8B embedder instantly — was lowered to 2.

## 7. SLURM walltime data-safety (P11 — found in review)

Qdrant runs on node-local `$SLURM_TMPDIR` and rsyncs back to scratch **after** the
ingest exits — but at walltime SLURM sends SIGTERM and then SIGKILL after ~30 s
(KillWait). The westbury traps only `echo`ed (python kept running; cleanup never
got time) and the books scripts had **no TERM trap at all**, so every
walltime-killed cycle silently **lost that cycle's Qdrant vectors while
doc_status said processed** — the likely source of past "missing embeddings"
repair runs.

**Fix (all westbury + books ingest jobs):** `#SBATCH --signal=B:TERM@600` delivers
TERM to the batch shell 10 minutes early; the ingest now runs backgrounded and the
trap kills it → the in-python handler flushes → Qdrant stop + rsync-back run with
minutes of budget. Trillium keeps its existing kill-children trap and gets
`--signal=B:TERM@300` (its Qdrant lives directly on Lustre — no rsync needed).

## 8. Resource shape

- Ingest jobs `--cpus-per-task` 6 → **12** (extraction subprocesses + chunking +
  Qdrant sidecar + JSON flushes were CPU-starved; 12 is the proportional share for
  1 of 4 GPUs on the H100 nodes). `IO_THREADS` default 8 → **12** to match.
- SLURM defaults now carry the full validated TUNE set: `PARALLEL_DOCS=24`,
  `LLM_MAX_ASYNC=48`, `CONTEXT_MAX_ASYNC=48`, `MAX_PARALLEL_INSERT=24` — a plain
  `sbatch` needs no `--export`.

## 9. Observability (P1 measurement / P7)

Every 30 s status tick now prints:

```text
[STATUS] processed=… rate=…/hr …
[STATUS] LLM: … avg=…s/call | Embed: … batch=…
[STATUS] Context: cache_hits=… llm_calls=… failures=…
[STATUS] Extract: chunk_cache_seeded=… salvaged_texts=…
[STATUS] Flush: ticks=… skipped=… (interval=300s)
[VLLM] http://host:port/v1 running=… waiting=… kv=…% prefix_hit=…% (cum …%)
```

Tuning playbook: raise `MAX_PARALLEL_INSERT`/`LLM_MAX_ASYNC` until `waiting>0` or
`prefix_hit%` drops (prefix eviction); target `kv%` ~60–80. On a resume,
`Context: cache_hits` should climb and `docs/hr` should far exceed the 75/hr
fresh-run baseline.

## 9.5 vLLM TP=2 hang fix package (same day, third batch)

The intermittent TP=2 engine hang (worker rank stalls mid-decode → `sample_tokens`
RPC timeout → engine death every ~3–9 h; full evidence and research in
[VLLM_TP_CRASH_DEBUG.md](VLLM_TP_CRASH_DEBUG.md)) was costing 1/3 to all of the
LLM capacity on long runs — the ingest survived via failover, but each dead vLLM
idled its 2 H100s for the rest of the job. Deployed in the vLLM jobs:

- **Node-local JIT caches** (`VLLM_LOCAL_JIT_CACHE=1`): Triton/FlashInfer caches
  move to `$SLURM_TMPDIR` (seeded from the shared Lustre dir). The shared
  network-FS cache — written concurrently by 2 TP ranks × up to 3 jobs — is the
  prime aggravator for mid-serve JIT stalls/deadlocks.
- **`VLLM_SKIP_FLASHINFER_AUTOTUNE=1`** and **`VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS=1200`**
  (finite stalls become latency blips instead of engine death at the 300 s default).
- **Pre-warm** (`VLLM_PREWARM=1`): decode-kernel JIT is forced before the endpoint
  registers, not mid-serve.
- **Hang watchdog + auto-diagnostics**: engine logs to
  `logs/vllm_engine_<jobid>_rN.log`; on the first shm-broadcast stall warning,
  py-spy stacks of every vLLM process + nvidia-smi land in
  `logs/vllm_hang_diag_<jobid>_rN.txt` — the evidence that names the hung kernel.
- **In-job auto-restart** (`VLLM_MAX_RESTARTS=3`): a dead engine deregisters its
  endpoint, restarts in-place on a fresh port, pre-warms, re-registers; the
  ingest's endpoint re-discovery adopts it. Not a SLURM resubmission — the
  no-job-chains rule is untouched. A crash now costs ~10 min of one endpoint
  instead of the remainder of that job's walltime.
- `py-spy` added to the setup jobs.

## 10. Files touched

- **Code:** `pipeline/ingest.py`, `pipeline/contextual_retrieval.py`,
  `pipeline/kv_flush_throttle.py` (new), `pipeline/pdf_extract.py`,
  `pipeline/scientific_chunker.py` (dead-work removal only — identical output).
- **SLURM:** `job_westbury_ingest_v2{,_fir,_ror,_nibi,_tril}.slurm`,
  `job_books_ingest_{nibi,ror,tril}.slurm`, `job_westbury_vllm{,_fir,_ror,_nibi,_tril}.slurm`,
  `job_setup_env{,_fir,_ror,_nibi}.slurm`, `job_westbury_embed.slurm` (new).
- **Tests (all green, 161 total):** `tests/test_contextual_retrieval.py` (extended),
  `tests/test_kv_flush_throttle.py` (new), `tests/test_pdf_extract_chunks.py` (new).
- **Docs:** this file, `INGEST_EFFICIENCY_OPEN_PROBLEMS.md` (per-problem status),
  `CANONICAL_INGEST_PARAMS.md` (refreshed canonical set).

## 11. Deliberately NOT done

- **Batch contextualization** (one LLM call emitting all of a doc's blurbs): with
  warm-up + affinity + prefix caching, the marginal token savings are small and it
  adds a parse-failure surface — re-measure `prefix_hit%` first; revisit only if
  it stays low.
- **`VLLM_ENFORCE_EAGER=0` by default:** needs the ≥4 h TP=2 soak first (P3).
- **`MAX_GLEANING=0` by default:** halves extraction LLM calls but changes KG
  recall — exposed as a knob for an A/B, default unchanged.
- **Redis/Postgres KV backends:** the flush throttle removes the O(N²) pain with
  zero infra; `KV_STORAGE`/`DOC_STATUS_STORAGE` passthroughs remain for later.
- **Chunk-size change:** none. 512 is canonical.
