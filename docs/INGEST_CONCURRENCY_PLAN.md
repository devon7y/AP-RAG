# Ingest Concurrency Optimization Plan

**Status:** wrapper-side code changes landed in `pipeline/ingest.py` (Fixes 2, 3, 4 always-on/flagged; Fix 1 opt-in via env). Infra steps (Redis sidecar for Fix 1, serving the embedder on GPU 2, SLURM env tuning for Fix 5) are still operational TODOs — see [Implementation status](#implementation-status-wrapper-only).
**Target hardware:** 1 node, **3× H100 (80 GB)** — 2 for the LLM (BF16, TP=2), 1 dedicated to embedding — plus many CPU cores
**LightRAG version:** **1.5.3** (the older `docs/BOTTLENECKS.md` / `PRE_FLIGHT.md` describe 1.4.x — several of their claims are now wrong; see [Corrections to stale docs](#corrections-to-stale-docs))
**Scope:** ingestion only (`pipeline/ingest.py` text path + the LightRAG pipeline it drives). Query path untouched.

---

## TL;DR

Ingestion is **single-process, single-event-loop by necessity** — LightRAG graph DBs can't be merged, so the whole corpus runs through one `WORKING_DIR` in one process. The event loop is therefore the central resource. "Improving concurrency" means three things, in priority order:

1. **Stop re-serializing the giant JSON KV stores on every document** (currently O(N²) disk I/O over a run). *Biggest win, GPU-independent.*
2. **Stop blocking the event loop** with synchronous PDF reads, on-loop chunking, and hot-path logging. *Cheap, low-risk.*
3. **Give embedding real GPU throughput** — it now gets its own dedicated H100 (GPU 2), so lean on batch size, not thread-concurrency on one in-process model.

The wrapper's `PARALLEL_DOCS` is **not** the real concurrency knob — `MAX_PARALLEL_INSERT` is. And the wrapper's `INSERT_DONE_EVERY_N` batched-flush knob is **dead code** on 1.5.3.

---

## How concurrency actually works on 1.5.3 (the corrected model)

When the text path in [`pipeline/ingest.py`](../pipeline/ingest.py) runs:

1. `process_one` launches `PARALLEL_DOCS` tasks, each `await rag.ainsert(text, …)`.
2. [`ainsert`](../LightRAG/lightrag/lightrag.py#L1486-L1493) → `apipeline_enqueue_documents` + `apipeline_process_enqueue_documents`. The **first** task to enter sets `busy=True` and becomes the sole driver of [`_run_pipeline_batch`](../LightRAG/lightrag/pipeline.py#L1222-L1223), which spawns `max_parallel_insert` `_process_worker` tasks. **Every other concurrent `ainsert` just sets `request_pending=True` and returns immediately** ([pipeline.py:959-960](../LightRAG/lightrag/pipeline.py#L959)). The driving loop refetches the queue whenever `request_pending` is set, so late enqueues still get processed.
3. **⇒ Real document-level concurrency = `MAX_PARALLEL_INSERT` worker tasks.** `PARALLEL_DOCS` only governs how many PDFs are read + enqueued + polled at once.
4. Per worker, per doc: chunk → (contextualize) → extract entities (LLM, gated by `llm_model_max_async`) → `merge_nodes_and_edges` (per-entity **keyed locks**, *not* a global graph lock) → embed → `_insert_done()` (full-store flush, **per doc** — [pipeline.py:2560](../LightRAG/lightrag/pipeline.py#L2560)).

All of chunking, contextual-prompt assembly, JSON (de)serialization, NetworkX mutation, and `doc_status.json` polling run **on the one event loop thread**. The LLM calls are network-bound (to vLLM) so asyncio overlaps them well; everything CPU/disk-bound competes for that single thread.

---

## GPU layout (3× H100) — settled

| GPU(s) | Role | Detail |
|---|---|---|
| **GPU 0 + GPU 1** | LLM (extraction + contextualization + VLM captions) | Qwen3.6-35B-A3B **BF16**, vLLM **TP=2**. ~70 GB model spread across two cards leaves generous KV cache for the ~36 K-token contextualization prompts. Keeps BF16 quality (no FP8 tradeoff). |
| **GPU 2** | Embedding | Qwen3-Embedding-8B (~16 GB) on its **own dedicated H100**. ~60 GB free → large batches and/or high `EMBED_FUNC_MAX_ASYNC` with no vLLM contention. This is what makes [Fix 3](#fix-3--give-embedding-real-gpu-throughput) pay off. |

Implications for the rest of the plan:

- The LLM is **one** vLLM endpoint (TP=2 across GPU 0+1), so `build_round_robin_llm` round-robins over a single endpoint — i.e. no fan-out. Saturate that one endpoint with async concurrency (`LLM_MAX_ASYNC` / `CONTEXT_MAX_ASYNC`) tuned against its KV cache, **not** by adding endpoints.
- Embedding is no longer GPU-constrained: take the **dedicated-embedder** branch of [Fix 3](#fix-3--give-embedding-real-gpu-throughput) (serve `scripts/server.py` on GPU 2 and POST to it, or load the model in-process pinned to `CUDA_VISIBLE_DEVICES=2`). The old `EMBED_FUNC_MAX_ASYNC=1` "shared GPU" constraint from the stale docs no longer applies.
- Everything in Fixes 1, 2, and 4 is **GPU-independent** and worth doing regardless.

---

## Fix 1 — Move KV stores off per-document JSON rewrites *(biggest win)*

**Problem.** [`_insert_done()`](../LightRAG/lightrag/pipeline.py#L2560) runs **after every document** and rewrites the JSON KV stores — including `kv_store_llm_response_cache.json`, which grows to hundreds of MB (the project `CLAUDE.md` warns it OOM-kills a login node on `json.load`). Rewriting a growing file once per doc is **O(N²)** disk I/O over a 1,466-doc run, executes **on the event loop**, and lines up with the "GPU idle during writes" bursts the old docs observed. Qdrant already removes the *vector* JSON, but the KV stores are still JSON.

**Note.** The wrapper's `INSERT_DONE_EVERY_N` ([ingest.py:132](../pipeline/ingest.py#L132)) is **dead code** on 1.5.3 — the pipeline controls flush cadence internally; the wrapper can no longer batch it.

**Plan.**
- [ ] Switch the KV namespaces (`full_docs`, `text_chunks`, `llm_response_cache`, `doc_status`, entity/relation KV) from `JsonKVStorage` to an incremental backend LightRAG already supports (Redis, Postgres, or Mongo) so a flush is an upsert, not a full-file rewrite. Set via the storage-backend kwargs / env LightRAG exposes.
  - On HPC this likely means a Redis/PG sidecar (Apptainer) on node-local NVMe, same pattern as the existing Qdrant sidecar.
- [ ] If staying on JSON is mandatory: at minimum keep `llm_response_cache` out of the per-doc flush path, and/or land an upstream-compatible wrapper that throttles flush cadence (cannot be done from the wrapper today — would need a small, upgrade-safe shim, not a `LightRAG/` edit).
- [ ] Re-measure flush time per doc as the corpus grows (it should stop climbing).

**Risk:** medium (storage-backend change). **Payoff:** removes the dominant scale drag; expected to be the single largest throughput gain at full-corpus size.

---

## Fix 2 — Stop blocking the event loop *(cheap, do first)*

**2a. PDF extraction on the loop.** `PdfReader(...)` + `extract_text()` run **inline** in `process_one` ([ingest.py:1028-1033](../pipeline/ingest.py#L1028)). pypdf is pure-Python and CPU-heavy; a large/scanned PDF freezes *every* concurrent LLM/embed callback for seconds.
- [ ] Wrap the read in `await asyncio.to_thread(_extract_pdf_text, pdf_path)` (or fold into the Fix 4 producer). Use a **dedicated** executor, not the default one (see 2d).

**2b. Structure-aware chunking on the loop.** The SIGALRM-wrapped sync chunker runs synchronously inside the async wrapper ([contextual_retrieval.py:101](../pipeline/contextual_retrieval.py#L101)), inside the pipeline worker → blocks the loop per doc. The contextualization LLM calls themselves are correctly async (awaited at [pipeline.py:2280-2281](../LightRAG/lightrag/pipeline.py#L2280)); only the CPU chunking blocks.
- [ ] Ensure the **prechunk cache** is populated (`scripts/prechunk_papers.py` → `chunk_cache.json`) so chunking at ingest time is a dict lookup, not live regex/tokenization. This is the existing, intended mitigation.
- [ ] (Optional) offload live chunking to a process pool. Caveat: SIGALRM only works on the main thread, so off-thread chunking needs a different timeout mechanism (`asyncio.wait_for` around a process-pool future). Prefer the prechunk cache instead.

**2c. Hot-path logging.** `print("[LLM_DEBUG]…", flush=True)` fires **3× per LLM call** ([ingest.py:395](../pipeline/ingest.py#L395), [409](../pipeline/ingest.py#L409), [424](../pipeline/ingest.py#L424)). At `LLM_MAX_ASYNC=32` + contextualization that's hundreds of `flush=True` writes/sec, each holding the GIL and doing blocking I/O to the SLURM log.
- [ ] Gate all `[LLM_DEBUG]` prints behind an `LLM_DEBUG=1` env flag (default off). Keep the aggregate counters in `_llm_stats` / `status_monitor`.

**2d. Shared default thread pool.** `local_embed` uses `run_in_executor(None, …)` and `doc_status` polling uses `asyncio.to_thread` — **both use the default executor**, so embedding (long GPU holds) and status polling contend for the same threads.
- [ ] Create a dedicated `ThreadPoolExecutor` for embedding and a separate one for I/O (PDF reads, status reads). Pass them explicitly to `run_in_executor`.

**Risk:** low. **Payoff:** immediate event-loop relief; multiplies the benefit of every other fix.

---

## Fix 3 — Give embedding real GPU throughput

**Problem.** `local_embed` ([ingest.py:248](../pipeline/ingest.py#L248)) calls `model.encode()` on **one** in-process SentenceTransformer via the default executor. Raising `EMBED_FUNC_MAX_ASYNC` spawns N threads hitting the *same* model on the *same* CUDA stream → they serialize on the GIL/stream and multiply activation memory (why the old docs forced it to 1 on a shared GPU). **Concurrency is the wrong lever; batch size and GPU placement are.**

**Plan (dedicated GPU 2 — see [GPU layout](#gpu-layout-3-h100--settled)):**
- [ ] Pin embedding to GPU 2. Either: (a) serve [`scripts/server.py`](../scripts/server.py) on GPU 2 and have `local_embed` POST to it (OpenAI-compatible `/v1/embeddings`) — mirrors how the LLM is served, and decouples the embedder's lifecycle from the ingest process; or (b) keep it in-process but launch the ingest job with the embedder pinned (`CUDA_VISIBLE_DEVICES` arranged so the SentenceTransformer lands on GPU 2, vLLM on 0+1).
- [ ] **Raise the batch** (`EMBED_BATCH` / LightRAG `embedding_batch_num`) — with a dedicated 80 GB card, embedding throughput scales with batch size far more than with async concurrency (one model object + one CUDA stream means extra `EMBED_FUNC_MAX_ASYNC` threads mostly queue). Push batch up until GPU 2 memory or latency says stop.
- [ ] `EMBED_FUNC_MAX_ASYNC` can now be raised (the old `=1` shared-GPU constraint is gone), but treat it as secondary to batch size; a modest value (e.g. 2–4) is enough to overlap host-side prep with GPU compute.

**Risk:** low (dedicated GPU, no vLLM contention). **Payoff:** de-serializes embedding; large if embedding is on the critical path (confirm via `status_monitor`'s avg embed s/call).

---

## Fix 4 — Switch the text path to enqueue-all / drain-once

**Problem.** Because of the `busy`/`request_pending` model, the per-doc poll loop in `process_one` ([ingest.py:1066-1083](../pipeline/ingest.py#L1066)) has each of `PARALLEL_DOCS` tasks **re-reading and `json.loads`-ing the entire growing `doc_status.json` every 5 s**, on top of the redundant `ainsert`-per-doc dance. It's overhead, not parallelism.

**Plan.** Adopt the native model you **already wrote** for the VLM path ([`ingest_native_multimodal`](../pipeline/ingest.py#L771)):
- [ ] A bounded thread-pool **producer** that reads/extracts each PDF and calls `apipeline_enqueue_documents(...)` as text becomes ready (keeps q_process fed continuously, smoothing the vLLM wave).
- [ ] A **single** `apipeline_process_enqueue_documents()` drain.
- [ ] One shared `status_monitor`-style reader for progress (replaces N per-doc pollers).
- [ ] Preserve resume/skip: keep the existing `md5(text) → doc_id` precompute + `known_doc_ids` filter, or rely on LightRAG's enqueue-time dedup (as the VLM path does).

**Risk:** medium (control-flow rewrite). **Payoff:** removes redundant polling, loop-blocking reads, and the artificial `PARALLEL_DOCS` gate; enables continuous pipelining.

---

## Fix 5 — Smooth the bursty vLLM (falls out of 1–4)

The "bursty 50–60% GPU" symptom is the *result* of the above: docs enter in waves, all hit extraction together, then all stall during merge + per-doc flush + serial embed (vLLM idle). Once Fixes 1–3 remove the loop/flush ceilings and Fix 4 makes entry continuous:
- [ ] Raise `MAX_PARALLEL_INSERT` until the single vLLM endpoint's KV cache sits ~0.5–0.8 (watch vLLM `kv_cache_usage_perc` / `num_requests_waiting`). With one TP=2 (or FP8) endpoint, this is now the main saturation knob alongside `CONTEXT_MAX_ASYNC`.
- [ ] Keep `CONTEXT_MAX_ASYNC` tuned so the ~36 K-token contextualization prompts don't blow the KV cache (RoPE/length crash risk — Qwen3 length limit still applies; verify `--max-model-len` headroom for the chosen option).

---

## Implementation order

1. **Fix 2** (unblock the loop) — ~1 hour, low risk, immediate relief. Do first.
2. **Fix 3** (embedding on dedicated GPU 2) — GPU layout is settled; just wire the embedder to GPU 2 and raise the batch.
3. **Fix 1** (KV store backend) — biggest win, needs a sidecar; schedule a maintenance window.
4. **Fix 4** (enqueue-all rewrite) — after 1–3 are stable.
5. **Fix 5** (retune `MAX_PARALLEL_INSERT` / `CONTEXT_MAX_ASYNC`) — last, against live KV-cache metrics on the single TP=2 endpoint.

---

## What to measure (before/after)

The existing `status_monitor` already logs the right things — capture a baseline first:
- `avg LLM s/call` vs `avg embed s/call` → tells you whether LLM or embedding is critical (settles whether Fix 1 or Fix 3 dominates).
- `docs/hr` (delta + overall).
- vLLM `kv_cache_usage_perc`, `num_requests_running`, `num_requests_waiting`.
- Per-doc `_insert_done()` wall time vs corpus size (should be flat after Fix 1, climbing before it).
- Event-loop responsiveness: gaps between `[STATUS]` lines / poll latency (should tighten after Fix 2).

---

## Implementation status (wrapper-only)

All code changes are in `pipeline/ingest.py` — **nothing in `LightRAG/` was touched** (verified `git status` in the nested checkout stays clean). New env knobs, all defaulting to prior behavior except the text path (now streaming by default):

| Fix | Status | How it's wired | Env knobs |
|---|---|---|---|
| **2a** PDF read off-loop | ✅ always on | `_extract_pdf_text` runs in `_IO_EXECUTOR` (both streaming + legacy paths) | `IO_THREADS` (default 8) |
| **2c** gate hot-path logging | ✅ always on | `[LLM_DEBUG]` per-call prints gated | `LLM_DEBUG` (default 0) |
| **2d** dedicated executors | ✅ always on | separate `_IO_EXECUTOR` / `_EMBED_EXECUTOR`; status polling + embedding no longer share the default pool | `IO_THREADS` |
| **3** embedding throughput | ✅ code; infra TODO | `embedding_batch_num` passed through; optional remote embedder; dedicated embed executor | `EMBED_ENDPOINT`, `EMBEDDING_BATCH_NUM` (default 32), `EMBED_FUNC_MAX_ASYNC` |
| **4** streaming text path | ✅ default on | `ingest_streaming_text` (enqueue-all → drain-once); legacy `process_one` kept as fallback | `STREAMING_INGEST` (default 1) |
| **1** KV store backend | ⚙️ opt-in | `kv_storage` / `doc_status_storage` passed through when set | `KV_STORAGE`, `DOC_STATUS_STORAGE` (need a Redis/PG sidecar) |
| **5** retune insert/context | ⚙️ operational | knobs already passed through; tune against live KV-cache metrics | `MAX_PARALLEL_INSERT`, `CONTEXT_MAX_ASYNC` |

**To activate the GPU-dependent + infra pieces:**
- **Fix 3 (dedicated embedder):** run `scripts/server.py` on GPU 2 and set `EMBED_ENDPOINT=http://<host>:8000` in the ingest job — or pin the in-process model to GPU 2 via `CUDA_VISIBLE_DEVICES`. Then raise `EMBEDDING_BATCH_NUM` / `EMBED_FUNC_MAX_ASYNC` (the old `=1` shared-GPU cap no longer applies).
- **Fix 1 (incremental KV):** stand up a Redis (or PG) sidecar, then set `KV_STORAGE=RedisKVStorage` + `DOC_STATUS_STORAGE=RedisDocStatusStorage` (and the backend's connection env). Until then it stays on JSON. Note: `REBUILD_EMBEDDINGS` mode still reads `kv_store_text_chunks.json` directly, so don't switch KV backends for a corpus you intend to reembed from the JSON cache without migrating it first.

**Behavioral note (Fix 4):** the streaming path does **not** set the global `_current_pdf_path`, so the SIGALRM chunk-timeout still fails a hung document cleanly but no longer moves the offending PDF aside (the producer can't know which PDF is mid-chunk at drain time — same as the existing VLM path). Set `STREAMING_INGEST=0` to restore the legacy per-doc path (with the auto-move) if needed.

## Corrections to stale docs

The 1.4.x-era notes in `docs/BOTTLENECKS.md` and `docs/PRE_FLIGHT.md` are wrong on 1.5.3:
- **No global NetworkX merge lock.** `merge_nodes_and_edges` uses **per-entity / per-edge keyed locks**, so different entities merge concurrently. The "graph write contention" ceiling described in BOTTLENECKS §4 does not apply.
- **Not a literal "single pipeline worker."** One `ainsert` *drives* the pipeline, but it fans out to `max_parallel_insert` `_process_worker` tasks. The real concurrency knob is `MAX_PARALLEL_INSERT`, not `PARALLEL_DOCS`.
- **`INSERT_DONE_EVERY_N` is dead code** — flush cadence is internal to 1.5.3 (per-doc) and not controllable from the wrapper.
- The canonical "3× vLLM nodes" setup is superseded by the **3× H100** layout in this document: a single TP=2 BF16 vLLM endpoint (GPU 0+1) plus a dedicated embedding GPU (GPU 2). The old `EMBED_FUNC_MAX_ASYNC=1` "shared GPU" rule no longer applies.
