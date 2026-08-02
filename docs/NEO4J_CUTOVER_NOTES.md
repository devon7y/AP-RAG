# Neo4j cutover — field notes from the first live runs (2026-07-15/16)

**Status: VALIDATED END-TO-END.** Fir ran a real ingest cycle on `Neo4JStorage`: docs completed past the 5,798 baseline, 8 vLLMs feeding it, zero graph errors. This file records every failure found going from "174 tests green" to "corpus advancing on Neo4j", so the fixes can be baked into the repo permanently. Line refs are from the tree at the time of writing — re-grep symbols if drifted.

The implementation itself (GRAPH_STORAGE injection, marker guard, sidecar, migrate `--ingest-graph`, export script) is described in [INGEST_SCALING_BOTTLENECK.md](INGEST_SCALING_BOTTLENECK.md); this doc is only what live runs surfaced on top of it.

## Fixes found live (in discovery order)

1. **`--cleanenv` on the sidecar's `apptainer run`** — *applied in `slurm/neo4j_sidecar.sh`*.
   Apptainer forwards the host env by default, and Neo4j treats **every** `NEO4J_*` env var as a config key. The sidecar's own knobs (`NEO4J_SUBDIR`, `NEO4J_HEAP`, …) leaked in → `Failed to read config: Unrecognized setting. No declared setting with name: SUBDIR` → strict validation refused to boot (sidecar dead in 6 s). Only the explicit `--env NEO4J_server_*` config (and `NEO4J_AUTH`) may reach the container.

2. **tiktoken cannot download on compute nodes** — *must be in every migrate AND ingest job env*.
   Importing LightRAG triggers a tiktoken fetch of `o200k_base` from `openaipublic.blob.core.windows.net`; compute nodes time out (Narval/Trillium have no internet at all). Pre-cache once per cluster from a login node, then export the cache dir in jobs:
   ```bash
   mkdir -p $WORKDIR/tiktoken_cache
   TIKTOKEN_CACHE_DIR=$WORKDIR/tiktoken_cache venv/bin/python -c \
     "import tiktoken; [tiktoken.get_encoding(e) for e in ('o200k_base','cl100k_base')]"
   # every sbatch: --export=ALL,TIKTOKEN_CACHE_DIR=$WORKDIR/tiktoken_cache,...
   ```

3. **Migrate speed: defaults are ~20× too slow on Lustre** — *use these as the migrate job's new defaults*.
   Untuned (2k/1k batches, 3 GB pagecache): ~245 edges/s on Rorqual → blows the 3 h walltime at 4.3 M edges. Tuned: `NODE_BATCH=10000, EDGE_BATCH=10000, NEO4J_PAGECACHE=20G, NEO4J_HEAP=8G, --mem=48G` → 2,050/s (Ror Lustre), ~11,800/s (Nibi VAST), ~15,600/s (Fir NVMe-Lustre): full 2.03 M-node / 4.28 M-edge migrate in 7–67 min depending on storage. Raise the script's `#SBATCH --mem=32G` and 2k/1k defaults accordingly.

4. **`APPTAINER_CACHEDIR` must point at scratch on Fir** — Fir's `$HOME` quota kills `apptainer pull` (`disk quota exceeded` in `~/.apptainer/cache`). Export `APPTAINER_CACHEDIR=$WORKDIR/.apptainer_cache` before pulls and in job envs.

5. **`GRAPH_STORAGE` must be passed via `--export`, and the job script must preserve it.**
   The ingest scripts had `GRAPH_STORAGE=""` (hardcoded) and relied on `neo4j_start`'s in-script `export` — which did **not** reach the python child. Python saw it empty → defaulted to NetworkX → the marker guard (correctly) aborted: `Refusing to fork the graph`. Fix (applied to `_fir/_ror/_nibi/_nar` in `slurm/`): line ~138 → `GRAPH_STORAGE="${GRAPH_STORAGE:-}"`, and submit with `--export=ALL,GRAPH_BACKEND=neo4j,GRAPH_STORAGE=Neo4JStorage,...`. (The guard doing its job here is why nothing forked.)

6. **Deploy target is the FLAT `$WORKDIR` script, not `$WORKDIR/slurm/`.**
   Operational convention on all clusters is `cd $WORKDIR && sbatch job_westbury_ingest_v2_<c>.slurm` — the **flat** copy. Repo-side fixes rsynced to `$WORKDIR/slurm/` are silently ignored by that submit. Verified via `scontrol show job → Command=`. Either deploy to both paths (current practice: `cp $WORKDIR/slurm/job_… $WORKDIR/`) or change the runbooks to submit `slurm/job_…`. This single gotcha invalidated an entire round of race submissions.

7. **The Narval ingest script had no Neo4j wiring at all.**
   `job_westbury_ingest_v2_nar.slurm` predated the cutover work and lived only on the cluster. It now exists in the repo **with** the wiring (sidecar source + `neo4j_guard`/`neo4j_start` + `GRAPH_STORAGE` passthrough into the python env + watchdog + `neo4j_stop`). Keep it in the repo.

