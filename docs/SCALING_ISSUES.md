# AP-RAG Scaling Issues — Evidence Dossier for Review

**Written:** 2026-07-09, mid-ingest of the full Westbury corpus (4,397 / 9,712 papers processed, 45%).
**Purpose:** hand an external reviewer (LLM or human) everything needed to resolve or mitigate the scaling problems we have hit — with real measurements, root causes, current mitigations, and the constraints any fix must respect. The corpus target is 9,712 papers now, but the system **must scale cleanly past 10,000 and potentially far beyond**, and the query side must stay efficient enough to run permanently on a single consumer Windows PC.

Everything below was observed in production runs on Alliance Canada clusters (H100/A100) during 2026-07-06 → 07-09 unless noted.

---

## 1. System snapshot (what exists today)

- **Engine:** stock [LightRAG](https://github.com/HKUDS/LightRAG) (`lightrag_hku`, nested unmodified in `LightRAG/`), driven by `pipeline/ingest.py`. All AP-RAG behavior is injected (custom `chunking_func`, LLM/embed functions, runtime instance swaps). **The fork is deliberately patch-free** — see Constraints (§5).
- **Ingest LLM:** Qwen3.6-35B-A3B (MoE, BF16) served by vLLM on 2×H100 (TP=2) or 4×A100 (TP=4), 6-8 servers, round-robined with failover/adoption. **Embedder:** Qwen3-Embedding-8B (dim **4096**), in-process on the ingest job's GPU. **Query LLM:** gpt-5-mini (OpenAI API), on the PC.
- **Chunking:** custom structure-aware scientific chunker, target 512 tok / max 640 / min 192 / overlap 51. ~40–46 chunks per paper.
- **Storage (LightRAG working dir `rag_storage_full/`):** NetworkX graph persisted as **a single GraphML file**, KV stores as **single JSON files**, chunk vectors in **Qdrant** (Apptainer sidecar on node-local NVMe during ingest; on the PC at query time).
- **Key non-default toggles now canonical:**
  - `SKIP_ENTITY_RELATION_VDB=1` — entity/relation vector upserts disabled during ingest (see §3.1); vectors built by a mandatory final reembed pass.
  - `FORCE_LLM_SUMMARY_ON_MERGE=100`, `SUMMARY_MAX_TOKENS=1200`, `SUMMARY_CONTEXT_SIZE=12000` — "hub-only" inline summarization (see §3.2).
  - `KV_FLUSH_INTERVAL=3600` — giant-file flushes throttled to hourly (see §3.3).
  - `MAX_PARALLEL_INSERT=32`, `PARALLEL_DOCS=64`, `LLM_MAX_ASYNC=128`, `EMBED_BATCH=16–32`, `EMBED_MAX_SEQ=4096`.
  - Ingest jobs `--signal=B:TERM@1200` (20-min grace for final flush; 600s proved insufficient).

### Measured scale at 45% (4,397 docs) and projections

| Metric | @4,397 docs (measured) | @9,712 docs (linear proj.) | @25,000 papers (proj.) |
|---|---|---|---|
| Graph nodes | 1,552,433 | ~3.4M | ~8.8M |
| Graph edges | 3,114,413 | ~6.9M | ~17.7M |
| `graph_chunk_entity_relation.graphml` | **2.67 GB** | ~5.9 GB | ~15 GB |
| `kv_store_llm_response_cache.json` | **7.07 GB** | ~15.6 GB | ~40 GB |
| `kv_store_relation_chunks.json` | 857 MB | ~1.9 GB | ~4.9 GB |
| `kv_store_text_chunks.json` | 752 MB | ~1.7 GB | ~4.3 GB |
| `kv_store_full_docs.json` | 712 MB | ~1.6 GB | ~4 GB |
| whole `rag_storage_full/` | **15.5 GB** | ~34 GB | ~88 GB |

(Linear projection is pessimistic for *nodes* — entity dedup adds sublinearity — but roughly right for edges/chunks/caches. Treat as planning numbers.)

**Vector volumes at dim 4096 (fp32 = 16 KB/vector):**

| Collection | @9,712 docs | fp32 size | int8-quantized |
|---|---|---|---|
| chunks (~45/doc) | ~440K vectors | ~7 GB | ~1.8 GB |
| entities | ~3.4M | **~54 GB** | ~14 GB |
| relations | ~6.9M | **~110 GB** | ~28 GB |
| **total** | ~10.7M | **~171 GB** | **~44 GB** |

That fp32 total is the single scariest number for the PC (§3.7).

---

## 2. Executive summary of the issues

| # | Issue | Status | Severity at 10K+ |
|---|---|---|---|
| 3.1 | Per-merge entity/relation vector upserts (write amplification) | **Solved** (skip + final reembed) | closed, but creates §3.6 |
| 3.2 | Unbounded merged entity descriptions → merge wall | **Mitigated** (hub-only summarization @100) | medium — re-summarization churn grows |
| 3.3 | Monolithic GraphML + in-RAM NetworkX graph | **Open — the big one** | **high** |
| 3.4 | Monolithic JSON KV stores (7 GB cache file at 45%) | Open | high |
| 3.5 | Embedder OOM on giant merged descriptions | Mitigated (guards) | low (root cause bounded by §3.2) |
| 3.6 | Mandatory final reembed pass (~10.7M vectors on 1 GPU) | Open — unquantified cost | medium-high |
| 3.7 | PC serving footprint (RAM/VRAM/latency at 3.4M+ nodes) | **Open — user-flagged priority** | **high** |
| 3.8 | Retrieval quality at scale (hub domination, top-k dilution) | Open — unmeasured | unknown |
| 3.9 | Interruption-driven ingest (walltime cycles redo in-flight work) | Partially mitigated | medium (operational) |
| 3.10 | Observability blackouts (hourly flush hides progress) | Open — cheap fix available | low but causes ops mistakes |

---

## 3. The issues in detail

### 3.1 Per-merge entity/relation vector upserts — write amplification (SOLVED, kept for context)

**Symptom.** At ~1.4M graph nodes, ingest throughput collapsed. Logs showed single-entity vector upserts taking **~109 s each**, and periodic "mega-flush" stalls of 40+ minutes with zero doc completions. Earlier in the corpus the same code was fast.

**Root cause.** Stock LightRAG upserts entity/relation vectors into the VDB **on every merge**, per entity. A hub entity that appears in thousands of papers gets re-embedded and re-upserted thousands of times; the NanoVectorDB JSON backend also rewrites large files per flush. Cost grows superlinearly with graph size × hub frequency.

**Fix (validated).** `SKIP_ENTITY_RELATION_VDB=1`: a `_SkipWriteVDB` proxy wrapper is swapped over `rag.entities_vdb` / `rag.relationships_vdb` after `initialize_storages()` — `upsert()`/`delete()` become no-ops, everything else delegates. Entity/relation vectors were already going to be rebuilt by the reembed pass at corpus end, so in-ingest writes were pure waste. Patch-free (instance swap in `pipeline/ingest.py`). After the fix the run advanced immediately (proc 3,614 → 4,397 across cycles, `oom_retries=0`, `failed=0`).

**Residual.** The final reembed pass now carries all that cost in one place — see §3.6.

### 3.2 Unbounded merged entity descriptions → the merge wall (MITIGATED)

**Symptom.** With the fix from §3.1 active, throughput collapsed again at ~1.5M nodes: `proc` frozen for 50+ min at a time, `rate=0/hr`, while extraction stayed healthy (~2.4 chunks/s). Logs showed the pipeline grinding through a **6,090-stage merge batch at ~0.4–3 stages/min**, bimodal — ordinary entities merged fast, hub entities (MEMORY, PARTICIPANTS, WORD FREQUENCY…) took minutes each.

**Root cause.** For efficiency we had disabled *all* inline entity summarization ("defer-mode": `FORCE_LLM_SUMMARY_ON_MERGE/SUMMARY_MAX_TOKENS/SUMMARY_CONTEXT_SIZE = 1e9`) because LightRAG's default (`FORCE_LLM_SUMMARY_ON_MERGE=8`) fires an LLM summary call on virtually **every** entity merge — a call flood that had throttled ingest earlier. But with summarization fully off, hub-entity descriptions **grow without bound** (MB-scale strings after 4,000 papers). Merging a new fragment into an N-megabyte description — string concat, tokenization, graph-node rewrite — is O(N) each time, so hubs get slower forever. Two failure modes, one per extreme:
- threshold **8** (default): LLM summary flood — millions of calls.
- threshold **1e9** (defer): unbounded descriptions — merge wall + §3.5 embedder OOMs.

**Fix (validated).** Middle threshold: `FORCE_LLM_SUMMARY_ON_MERGE=100` with sane bounds (`SUMMARY_MAX_TOKENS=1200`, `SUMMARY_CONTEXT_SIZE=12000`). Only entities exceeding 100 accumulated fragments — the few thousand true hubs — ever get summarized (bounded ~1200 tok); the millions of ordinary entities never trigger an LLM call, preserving defer-mode's speed. LightRAG map-reduces over-long description lists in `SUMMARY_CONTEXT_SIZE` windows, so the pre-existing MB-scale descriptions are paid down safely. Validated: the next 4h cycle advanced +238 docs with zero stalls and `failed=0`.

**Residual risks at 10K+ papers.**
1. **Re-summarization churn:** a hub crossing 100 fragments repeatedly (every ~100 new mentions → another summary-of-summary). At 25K papers a top hub could be re-summarized hundreds of times → cost + semantic drift (progressive abstraction may lose specifics). Possible directions: higher threshold tiers, "summarize once then append-window", or a max-summaries-per-entity cap; also consider splitting mega-hubs into typed sub-entities.
2. **Threshold tuning is corpus-dependent:** 100 was chosen by reasoning, not sweep. The right invariant is probably *bounded description length*, not fragment count.
3. `finalize_summaries.py` (end-of-corpus pass) must still handle the 8–100-fragment middle band — count and cost unmeasured (§3.6).

### 3.3 Monolithic GraphML + in-RAM NetworkX graph (OPEN — the central scaling wall)

**Symptom(s), all measured:**
- The graph is persisted by **rewriting one GraphML file in full**: 2.67 GB at 1.55M nodes / 3.11M edges. A full write takes **~10 minutes** on Lustre.
- A **1.86 GB orphaned `.tmp`** file sits in `rag_storage_full/` — evidence of a flush killed mid-write (walltime). The atomic-rename pattern protected the main file, but the flush work was lost.
- An earlier run **lost its Qdrant sync** because the ~10-min GraphML flush consumed nearly the whole 600 s SIGTERM grace window (we now run `--signal=B:TERM@1200`, and 20 min of every walltime is effectively reserved for exit flushing).
- To keep ingest throughput, flushes are throttled to hourly (`KV_FLUSH_INTERVAL=3600`) — which creates the observability blackout of §3.10 and means **up to an hour of merge work is lost** on any hard kill.
- The whole graph also lives **in RAM as a NetworkX object** on the ingest node (and must be loaded on the PC for queries). Python-object overhead at 3.4M nodes / 6.9M edges with text attributes plausibly reaches **tens of GB**, and GraphML parse time at startup grows with it (already minutes; will be tens of minutes at full corpus).

**Root cause.** `NetworkXStorage` + GraphML is LightRAG's default toy-scale backend: O(graph) serialization per flush, O(graph) RAM, O(graph) parse at load. Write cost grows with *total* graph size while useful work per flush stays constant → the flush/work ratio degrades monotonically. At 25K papers (~15 GB GraphML) this design is untenable.

**Directions for the reviewer.** LightRAG has **pluggable graph storage** (config, not patch): Neo4j, PostgreSQL+AGE, Memgraph backends exist upstream. Migrating means: incremental writes (no full-file rewrites), no full-graph RAM residency, near-instant restart, and the PC could run the same store as a service. Costs to evaluate: a DB service on HPC ingest nodes (Apptainer sidecar, like Qdrant today — precedent exists), migration of the existing GraphML, PC-side resource footprint of the DB, and keeping the "expensive intermediates are portable files" property that the cross-cluster race workflow depends on (a DB dump is portable but heavier to sync than a file). An intermediate option: keep NetworkX in-RAM for ingest speed but replace GraphML persistence with incremental append-log + periodic compaction.

### 3.4 Monolithic JSON KV stores (OPEN)

**Symptom.** `kv_store_llm_response_cache.json` is **7.07 GB at 45%** (~16 GB projected; ~40 GB at 25K papers). Others: relation_chunks 857 MB, text_chunks 752 MB, full_docs 712 MB, entity_chunks 514 MB. Every flush serializes and rewrites entire files. `json.load` of the cache **OOM-kills login-node processes already** (we check integrity with `tail -c` instead). Cross-cluster state sync (the race pattern) moves ~13–16 GB per hop mostly because of this one file.

**Root cause.** `JsonKVStorage` = whole-store-in-RAM + whole-file rewrite. Fine at 76 papers (the original CML corpus), quadratic-ish total I/O as the corpus grows.

**Directions.** LightRAG supports KV backends (Redis, PostgreSQL, Mongo) — again config, not patch. The LLM-response cache is append-mostly and hash-keyed: even a simple sharded/append-only file layout (or SQLite/RocksDB) would eliminate the rewrite cost and the login-node OOM hazard. Also consider whether the response cache needs to be **portable** at all once a corpus is done (it exists to make re-runs cheap; archiving it out of the hot path may be enough).

### 3.5 Embedder OOM on giant merged descriptions (MITIGATED; root cause now bounded)

**Symptom (historical).** In-process Qwen3-Embedding-8B hit CUDA OOM cascades when defer-mode hub descriptions (tens of thousands of tokens) were embedded on merge; worst case crashed the ingest GPU job.

**Mitigations in place** (`pipeline/ingest.py`): `EMBED_MAX_SEQ=4096` truncation cap (chunks are ≤640 tok and never truncated; only pathological merged descriptions were affected), `_encode_oom_safe` (batch-halving retry + `empty_cache`), `EMBED_TRIM_GB=40` VRAM trim. With §3.2 bounding descriptions to ~1200 tok, the guard rails should rarely trigger — keep them anyway.

### 3.6 The mandatory final reembed + finalize pass (OPEN — unquantified single-GPU cost)

Because of §3.1, **entity and relation vectors are not built during ingest**. At corpus end we must run:
1. **Reembed** (`REBUILD_EMBEDDINGS=1` mode): embed ~3.4M entity descriptions + ~6.9M relation descriptions + verify ~440K chunks → **~10.7M embeddings** on a single GPU (the reembed job), then bulk-upsert into Qdrant. Back-of-envelope at an optimistic 300–600 short-text embeds/s: **5–10 hours** of pure embedding, plus Qdrant ingestion. Untested at this volume; needs a measured pilot (e.g., time 100K entities) and probably multi-GPU sharding or at least a dedicated 12h job.
2. **`finalize_summaries.py`**: LLM-summarize entities in the 8–100-fragment band that inline summarization never touched. Count unknown (likely tens of thousands) → needs the vLLM fleet again. Should be measured and possibly folded into the same job as (1).

**Direction.** Quantify both (they gate "corpus done"); consider making reembed shard-parallel across N GPU jobs (Qdrant handles concurrent upserts); consider embedding entities *incrementally* during idle vLLM capacity windows instead of one big bang — but only if it doesn't reintroduce §3.1.

### 3.7 PC serving efficiency (OPEN — explicitly prioritized by the owner)

The permanent query host is a single always-on **Windows PC** (stack at `C:\rag_server`: `query_server.py` :8001, embedder server :8000, Qdrant :6333, three SYSTEM scheduled tasks). Known constraints: the embedder already runs **8-bit quantized** to fit VRAM (implies a ~12–16 GB-class consumer GPU); exact CPU/RAM/GPU model should be filled in by the reviewer (`ssh pc` was unreachable at writing time). lightrag 1.5.3, Python venv, Qwen3-Embedding-8B (8-bit), answers via OpenAI API (gpt-5-mini) so no local LLM.

**The problems at 10K+ papers:**
1. **Vector RAM:** ~171 GB fp32 total (§1 table) cannot live in PC RAM. Even chunks-only (7 GB) plus entities (54 GB) is out of reach. **Required:** Qdrant scalar quantization (int8 ≈ 44 GB total) *plus* on-disk/memmap storage with only quantized vectors + HNSW in RAM, or Matryoshka-truncated dims — Qwen3-Embedding supports MRL, so entity/relation vectors could be stored at e.g. 1024-dim (÷4 memory: ~11 GB int8 total) **if** LightRAG's per-collection dim assumptions are checked (it currently assumes one `EMBEDDING_DIM` everywhere; chunks could stay 4096 while entities/relations go smaller only if the query path embeds queries per-collection — needs verification; a patch-free wrapper may suffice since we already own the embed function).
2. **Graph RAM + startup:** loading a ~6 GB GraphML into NetworkX on the PC = long startup (tens of minutes) and tens of GB RAM (§3.3). A server-grade graph backend on the PC (Neo4j/Postgres, same as §3.3) or a compact binary graph format would fix both. Note `query_server.py` loads the store **once** at boot — restarts are already painful today (minutes) and will get worse.
3. **Query latency:** local/hybrid modes do multi-collection vector search + multi-hop graph traversal. At 3.4M nodes with hub entities of degree 10⁴–10⁵, naive neighborhood expansion explodes — needs degree caps / top-k pruning verified at this scale (LightRAG has some; measure, don't assume).
4. **Embedder throughput:** one 8-bit 8B model serves both `/query` embedding and any reembed/backfill — fine for interactive load, but batch jobs (e.g., metadata-filtered `aprag search` sweeps) should be rate-limited to keep p95 latency sane.
5. **Concurrency ceiling:** all of the above shares one consumer box (plus Tailscale). Define a target (e.g., 4 concurrent queries < 10 s p95 at 10K papers) and load-test against it; right now no number exists.

### 3.8 Retrieval quality at scale (OPEN — no evals yet)

Unmeasured risk: as the corpus grows, (a) hub entities dominate local-mode retrieval (everything is near MEMORY), (b) top-k chunk retrieval dilutes — relevant chunks fall below k among 440K+, (c) global-mode community summaries get broader and vaguer, (d) answer-LLM context budgets force harder triage. None of this has an evaluation harness. **Direction:** build a small gold QA set (20–50 questions with known source papers) and track retrieval hit-rate per mode as the corpus grows — before tuning anything blind. The metadata-filtered search path (`aprag search`, filters on `/query`) is the existing pressure valve — scoping queries by author/year/topic shrinks the effective corpus per query and should be surfaced more aggressively at scale.

### 3.9 Interruption-driven ingest on shared HPC (context + partial mitigations)

Not a code bug, but the operating regime any fix must survive: GPU walltimes are short (4h cycles currently — 12h jobs stopped backfilling during daytime contention), so the pipeline dies and resumes many times per corpus. Each death: in-flight docs (~170–200 at `PARALLEL_DOCS=64`) are self-heal-reset to `pending` and **redone** next cycle (LLM cache makes redo cheap-ish but not free); vLLM cold-start burns ~10 min/cycle/server; the ingest `sys.exit(1)`s if no endpoints appear within 3h (a starving ingest job wastes its slot — happened twice this week); merge batches lost mid-flight lose up to `KV_FLUSH_INTERVAL` of work (§3.3). Mitigations already in: endpoint adoption/eviction (`endpoint_refresh_loop`), resume-skip + self-heal, `MAX_PARALLEL_INSERT` halved 64→32 for finer checkpointing, 1200s grace. **The structural fix is cheaper checkpoints (§3.3/§3.4) — flush cost, not scheduler behavior, is what makes interruptions expensive.**

### 3.10 Observability blackouts (OPEN — cheap fix)

Because doc-status persists only at the hourly KV flush, `[STATUS] processed=` freezes for up to an hour while work proceeds — this produced repeated **false stall alarms** (and one real stall was initially dismissed as a flush artifact; the inverse error is worse). **Direction:** decouple the tiny doc-status flush (15 MB) from the giant KV/graph flush, or emit a one-line JSON heartbeat (docs done, chunks extracted, merge-stage x/y, last-flush age) every N minutes to a separate file. Trivial, high leverage for unattended operation — every ops mistake this week traced back to guessing pipeline state through a frosted window.

---

## 4. Cross-cutting: what actually happened this week (timeline distilled)

1. Ingest stalled at 3,614 docs — diagnosed §3.1 (109s upserts) → shipped `SKIP_ENTITY_RELATION_VDB=1` → advanced.
2. Stalled again ~4,034–4,159 — diagnosed §3.2 (merge wall; 6,090-stage batch at 0.4–3 stages/min; extraction healthy throughout) → shipped hub-only summarization (=100, after catching that reverting to default 8 would re-create the original call-flood) → next cycle +238 docs, zero stalls, `failed=0`.
3. Since then the binding constraint is **HPC scheduling** (multi-GPU vLLM jobs won't backfill during daytime; explicitly out of scope here) — the *code* currently ingests cleanly at ~60–100 docs/hr when GPUs are up.
4. All fixes are env-var/wrapper-level; the LightRAG fork remains patch-free.

## 5. Constraints any solution must respect

1. **LightRAG stays unmodified.** Upgradability is the point of the architecture. Allowed: env/config (incl. switching to upstream-supported storage backends), injected functions, runtime instance swaps/wrappers from `pipeline/`. Not allowed: editing `LightRAG/` internals.
2. **Embedding dim is 4096** (Qwen3-Embedding-8B) and must match between index and query time. Any dim change (e.g., MRL truncation for entity vectors) requires a coordinated reembed + query-path change, and is only attractive if it solves the PC footprint (§3.7).
3. **Databases cannot be file-merged.** Combining corpora means one `WORKING_DIR`, incremental ingest.
4. **HPC realities:** 4–12h walltimes with kills; some clusters' compute nodes have **no internet** (Narval/Trillium); node-local NVMe exists (Qdrant sidecar precedent); cross-cluster state moves via Globus (portable-files property is operationally valuable).
5. **The PC is the permanent serving host** — solutions must fit a consumer box (define + verify its exact specs), not assume a server.
6. **Cost posture:** ingest LLM is self-hosted (free-ish GPU-hours); query LLM is paid API (gpt-5-mini); avoid designs that multiply per-query API tokens.

## 6. Pointers for the reviewer

- `pipeline/ingest.py` — all env plumbing; `_SkipWriteVDB` (§3.1); `EMBED_MAX_SEQ` / `_encode_oom_safe` (§3.5); endpoint discovery/failover/adoption (§3.9); `KV_FLUSH_INTERVAL` throttling; SIGTERM grace handling.
- `LightRAG/lightrag/operate.py` — `_handle_entity_relation_summary` (~line 265: threshold/map-reduce logic of §3.2); merge paths (~1533–2895: the only in-ingest users of entity/relation VDBs, basis for §3.1's safety).
- `LightRAG/lightrag/lightrag.py` (~366, 530, 535) — env-var config resolution (`FORCE_LLM_SUMMARY_ON_MERGE`, `SUMMARY_MAX_TOKENS`, `SUMMARY_CONTEXT_SIZE`).
- `LightRAG/lightrag/kg/` — storage implementations incl. NetworkX/GraphML and the pluggable alternatives (§3.3/§3.4).
- `scripts/finalize_summaries.py`, reembed mode in `pipeline/ingest.py` (`REBUILD_EMBEDDINGS=1`) — §3.6.
- `query_server.py`, `scripts/server.py`, `docs/APRAG_ACCESS.md`, `docs/PC_OCTEN_SETUP.md` — PC serving stack (§3.7).
- `docs/CANONICAL_INGEST_PARAMS.md`, `docs/INGEST_EFFICIENCY_OPEN_PROBLEMS.md` (§9–10 cover the embedder OOM and defer-mode history), `docs/CHUNKER_AND_PIPELINE_NOTES.md`.

**Deliverable requested from the reviewer:** for each OPEN item (§3.3, §3.4, §3.6, §3.7, §3.8, §3.10): a concrete, constraint-respecting design (backend choice/config, migration path from current files, HPC + PC deployment shape, and a validation plan), roughly ordered by leverage: §3.3 and §3.7 first — they share a solution space (real graph + quantized/on-disk vectors), and everything else hangs off them.
