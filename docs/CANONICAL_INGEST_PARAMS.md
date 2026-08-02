# Canonical Ingest Parameters

## ⚡ Measured benchmarks — config → throughput (2026-07-26)

**Stop re-deriving this.** Every row below was measured from real job logs, not
estimated. Rate = `(last processed − first processed) ÷ elapsed`. Re-verify any row
with `sacct -j <jobid> -X --format=SubmitLine%600`.

| Job | Cluster | Model | vLLM endpoints | `PARALLEL_DOCS` | `LLM_MAX_ASYNC` | `CONTEXT_MAX_ASYNC` | `MAX_PARALLEL_INSERT` | `KV_FLUSH_INTERVAL` | **docs/hr** | Sample |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **49860263** | Fir | FP8 | **6** | **96** | **256** | **256** | **64** | **3600** | **348** ⭐ | +1993 in 5h43m |
| 49803658 | Fir | FP8 | 1 | 64 | 128 | 128 | 32 | 3600 | 95 | +545 in 5h42m |
| 51282120 | Fir | FP8 | 3 | 32 | 128 | 64 | 32 | 600 | 133 | +237 in 1h46m |
| 50346254 | Fir | FP8 | 3 | 32 | 128 | 64 | 24 (dflt) | dflt | 118 | +116 in 58m |
| 17448953 | Nibi | BF16 TP=2 | 1 | 64 | 128 | 128 | 32 | 300 | 55.7 | +656 in 11h47m |
| 17989004 | Nibi | BF16 | 1 | 64 | — | — | — | — | 61 | +171 in 2h46m |

### Use this (proven fastest, job 49860263)

```bash
PARALLEL_DOCS=96  LLM_MAX_ASYNC=256  CONTEXT_MAX_ASYNC=256  MAX_PARALLEL_INSERT=64
KV_FLUSH_INTERVAL=3600  EMBED_BATCH=32  EMBED_FUNC_MAX_ASYNC=3  EMBEDDING_BATCH_NUM=128
sbatch --mem=384G --cpus-per-task=32 --time=Xh --signal=B:TERM@300
```

plus **6 vLLM endpoints** (`N_VLLM=1` only gates the *start*; the rest are auto-adopted
via `ENDPOINT_REFRESH_S`). Endpoint count is a first-class lever: 49860263 vs 49803658
is the same era and near-identical duration (5h43m vs 5h42m), and the 6-endpoint /
double-lane config was **3.7× faster**.

### Two traps that cost real time

1. **Reduced lanes silently inherited.** Job 51282120 ran 32/128/64/32 — ⅓ the doc
   lanes and ¼ the context lanes of the fast config — giving 133 vs 348 docs/hr. These
   low values live on in old keeper/NENV snippets; always diff a submit line against
   the ⭐ row before launching. (A 2026-07-13→16 regression to 13–15 docs/hr had the
   same root cause: stale `LLM_MAX_ASYNC=32` copied out of docs.)
2. **Do NOT raise the embedder knobs.** `EMBED_BATCH=32` / `EMBED_FUNC_MAX_ASYNC=3`
   are correct and were used by *both* the 348/hr and 55.7/hr runs. `16×batch-64`
   caused **355 CUDA-OOM retries** on 2026-07-16. Seeing `oom_retries=0` means the
   sizing is right, **not** that there is headroom to spend. Embedding is never the
   bottleneck anyway (job 51282120: 205 embed calls vs 33,438 LLM calls).

### How to tell what is actually limiting a live run

Read the `[VLLM]` status lines:

| Symptom | Meaning | Fix |
| --- | --- | --- |
| `waiting=0`, `kv<40%` | **Endpoints starved** — the pipeline is under-driving them | Raise `PARALLEL_DOCS`, `LLM_MAX_ASYNC`, `CONTEXT_MAX_ASYNC`, `MAX_PARALLEL_INSERT` |
| `waiting>0`, `kv>70%` | Endpoints saturated | Add vLLM servers |
| `processing` pinned at `MAX_PARALLEL_INSERT` | Insert/graph stage is the cap | Raise `MAX_PARALLEL_INSERT` (32→64) |