8. **BUG (was fatal): the migrate imported every GraphML attribute as a string.**
   `scripts/migrate_to_db_backends.py::_iter_graphml` read `(d.text or "")` and ignored the file's `attr.type` declarations (`weight` is `double`, `created_at` is `long`). Result: Neo4j edges with string weights → in LightRAG's merge path (`operate.py` `_merge_edges_then_upsert`, `weight = sum([...floats...] + already_weights)`) → `TypeError: unsupported operand type(s) for +: 'float' and 'str'` → **every doc failed**; a full 3 h cycle extracted 1,348 times and completed 0 docs. *Fixed in the repo*: `_graphml_cast()` casts by declared type (`double/float`→float, `long/int`→int, fallback defaults 1.0/0 on malformed text). Any store migrated with the old script must be re-migrated (or patched: `MATCH ()-[e]->() SET e.weight = toFloat(e.weight)` + same for `created_at`/node props).

9. **Neo4j driver pool exhaustion under ingest concurrency** — *env-only fix, add to every Neo4j ingest submit*.
   With `MAX_PARALLEL_INSERT=16 / LLM_MAX_ASYNC=32`, the driver's default pool produced `ConnectionAcquisitionTimeoutError` (×22) + `SocketDeadlineExceededError` (×13) in one cycle. LightRAG reads these envs directly (`LightRAG/lightrag/kg/neo4j_impl.py` ~:181-236):
   `NEO4J_MAX_CONNECTION_POOL_SIZE=256, NEO4J_CONNECTION_ACQUISITION_TIMEOUT=180`. Validated: zero pool errors in the winning run.

## Operational decisions that are now standing policy

- **Gate vLLMs on the ingest** (user directive): submit the ingest FIRST (no dependency), then the 8 vLLM jobs with `--dependency=after:<ingest>`. One idle ingest GPU ≫ 16 idle vLLM GPUs; races become 1-GPU contests. (With `--dependency=afterok:<migrate>` on the ingest when a migrate precedes it.)
- **Walltime 3h** for backfill-ability while fairshare is burned (was 6h "for now", 10h before that — user-set; `scontrol update JobId=… TimeLimit=03:00:00` preserves queue position when shortening).
- **Race win condition is `processed > baseline`**, never "is extracting" — extraction ran for a full cycle while every doc failed (fix 8). Docs *completing* is the only real signal.
- **Summary triple:** `FORCE_LLM_SUMMARY_ON_MERGE=100, SUMMARY_MAX_TOKENS=1200, SUMMARY_CONTEXT_SIZE=12000` (the validated §3.2 set; defer-mode 1e9 is superseded).

## The known-good submit (Fir shape; adjust WORKDIR/scripts per cluster)

```bash
MIG=$(sbatch --parsable --time=03:00:00 --mem=48G \
  --export=ALL,WORKDIR=$W,STORAGE_SUBDIR=rag_storage_full,TIKTOKEN_CACHE_DIR=$W/tiktoken_cache,APPTAINER_CACHEDIR=$W/.apptainer_cache,NODE_BATCH=10000,EDGE_BATCH=10000,NEO4J_PAGECACHE=20G,NEO4J_HEAP=8G \
  slurm/job_graph_migrate_neo4j.slurm)          # once per store, or after any GraphML re-unify
ING=$(sbatch --parsable --time=03:00:00 --mem=128G --dependency=afterok:$MIG \
  --export=ALL,GRAPH_BACKEND=neo4j,GRAPH_STORAGE=Neo4JStorage,NEO4J_MAX_CONNECTION_POOL_SIZE=256,NEO4J_CONNECTION_ACQUISITION_TIMEOUT=180,STORAGE_SUBDIR=rag_storage_full,QDRANT_SUBDIR=qdrant_storage_full,PAPERS_SUBDIR=papers_full,TIKTOKEN_CACHE_DIR=$W/tiktoken_cache,APPTAINER_CACHEDIR=$W/.apptainer_cache,NEO4J_PAGECACHE=20G,NEO4J_HEAP=8G,N_VLLM=1,EMBED_MODEL_ID=Qwen/Qwen3-Embedding-8B,EMBEDDING_DIM=4096,MAX_DOC_TOKENS=20000,PARALLEL_DOCS=24,LLM_MAX_ASYNC=32,CONTEXT_MAX_ASYNC=32,EMBED_FUNC_MAX_ASYNC=16,MAX_PARALLEL_INSERT=16,FORCE_LLM_SUMMARY_ON_MERGE=100,SUMMARY_MAX_TOKENS=1200,SUMMARY_CONTEXT_SIZE=12000 \
  job_westbury_ingest_v2_<c>.slurm)             # FLAT script (fix 6)
for i in 1 2 3 4 5 6 7 8; do sbatch --time=03:00:00 --dependency=after:$ING job_westbury_vllm_<c>.slurm; done
```

## Multi-cluster consequence (important for the next race)

After a winning Neo4j cycle, the winner's **Neo4j store** is the canonical graph; the GraphML on disk is now **stale** (frozen at its migrate snapshot). Cross-cluster unification therefore becomes: `scripts/export_neo4j_graphml.py` on the winner → Globus the fresh GraphML (+ the KV stores in `rag_storage_full/`, which are still file-based and current) → **re-migrate** on each receiving cluster (fast: 7–67 min, fix 3) before it can race. The reembed freshness guard and `rebuild_graph.py`'s Neo4j-marker refusal (see INGEST_SCALING_BOTTLENECK.md follow-up work) exist for exactly this staleness.

## TODO for the implementing LLM

- Bake fixes 2/3/4/9 into the job scripts as defaults (they're currently passed per-submit via `--export`).
- Fold fix 8's caveat into `scripts/migrate_to_db_backends.py` docs/comments (done in code).
- Decide flat-vs-`slurm/` as the single deploy convention (fix 6) and update runbooks.
- Trillium: everything here applies, plus offline staging (sif + tiktoken + models) before it can join races.
