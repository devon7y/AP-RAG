# AP-RAG Ingest Efficiency — Open Problems & Optimization Targets

**Audience:** an engineer/LLM tasked with making the AP-RAG **ingest pipeline** faster.
**Written:** 2026-07-02, after a session that fixed three correctness bugs (segfault,
vLLM failover, embedder OOM) and got a clean run going. Those are *done*; this doc is
about **throughput/efficiency**, which is now the dominant problem.

> Scope: this is about **ingestion** (HPC batch, `pipeline/ingest.py`). The serving side
> (`query_server.py`, `scripts/server.py`) is a separate concern and out of scope here.

---

## ✅ Implementation status (2026-07-02) — what landed for each problem

All changes are **wrapper-side** (`pipeline/`, `slurm/`) — `LightRAG/` stays patch-free.
Everything is env-gated with the listed defaults baked into the SLURM scripts;
override any knob at submit time via `--export=ALL,VAR=value`.

| Problem | Status | What landed |
|---|---|---|
| **P1** prefix reuse | ✅ code / 📊 measure next run | (1) **Measurement**: the status monitor now polls each vLLM's `/metrics` every 30 s and prints `[VLLM] … running/waiting/kv%/prefix_hit%` (delta + cumulative). (2) **Doc-affinity routing** (`CONTEXT_AFFINITY=1`): all of a doc's context calls carry a stable `_endpoint_affinity` and pin to ONE endpoint — the ~20k-token prefix is prefilled once, not once per vLLM. (3) **Prefix warm-up** (`CONTEXT_WARM_FIRST=1`): the first uncached chunk runs alone before the fan-out, so the doc prefix is committed to the cache instead of N concurrent identical prefills racing. (4) **Global concurrency**: `CONTEXT_MAX_ASYNC` is now a true global semaphore — it was per-document, so real concurrency was `MAX_PARALLEL_INSERT × CONTEXT_MAX_ASYNC` (24×48 ≈ 1,152 in-flight 20k-token prompts), which thrashed/evicted the prefix cache. (5) Bug found: **Trillium's vLLM job had no `--enable-prefix-caching` at all** — added. Direction 3 (batch-contextualize a whole doc in one call) was deliberately **not** implemented: with 2–5 hot, re-measure `prefix_hit%` first; if it sits ≥90% the token math says batching buys little and adds a parse-failure surface. |
| **P2** cache across runs | ✅ | (1) `llm_func` now defaults `temperature=0.0` + `seed=42` (`LLM_TEMPERATURE`/`LLM_SEED`) — blurbs and extractions are deterministic, so LightRAG's content-addressed extraction cache hits on resume. (2) **Contextualization is itself cached**: `STORAGE_DIR/context_cache.jsonl` (append-only JSONL, content-addressed on the exact prompt + a `model|temperature|seed` salt). On any resume, unchanged docs' blurbs are free even across vLLM engine changes, which in turn keeps chunk ids stable → extraction-cache hits. `[STATUS] Context: cache_hits=…` shows it working. |
| **P3** enforce-eager cost | ⚙️ parametrized, soak is ops | vLLM jobs take `VLLM_ENFORCE_EAGER` (default 1 = current stable flags), `VLLM_KV_CACHE_DTYPE` (try `fp8` — ~2× KV capacity → fewer prefix evictions; direct P1 amplifier), and `VLLM_EXTRA_ARGS`. The A/B is now one submit flag; soak ≥4 h (crash appeared at ~2h50m) before trusting `VLLM_ENFORCE_EAGER=0`. The **vLLM pin is codified** in the setup jobs (`VLLM_PIN=0.23.1rc1.dev245+g9037498c2`) — they previously installed an *unpinned* nightly, which is how the TP=2 regression got in. |
| **P4** embedder | ✅ infra added, opt-in | New `slurm/job_westbury_embed.slurm` serves `scripts/server.py` (Qwen3-Embedding-8B bf16) on its own H100 and registers `$WORKDIR/embed_endpoints/<jobid>.txt`; every ingest job **auto-adopts** a healthy registered endpoint into `EMBED_ENDPOINT`. Without it, behavior is unchanged (in-process, `EMBED_FUNC_MAX_ASYNC=2`, `EMBED_BATCH=64` — the validated-safe ceiling; the books scripts' stale `=16` default, which would OOM the 8B bf16 embedder, was lowered to 2). Batches are already length-sorted internally by sentence-transformers. |
| **P5** max_tokens | ✅ | Every LLM call is capped: `LLM_MAX_TOKENS=4096` global, `CONTEXT_MAX_TOKENS=300` for blurbs. No more 39k-token runaway decodes. |
| **P6** chunk size | ✅ resolved (no change) | **512 is canonical** — owner decision 2026-07-02. The "pending 512-vs-800 A/B" in this doc and older notes was stale; 800 was an old configuration. `CHUNK_TARGET_TOKENS=512` stays. |
| **P7** saturation | 📊 instrumented | Use the new `[VLLM]` lines: target `kv%` ~60–80 with `waiting≈0`; raise `MAX_PARALLEL_INSERT`/`LLM_MAX_ASYNC` until `waiting>0` or `prefix_hit%` drops (eviction). Defaults baked = the validated TUNE set (24/48/48/24). |
| **P8** restarts | ✅ | (1) **Extraction skip ledger** (`extract_skip_ledger.jsonl`): failed/empty extractions are recorded (basename+size) and skipped on resume — a re-OCR'd replacement (different size) retries automatically; `RETRY_EXTRACT_FAILED=1` forces a retry pass. (2) **Enqueue/drain overlap** (`STREAM_OVERLAP=1`): the pipeline starts draining after the first 512-doc batch instead of idling the GPUs through the whole read phase. (3) **Rolling vLLM adoption** (`ENDPOINT_REFRESH_S=300`): endpoints registered mid-run are adopted, so a fresh vLLM job can replace an expiring one without waiting for total failure. (4) P2 makes each resume cheap (blurbs + extractions cached). (5) Ingest jobs got `--cpus-per-task=12` (was 6 — extraction subprocesses + chunking + Qdrant + JSON flushes were CPU-starved). |

**New problem found & fixed — P9, per-document full-file flushes (O(N²) disk I/O).**
LightRAG 1.5.3 rewrites *every* JSON KV store **and the GraphML** after *every*
document (`_insert_done`), and `doc_status.upsert` self-flushes on every status
change. At 9.7k docs that is O(N²) bytes (the LLM cache was 245 MB at 1.5k docs;
graphml 322 MB) plus multi-second synchronous `json.dump` stalls **on the event
loop** per doc late in the run. Fix: `pipeline/kv_flush_throttle.py` wraps the
constructed storages (no `LightRAG/` edits) — one ordered flush per
`KV_FLUSH_INTERVAL` (default 300 s), **data stores first, `doc_status` last**, so
disk status can never claim more than the data stores hold. A hard kill loses at
most the last interval (those docs simply re-process — cheap under P2). SIGTERM
(walltime) triggers an immediate final flush. `KV_FLUSH_INTERVAL=0` restores
upstream per-doc behavior. Also removed: the dead `INSERT_DONE_EVERY_N` knob.

**Pass 2 (same day) found three more — P10–P12, all fixed:**

| Problem | What it was | Fix |
| --- | --- | --- |
| **P10** stale prechunk cache + on-loop chunking | `scripts/prechunk_papers.py` keys the cache on md5 of **pypdf**-extracted text, but ingest extracts with **PyMuPDF** (`pipeline/pdf_extract.py`) — keys miss on every two-column paper, so "cached" chunking was silently live, synchronous, ON the event loop (sync chunker ⇒ serialized across all pipeline workers, SIGALRM-guarded). | `CHUNK_IN_EXTRACT=1`: the extraction subprocess also chunks (same env-driven chunker, tiktoken cl100k) and writes a `.chunks` sidecar; the parent seeds the in-memory chunk cache, so LightRAG's chunking_func is a dict hit. Chunking is now parallel (per-PDF subprocess), off-loop, and killable by subprocess timeout; keys hash the exact enqueued text. The child writes text atomically first, so a timeout/crash during chunking still **salvages** the completed text. |
| **P11** walltime kill lost the cycle's Qdrant delta | Qdrant runs on `$SLURM_TMPDIR` and rsyncs back to scratch *after* the ingest — but at walltime SLURM SIGTERMs and then SIGKILLs after ~30 s (KillWait). The old trap only `echo`ed; python kept running; the rsync-back never got time. **Vectors written that cycle were lost while doc_status said processed** (the likely source of past "missing embeddings" repairs). Books scripts had NO trap at all. | `#SBATCH --signal=B:TERM@600` (TERM to the shell 10 min early) + the ingest now runs backgrounded and the trap kills it → the in-python SIGTERM handler flushes throttled storages → Qdrant stop + rsync-back run with minutes of budget. Applied to all westbury + books ingest jobs (tril: signal only — its Qdrant lives on Lustre). |
| **P12** dead O(k²) tokenizer work in the chunker | `split_oversized_paragraph` re-tokenized the accumulated chunk after **every sentence append** and discarded the result (unused variable — ruff F841). | Removed. Exact same chunk output, less CPU per oversized paragraph. |

**How to validate the next run** (§7 still applies): compare docs/hr vs the 75/hr
baseline; check `[VLLM] prefix_hit%` (expect ≫ the old ~70–75% once affinity+warm-up
are on), `[STATUS] Context: cache_hits` climbing on a resume, `[STATUS] Extract:
chunk_cache_seeded` tracking the read count, and `[STATUS] Flush: ticks` staying
~1 per 5 min while `doc_status` counts keep moving.

**The complete change inventory (both passes) lives in
[INGEST_EFFICIENCY_CHANGES.md](INGEST_EFFICIENCY_CHANGES.md).**

---

## 0. TL;DR — the headline number

A full ingest of the **9,711-PDF** corpus runs at **~75 docs/hr → ~5–6 days of wall-clock**,
which must be spread across many restarts because the vLLMs have finite lifetimes and there
are no job chains. **The pipeline is LLM-bound.** Every efficiency dollar is in reducing or
better-utilizing the LLM (vLLM) work. The single biggest lever is **contextualization**
(P1/P2 below).

Do **not** chase micro-optimizations before P1 and P2.

---

## 1. Read these first

- `CLAUDE.md` (repo root) — architecture, the "patch-free LightRAG" rule, ingest modes.
- `docs/CANONICAL_INGEST_PARAMS.md` — the proven env/param values.
- `pipeline/ingest.py` — the ingest entry point (endpoint round-robin, embedder, drain).
- `pipeline/contextual_retrieval.py` — the contextualization wrapper (**the hot path**).
- `pipeline/scientific_chunker.py` — the chunker (chunk count drives LLM call count).
- `LightRAG/lightrag/operate.py` + `LightRAG/lightrag/utils.py` — entity extraction and the
  LLM response cache (`use_llm_func_with_cache`, `compute_args_hash`, `get_llm_cache_identity`).

**Hard constraint (do not violate):** `LightRAG/` is an unmodified upstream checkout kept
patch-free for upgradability. All AP-RAG behavior is injected via functions
(`chunking_func`, `llm_model_func`, `embedding_func`). **Never edit files under `LightRAG/`.**

---

## 2. Measured baseline (from the 4h validation run, 2026-07-01)

| Metric | Value | Notes |
|---|---|---|
| Throughput | **~75 docs/hr** | steady after warmup, 2 vLLMs |
| Docs processed in 4h | 282 | 0 failed, 0 OOM |
| Model (ingest LLM) | Qwen3.6-35B-A3B (MoE), BF16, **TP=2** | served by vLLM |
| Embedder | Qwen3-Embedding-8B, BF16, dim 4096 | **local**, on the ingest node's 1× H100 |
| Embedder VRAM @ `EMBED_FUNC_MAX_ASYNC=3` | **peak 80,343 / 81,559 MiB (~98.5%)** | at the OOM edge; run now uses `=2` |
| vLLM flags | `--tensor-parallel-size 2 --enforce-eager --disable-custom-all-reduce --enable-prefix-caching --max-model-len 40000 --gpu-memory-utilization 0.90` | |
| LLM calls per doc | ~40 (rough) | ≈ 1 contextualization + 1 extraction per chunk |

Current production config (the "TUNE" string), for reference:
`N_VLLM=3, PARALLEL_DOCS=24, LLM_MAX_ASYNC=48, CONTEXT_MAX_ASYNC=48,
EMBED_FUNC_MAX_ASYNC=2, EMBED_BATCH=64, EMBEDDING_BATCH_NUM=128,
MAX_PARALLEL_INSERT=24, MAX_DOC_TOKENS=20000, CHUNK_TARGET_TOKENS=512 (default),
EMBEDDING_DIM=4096`.

---

## 3. The pipeline and where time goes

Per document, inside one `chunking_func` call + the LightRAG drain:

1. **Extract text** from the PDF — `pipeline/ingest.py::_extract_pdf_text` (now subprocess-isolated). Cheap.
2. **Chunk** — `scientific_chunker` (structure-aware). Cheap (CPU). Produces ~30 chunks/doc.
3. **Contextualize** each chunk — `contextual_retrieval.py::_contextualize_one`: **1 LLM call per chunk**, prompt = **the whole document** (`MAX_DOC_TOKENS`≈20k) + the chunk. **Uncached.** ← biggest cost.
4. **Entity/relation extraction** — LightRAG runs **1+ LLM call per (contextualized) chunk**. Cached by content hash (see P2).
5. **Embed** — `local_embed` on the ingest GPU (batched). Secondary bottleneck at `MAX_ASYNC=2`.
6. **Store** — Qdrant upserts (sidecar on node-local NVMe). Cheap.

**Bottleneck order:** LLM (steps 3+4) ≫ embedder (5) ≫ everything else. Contextualization (3)
and extraction (4) are roughly comparable in call count, but contextualization carries a
**~20k-token document prefix on every call**, so it dominates prefill cost.

---

## 4. Open problems, ranked by expected impact

### P1 — Contextualization re-sends the whole document per chunk (redundant prefill) 🔴 highest impact
**Problem.** `CONTEXT_PROMPT` (`contextual_retrieval.py:46`) is `<document>{doc}</document> … <chunk>{chunk}</chunk> …`.
For a 30-chunk doc, that's **30 LLM calls each prefilling the same ~20k-token document**.
That's ~600k tokens of prefill per doc, almost all redundant.

**Mitigation already in place (verify it's actually working):** vLLM runs with
`--enable-prefix-caching`, and the doc is the **prefix** (comes first, identical across a
doc's chunks). In principle each vLLM prefills the doc once, then all subsequent chunks of
that doc hit the KV prefix cache. **But nobody has confirmed the hit rate**, and several
things defeat it:
- **Round-robin spreads a doc's chunks across all N vLLMs** (`build_round_robin_llm` in
  `ingest.py`), so each vLLM re-prefills the doc at least once, and cache locality is poor.
- **High concurrency (`MAX_PARALLEL_INSERT`, `CONTEXT_MAX_ASYNC`)** keeps many docs' prefixes
  live at once; with a 40k `max-model-len` and 0.90 util, the KV cache can **evict** a doc's
  prefix before its chunks finish → cache misses → full re-prefill.

**Directions (in rough order of value):**
1. **Measure prefix-cache hit rate first** (vLLM `/metrics` / `prefix_cache_stats`). If it's
   already high, P1 is largely solved and skip to P2. If low, pursue below.
2. **Doc-affinity routing:** send all chunks of a given document to the **same** vLLM (hash
   doc_id → endpoint instead of pure round-robin) so its prefix stays hot on one instance.
3. **Contextualize all of a doc's chunks in one (or few) LLM call(s)** — e.g., one prompt:
   "here is the doc; here are chunks 1..k; emit a one-line context for each." Cuts calls from
   ~30/doc to ~1–few/doc and prefills the doc once. Requires a robust output parser + fallback
   to per-chunk on parse failure. **Potentially a multi-× speedup.**
4. **Summarize the doc once**, then contextualize each chunk against the *summary* instead of
   the full 20k doc → far smaller prefix. Slight quality tradeoff; validate retrieval quality.
5. Lower `MAX_DOC_TOKENS` (currently 20k) if quality holds — smaller prefix, less prefill.

**Risk:** changing contextualization changes chunk `content` → changes chunk ids and requires
a fresh re-embed. Validate retrieval quality (this is a core AP-RAG feature, not just speed).

---

### P2 — The LLM response cache is unusable across runs (non-deterministic + uncached contextualization) 🔴 high impact
**Problem.** LightRAG caches **entity-extraction** results keyed by
`hash(prompt + response_format + llm_cache_identity)` (`utils.py:~3560`). The prompt includes
the **contextualized** chunk (blurb + text). But:
- **Contextualization uses no `temperature`/`seed`** (`ingest.py`'s `llm_func` calls
  `openai_complete_if_cache` without sampling params → vLLM default temp=1.0). So the blurb is
  **non-deterministic** → the contextualized chunk differs every run → the extraction-cache key
  never matches on a rerun.
- **Contextualization itself is not cached at all** (`_contextualize_one` calls the raw
  `llm_func`), so it's paid in full every run regardless.

**Consequence.** A ~100k+-record extraction cache from a prior run gave **~0 hits** this
session. Resumes re-do essentially all LLM work. For a 5-day job that must survive many
restarts, this is enormous waste.

**Directions:**
1. **Make ingest LLM calls deterministic:** pass `temperature=0` (+ a fixed `seed`) in
   `llm_func` (`ingest.py` `openai_complete_if_cache(...)`). Then identical (doc, chunk) →
   identical blurb → identical contextualized chunk → **extraction cache hits on resume.**
   (Caveat: vLLM greedy determinism is only stable within the same engine build/TP/GPU; good
   enough for same-cluster resumes.)
2. **Cache contextualization** content-addressed by `hash(doc_id + raw_chunk + prompt)` in a
   small KV store, so a resume skips re-generating blurbs. Combine with (1).
3. Note `llm_model_name` is unset so the cache identity model defaults to `"gpt-4o-mini"`
   (constant) — the *model* isn't what breaks caching; determinism + contextualization are.

**Payoff:** on any resume, unchanged docs' contextualization **and** extraction become cache
hits → resume cost drops toward embedding-only. This is what makes a multi-restart 5-day run
tractable.

---

### P3 — `--enforce-eager` costs ~10–20% throughput (stability workaround) 🟠 medium
**Problem.** vLLM was crashing via a **TP=2 shared-memory-broadcast `TimeoutError`** — a
mid-run `torch.compile`/CUDA-graph recompile stalls one TP worker while the other times out.
We fixed stability with `--enforce-eager` (disables CUDA graphs + compile) and
`--disable-custom-all-reduce`. `--enforce-eager` is the expensive one (~10–20% slower).

**Directions (recover the speed without the crash):**
- Keep CUDA graphs but **eliminate mid-run recompiles**: pin `compile`/`cudagraph_capture_sizes`
  to cover the actual batch-shape distribution so nothing recompiles at runtime.
- Try a **newer/patched vLLM** where the TP shm-broadcast hang is fixed (current pin is
  `0.23.1rc1.dev245+g9037498c2`; the pin exists because *other* nightlies regressed TP=2 —
  see `docs`/memory. Any change must be re-validated for TP=2 correctness).
- Investigate raising the shm/broadcast timeout vs. the actual recompile duration.
- Re-test with CUDA graphs on + custom-all-reduce off to see if the latter alone was enough.

**Risk:** this reintroduces the exact crash if done carelessly. Gate on a multi-hour TP=2 soak.

---

### P4 — Local embedder VRAM/throughput tradeoff; embedder may become the bottleneck 🟠 medium
**Problem.** The embedder runs **in-process on the ingest node's single H100**. At
`EMBED_FUNC_MAX_ASYNC=3` it peaks ~98.5% VRAM (OOM risk over days), so the run uses `=2`
(safer, ~70% peak, but lower embedder throughput). If the LLM side scales (more vLLMs), the
`=2` embedder can become the new bottleneck.

**Directions:**
- **Offload embedding to a dedicated GPU/server.** The code already supports it:
  `_remote_embed` + `EMBED_ENDPOINT` (`ingest.py:371`) speak the OpenAI `/v1/embeddings` API
  (`scripts/server.py`). A separate embedding job frees the ingest GPU and parallelizes
  embed vs LLM. Likely the cleanest win.
- **Quantize the embedder** (FP8/INT8) to cut VRAM, enabling higher concurrency safely.
- **Tune to a safe ceiling:** with `expandable_segments` on (now fixed via
  `PYTORCH_CUDA_ALLOC_CONF`), find the `MAX_ASYNC`×`EMBED_BATCH` that peaks ~85% (not 98%).
- Ensure batches are length-sorted to minimize padding waste (sentence-transformers).

---

### P5 — LLM `max_tokens` is uncapped (~40k default) 🟠 medium (speed + stability)
**Problem.** `llm_func` doesn't set `max_tokens`, so vLLM defaults to `max_model_len - prompt`
(~40k). Contextualization/extraction outputs are only a few hundred tokens, but a **runaway
generation** can decode toward 40k — wasting GPU and stressing the TP path (the crash dump
showed `max_tokens=39983`).

**Direction:** cap `max_tokens` (~2k–4k) in `llm_func`. Near-zero quality risk (real outputs
are short), removes runaway cost, and reduces crash surface. **Cheap, do this early.**

---

### P6 — Chunk size drives LLM call count 🟡 lower (quality tradeoff)

> **RESOLVED 2026-07-02 — no A/B needed.** 512 is the correct, canonical chunk
> size (owner decision); "800" below refers to an old configuration. Kept for
> the historical record only.
**Problem.** Smaller chunks → more chunks → more LLM calls (contextualization + extraction).
Current `CHUNK_TARGET_TOKENS=512`. A pending A/B (512 vs 800) was never resolved. 800-token
chunks would cut chunk count ~35% → proportionally fewer LLM calls.

**Direction:** run the 512-vs-800 retrieval-quality A/B; if 800 is acceptable, it's a free
~35% throughput gain. **Owner decision required** (quality vs speed) — don't change unilaterally.

---

### P7 — Concurrency saturation is unverified 🟡 lower
**Problem.** It's unconfirmed whether `LLM_MAX_ASYNC`/`MAX_PARALLEL_INSERT` actually saturate
the vLLMs, or whether the ingest under-drives them (or over-drives → queueing/timeouts).

**Direction:** measure vLLM utilization + queue depth vs `LLM_MAX_ASYNC`/`N_VLLM`; find the
knee. Balance against P1 (too-high concurrency evicts prefix caches) and P4 (embedder limit).

---

### P8 — Multi-day wall-clock requires many manual resumes 🟡 lower (operational)
**Problem.** No job chains (hard rule). A 5-day run = many manual restarts across vLLM
lifetimes. Resume works (self-heal resets stranded in-flight docs; see `ingest.py:~1464`), but
each restart re-reads all PDFs to rebuild skip sets.

**Directions:** speed up resume startup (persist the processed-id set instead of rescanning);
more/longer-lived vLLMs (ties to P3); solving P2 makes each resume far cheaper.

---

## 5. Hard constraints (violating these breaks the system)

1. **Never edit `LightRAG/`.** Inject via `chunking_func`/`llm_model_func`/`embedding_func`.
2. **No SLURM job chains / auto-resubmit** (explicit user rule; caused runaway job chains before).
3. **Embeddings must be identical at index and query time** (model + dim 4096). Changing the
   embedder ⇒ full re-embed (`REBUILD_EMBEDDINGS=1`).
4. **HPC offline caveats:** Trillium/Narval compute nodes have **no internet** — stage
   models/wheels from a login node first. Fir/Rorqual/Nibi compute nodes have internet.
5. **Don't regress the 3 validated correctness fixes** (see §6).

---

## 6. Already fixed — do not regress (validated in the 4h run: 282 docs, 0 fail, 0 OOM)

- **Segfault isolation:** PDF extraction runs as a subprocess (`pipeline/pdf_extract.py`,
  `ingest.py::_extract_pdf_text`) so a malformed-PDF native crash fails one doc, not the run.
- **vLLM failover:** dead endpoints are evicted and traffic fails over
  (`ingest.py::_is_conn_error` + `build_round_robin_llm`). A vLLM death is now survivable.
- **Embedder OOM env var:** `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` (was the typo
  `PYTORCH_ALLOC_CONF`, which never applied) — required for embedder VRAM stability.
- **vLLM TP stability:** `--enforce-eager --disable-custom-all-reduce` (see P3 — recover the
  speed carefully, don't just delete these).

Commits: `e545d48` (code + ror slurm), `db58843` (slurm propagation).

---

## 7. How to validate any change

- **Primary metric:** docs/hr (from `[STATUS] … rate=…/hr` in the ingest log) over a ≥1h window
  past warmup. Baseline **~75 docs/hr**.
- **Secondary:** vLLM prefix-cache hit rate (P1), LLM cache hit rate on a *resume* (P2),
  embedder peak VRAM (P4, target ≤ ~85%), `failed`/`out of memory` counts (must stay 0).
- **Correctness gate:** retrieval quality must not regress (P1/P6 change chunk content).
- **Fast local checks:** `python -m pytest tests/` (chunker tests, machine-independent).
- **Soak:** any vLLM/TP change needs a multi-hour TP=2 run (the crash appeared at ~2h50m).

---

## 8. Suggested order of attack

1. **P5** (cap `max_tokens`) — trivial, immediate.
2. **P1** (measure prefix-cache hit rate; then doc-affinity or batch-contextualize) — biggest raw speedup.
3. **P2** (determinism + contextualization cache) — makes resumes cheap; compounding win over a 5-day run.
4. **P4** (offload/quantize embedder) — unblocks scaling the LLM side.
5. **P3** (recover enforce-eager cost) — only after a proper TP=2 soak harness exists.
6. **P6/P7/P8** — tuning + operational, lower priority.

---

## 9. INCIDENT 2026-07-03 — embedder CUDA-OOM cascade at scale (FIXED; do not regress)

**What happened:** the first full-corpus run of the efficiency build (Nibi, resume from 535)
OOM'd the in-process embedder from ~6h in and at 7.2h the retry storm (18k errors) halted the
pipeline and **failed all 9,041 remaining docs** (`processed=663, failed=9041`, exit 0).
Error signature: `QdrantVectorDBStorage[lightrag_vdb_entities]: CUDA out of memory. Tried to
allocate 4.68 GiB … 74.38 GiB is allocated by PyTorch` during entity/relation VDB flushes.

**Root cause (DB-size-driven, NOT a leak, NOT introduced by the efficiency layer):**
Qwen3-Embedding-8B's SentenceTransformer config defaults `max_seq_length=32768`. LightRAG's
merged entity/relation descriptions grow with the KG; one `EMBED_BATCH=64` micro-batch padded
to a long straggler allocates multi-GiB activation tensors (4.68 GiB ≈ one 64×8k×4096 bf16
tensor), and `EMBED_FUNC_MAX_ASYNC=2` concurrent forwards ratchet allocated memory to 74/79 GiB.
It appears "after hours" only because descriptions lengthen as docs accumulate — the
pre-efficiency code has the same latent bug and would hit it as the store grows.

**Fix (shipped in `pipeline/ingest.py`, 2026-07-03):**
- `EMBED_MAX_SEQ` (default **4096**) — caps the model's `max_seq_length` at load. Chunks
  (≤640 tok + blurb) are unaffected; only pathological merged descriptions truncate.
- `_encode_oom_safe()` — wraps `model.encode`; on any OOM `RuntimeError` (incl. cuBLAS alloc
  failures) it `torch.cuda.empty_cache()`s and halves the micro-batch down to 1, so a single
  long-text batch degrades one call instead of storming every embed for the rest of the run.
- `EMBED_TRIM_GB` (default **40**) — post-encode `empty_cache()` whenever reserved memory
  exceeds this, so hours-long runs don't ratchet toward the 80 GiB ceiling.
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` set via `os.environ.setdefault` in
  `ingest.py` (slurm-exported value wins).
- Observability: `oom_retries=` / `cache_trims=` appended to the `[STATUS] LLM/Embed` line.

**Recovery recipe for a cascade-failed run:** the failed docs are storm casualties, not bad
inputs — back up `kv_store_doc_status.json`, flip `failed → pending`, resubmit (resume mode
reuses the LLM-response cache). Also: submit ingest with the CURRENT slurm script — it carries
`#SBATCH --signal=B:TERM@600` (P11); older copies lose vectors at walltime.

**Interaction with P4 (dedicated embed server):** P4 remains the cleaner long-term shape (the
ingest H100 freed for a 4th vLLM), but is no longer *required* for stability. If P4 lands,
apply the same `max_seq_length` cap + OOM-halving inside `scripts/server.py`.