Both 348/hr and 133/hr runs showed `waiting=0` — even the fast one was *still*
endpoint-starved (`kv=31–41%`), so there is likely headroom **above** 96/256/256/64.

⚠️ **Rate-reading gotcha:** the first `[STATUS]` tick reports the whole baseline as
one tick's work (e.g. `overall=1129050/hr`) — a startup artifact, not throughput. The
per-tick `rate=` is also quantization noise at 30 s ticks (1 doc = "120/hr", 0 = "0/hr").
Only trust `Δprocessed ÷ elapsed` over a multi-minute interval.

---

## Legacy note (superseded by the table above)

The former "canonical set" here was Nibi job **17448953** (55.7 docs/hr, BF16 TP=2,
one endpoint) — accurate for the BF16 era but **6× slower** than the FP8 ⭐ config.
Per-call latency was ~60 s then, so throughput ≈ lanes ÷ (calls/doc × 60 s); under FP8
per-call latency is ~21–24 s, which is why the lane counts had to go up to keep the
endpoints fed.

## Parameters (pass via `--export`; verify against script defaults before relying on them)

⚠️ Values below are the ⭐ **348 docs/hr** set (job 49860263). If you change one, add a
row to the benchmark table at the top with the measured result — that table is the
authority, this one is the lookup.

| Parameter | Value | Note |
| --- | --- | --- |
| `N_VLLM` | 1 (nibi/fir/ror), 3 (tril) | endpoints to wait for **before starting**; extra vLLMs registered later are auto-adopted (`ENDPOINT_REFRESH_S`). Submit **6** for max throughput — endpoint count is a first-class lever |
| `PARALLEL_DOCS` | 96 | streaming mode: bounds concurrent PDF reads |
| `LLM_MAX_ASYNC` | 256 | extraction+summary lanes (LightRAG role queue) — **the throughput knob** |
| `CONTEXT_MAX_ASYNC` | 256 | global blurb-lane cap (separate limiter from extraction) |
| `EMBED_FUNC_MAX_ASYNC` | 3 | in-process 8B bf16 embedder; 16×batch-64 caused 355 CUDA-OOM retries on 2026-07-16. **Do not raise** |
| `EMBED_BATCH` / `EMBEDDING_BATCH_NUM` | 32 / 128 | proven OOM-free with `EMBED_FUNC_MAX_ASYNC=3`. **Do not raise** |
| `MAX_PARALLEL_INSERT` | 64 | real document-level concurrency knob; the insert/graph stage is the usual cap |
| `MAX_DOC_TOKENS` | 20000 | context-prompt doc cap |
| `LLM_TEMPERATURE` / `LLM_SEED` | 0.0 / 42 | deterministic → caches hit across restarts (P2) |
| `LLM_MAX_TOKENS` / `CONTEXT_MAX_TOKENS` | 4096 / 300 | no runaway decodes (P5) |
| `CONTEXT_CACHE` / `CONTEXT_WARM_FIRST` / `CONTEXT_AFFINITY` | 1 / 1 / 1 | blurb cache + prefix warm-up + per-doc endpoint pinning (P1/P2) |
| `KV_FLUSH_INTERVAL` | 3600 | throttled ordered storage flush (P9); 0 = per-doc upstream. The 348/hr run used 3600; flushes are blocking, so 300–600 measurably costs throughput |
| `STREAM_OVERLAP` | 1 | drain starts after the first enqueue batch (P8) |
| `MAX_GLEANING` | 1 | LightRAG default; `0` halves extraction LLM calls (quality A/B first) |
| `FORCE_LLM_SUMMARY_ON_MERGE` / `SUMMARY_MAX_TOKENS` / `SUMMARY_CONTEXT_SIZE` | 100 / 1200 / 12000 | the validated middle threshold (SCALING_ISSUES.md §3.2) — see the summarization section below |
| `GRAPH_BACKEND` | networkx | `neo4j` switches the graph store to incremental Neo4j (Fix-graph) — see the graph-backend section below |

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

## Merge summarization (RESOLVED 2026-07-14: middle threshold, baked into the scripts)

**Current rule: nothing to export.** The SLURM ingest jobs now default to the
validated middle set from `SCALING_ISSUES.md` §3.2:

```bash
FORCE_LLM_SUMMARY_ON_MERGE=100   # only true hub entities (>100 fragments) summarize
SUMMARY_MAX_TOKENS=1200          # bounded description length
SUMMARY_CONTEXT_SIZE=12000       # map-reduce window for paying down oversized lists
```

History of this knob (why the docs used to disagree — see
`INGEST_SCALING_BOTTLENECK.md` "Docs/code disagreements" #1):

- **8 (LightRAG default)** — LLM summary flood: in-line summaries reached ~45% of
  extraction-side LLM calls by ~700 docs and capped throughput at ~15 docs/hr.
  This is also what the Narval 65457615 run actually executed (the old script
  default), producing the `default:summary:` log flood.
- **1e9 ("defer-mode", mandated here 2026-07-03)** — killed the call flood but let
  hub descriptions grow without bound → the §3.2 merge wall (`rate=0/hr`,
  minutes-per-hub merges) plus §3.5 embedder OOMs. **Superseded — do not use.**
- **100/1200/12000 (validated §3.2)** — hubs stay bounded, ordinary entities never
  trigger an LLM call; the next 4h cycle after the change advanced +238 docs with
  zero stalls. Now the baked default.

`scripts/finalize_summaries.py` remains the optional corpus-end tidy-up for the
8–100-fragment middle band. Validation signal: occasional `default:summary:` /
`LLMmrg` lines are expected (hubs only); a per-doc flood of them means the
threshold regressed to 8, and `rate=0/hr` stalls mean it regressed to defer-mode.

## Graph backend (Fix-graph, `INGEST_SCALING_BOTTLENECK.md`)

Default is unchanged (`GRAPH_BACKEND=networkx` → NetworkXStorage, full-file GraphML
flushes). To eliminate the O(V+E) graph rewrites, switch a store to Neo4j **once**:

```bash
# one-time per cluster: stage the image from a login node
apptainer pull $WORKDIR/neo4j_5.26-community.sif docker://neo4j:5.26-community
# one-time per store: import the GraphML and stamp .graph_backend (CPU job, ~15-20 min)
sbatch job_graph_migrate_neo4j.slurm
# every cycle after that:
sbatch --export=ALL,GRAPH_BACKEND=neo4j --time=Xh:00:00 --dependency=after:$VLLM1 \
  job_westbury_ingest_v2_<cluster>.slurm
```

The jobs refuse to run a backend that disagrees with the store's
`.graph_backend` marker (no silent graph forking); reembed cycles against a
Neo4j-backed store need a fresh GraphML snapshot first
(`scripts/export_neo4j_graphml.py`). Wired so far: fir/nibi/ror ingest v2 jobs +
`job_graph_migrate_neo4j.slurm`; the tril/generic/books jobs still run
networkx-only (the in-python guard aborts them on a migrated store).

## Reembed / `REBUILD_EMBEDDINGS=1` (measured 2026-07-27, 10,381-doc store)

**It is a FULL rebuild, not a top-up.** The rebuild skips already-embedded vectors,
which makes it *look* incremental — but ingest runs with `SKIP_ENTITY_RELATION_VDB=1`,
so the entity/relation collections are empty by design:

| Item | Count | Already embedded |
| --- | --- | --- |
| Chunks | 445,394 | 37,815 |
| Entities | 3,586,043 | 0 |
| Relations | 8,096,245 | 0 |
| **Total to embed** | **≈12.1M vectors** | |

Fixed overhead per job ≈ **25 min** (11 min GraphML export + ~14 min to parse the
1.94 GB chunk JSON + 6.89 GB GraphML). That parse is why `--mem` must be large:
**use 380–498G**. The `--mem=32G` default in `job_westbury_ingest_v2_nar.slurm` is a trap.

### The GraphML guard WILL kill the job (fixed, but know why)

`rebuild_embeddings_from_cache()` reads entities/relations via `nx.read_graphml`, not
Neo4j. Under `GRAPH_STORAGE=Neo4JStorage` the GraphML stops updating, and the Fix-graph
guard `sys.exit(1)`s within seconds if it is older than `.graph_backend`. All five
`job_westbury_ingest_v2_*.slurm` now export a fresh snapshot automatically — but only
when **`GRAPH_BACKEND=neo4j` is in the `--export` list**, because `neo4j_start` no-ops
otherwise and `NEO4J_URI` never gets set. Export cost: 6.89 GB / 3.59M nodes / 8.10M
edges / 659s.

### `EMBED_MAX_SEQ=4096` — why the cap, and what it truncates

**Keep this value.** It is not a tuning knob; it is the value the whole corpus is
embedded under, and both embed paths must agree.

Qwen3-Embedding-8B reports `max_seq_length=40960` as loaded here (observed in every
server log). At batch 64 that is ~64 GB of
attention on an 80 GB card. `pipeline/ingest.py` has capped it at 4096 since the
**2026-07-03 OOM-cascade fix**; `scripts/server.py` did **not**, so the first
multi-GPU reembed (Nibi 18589919) OOM'd its way through 2 h of 4 saturated H100s and
committed **zero** vectors. The server now carries the same cap.

Two consequences worth internalising:

- **Consistency beats headroom.** Every vector already in the store was produced at
  4096. Serving the reembed at 32768 would embed entities in a different regime from
  their own chunks — worse for retrieval than truncating a few outliers.
- **What actually gets cut (measured 2026-07-27 on the live 10,381-doc graph,
  454,705 entity descriptions sampled):**

  | metric | value |
  | --- | --- |
  | mean description | 801 chars (~200 tokens) — 20× under the cap |
  | max description | 40,082 chars (~10,020 tokens) |
  | **exceeding 4096 tokens** | **159 / 454,705 = 0.035%** (~1 in 2,900) |

  Those outliers are merge artifacts — an entity cited across hundreds of papers
  accumulates a concatenated description. Even truncated it still contributes
  ~16,000 chars, ample to place it correctly in vector space. (Sample covered the
  node section; GraphML writes all nodes before edges, so relation descriptions were
  not measured directly — they come from the same `SUMMARY_MAX_TOKENS=1200` merge
  path and should distribute similarly.)

Raising the cap re-introduces the OOM. If you ever must, raise `EMBED_MAX_SEQ` in
**both** `pipeline/ingest.py` and `scripts/server.py` together, lower `EMBED_BATCH`
to compensate, and plan a full reembed — mixed-regime vectors cannot be repaired
incrementally.

### Multi-GPU fan-out (the only way this fits a 12h window)

`EMBED_ENDPOINT` accepts a **comma-separated list**; `pipeline/ingest.py` round-robins
across it. `LOCAL_EMBED_SERVERS=N` starts one `scripts/server.py` per GPU
(`CUDA_VISIBLE_DEVICES=$i`, ports 18000+i, gated on `/health`). The rebuild *process*
needs no GPU — it is CPU/RAM-bound — so all N cards serve embeddings.

**Do not shard the rebuild itself**: each shard re-parses the 6.89 GB graph and
multiplies a ~100 GB RAM footprint by N.

```bash
sbatch --time=12:00:00 --mem=498G --cpus-per-task=32 --gpus=h100:4 \
  --signal=B:TERM@300 \
  --export=ALL,REBUILD_EMBEDDINGS=1,REBUILD_BATCH_SIZE=500,LOCAL_EMBED_SERVERS=4,\
EMBED_BATCH=64,EMBED_FUNC_MAX_ASYNC=16,EMBEDDING_BATCH_NUM=128,\
STORAGE_SUBDIR=rag_storage_full,QDRANT_SUBDIR=qdrant_tail_race,\
GRAPH_BACKEND=neo4j,GRAPH_STORAGE=Neo4JStorage \
  slurm/job_westbury_ingest_v2_<cluster>.slurm
```

`EMBED_FUNC_MAX_ASYNC` **must exceed the endpoint count** or the endpoints starve
(16 ≈ 4 in flight per GPU). `EMBED_BATCH` is the real throughput lever;
`REBUILD_BATCH_SIZE` only trims Python/upsert overhead — it is **not** a GPU multiplier.

**One reembed per cluster, ever.** Two jobs on the same cluster open the same
`neo4j_aprag` data dir concurrently and corrupt the graph.

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
