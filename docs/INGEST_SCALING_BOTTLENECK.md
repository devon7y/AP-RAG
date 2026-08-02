# Ingest-Throughput Scaling Bottleneck

**Status:** IMPLEMENTED in the repo (2026-07-14) — awaiting the one-time migration + first Neo4j-backed cycle on-cluster. What landed (all patch-free, nothing under `LightRAG/` touched):

- **Fix 1 (§P):** `GRAPH_STORAGE` env pass-through in `pipeline/ingest.py` (main + rebuild paths), a `.graph_backend` marker guard against silently forking the graph (in `check_graph_backend()`, mirrored in bash), `scripts/migrate_to_db_backends.py --ingest-graph` (graph-only import, no PG/Qdrant needed, stamps the marker), `slurm/neo4j_sidecar.sh` + wiring in the **fir/nibi/ror** ingest v2 jobs (opt-in via `--export=ALL,GRAPH_BACKEND=neo4j`; no silent fallback), `slurm/job_graph_migrate_neo4j.slurm` (the one-time CPU import job), and `neo4j` added to the setup-env jobs. Sidecar data lives on scratch (not NVMe) so there is no rsync-back loss window for the graph.
- **Fix 2 (§S):** `FORCE_LLM_SUMMARY_ON_MERGE=100` + `SUMMARY_MAX_TOKENS=1200` + `SUMMARY_CONTEXT_SIZE=12000` baked as defaults into all ingest jobs (see *Docs/code disagreements* #1, now resolved).
- **Gap found while implementing (not in the original analysis):** reembed mode (`REBUILD_EMBEDDINGS=1`) and `scripts/rebuild_graph.py` read `graph_chunk_entity_relation.graphml` **directly** — on a Neo4j-backed store that file is a frozen snapshot. Reembed now has a freshness guard (aborts on a snapshot older than the last Neo4j run) and `scripts/export_neo4j_graphml.py` re-exports the GraphML from Neo4j (also preserving the portable-archive property from the Risks section); `rebuild_graph.py` refuses Neo4j-marked stores outright.

Operator runbook: `docs/CANONICAL_INGEST_PARAMS.md` §"Graph backend". The **acceptance criteria below are still the open checklist** for the first migrated run.
**Written for:** an implementing LLM who has read `CLAUDE.md` (esp. the *patch-free vs LightRAG* rule) and can act from this doc alone.
**All line numbers are from the tree at the time of writing — re-grep the quoted symbols if they have drifted.**

---

## Summary

At corpus scale the ingest pipeline persists its knowledge graph by **rewriting the entire graph to one GraphML file on every flush** (`nx.write_graphml`, O(V+E)), and that write runs **synchronously on the single asyncio event loop**, so the whole pipeline stalls for the duration and the stall grows without bound as the graph grows (~1.98M nodes / 4.15M edges at 5,680 docs). **The fix is a config-only switch of LightRAG's `graph_storage` from the default `NetworkXStorage` (file/GraphML) to an incremental DB backend (`Neo4JStorage`), which persists per-upsert (O(delta)) instead of dumping the whole graph** — plus a one-time import of the existing GraphML into that DB via the already-present `scripts/migrate_to_db_backends.py`. A **secondary, independent** scaling driver (entity-merge re-summarization LLM churn, gated by `FORCE_LLM_SUMMARY_ON_MERGE`) is **not** solved by the backend switch and needs its own lever.

---

## Evidence (Narval job 65457615, 8h, corpus at 5,680 docs)

- Throughput collapsed to **~118 docs / 8h** (≈4 min/doc); clean SIGTERM at walltime, not a crash.
- Recurring: `INFO: [] Writing graph with 1979221 nodes, 4150021 edges` — every occurrence is **one full-graph serialization** (see Root cause §P).
- Frequent interleaved `INFO: == LLM cache == saving: default:summary:<hash>` and `default:extract:<hash>` — the `default:summary:` lines prove **in-line entity summarization was ENABLED** on this run (finite `FORCE_LLM_SUMMARY_ON_MERGE`), i.e. the secondary driver §S was active.
- Slow startup: `[CTX_CACHE] Loaded 203962 cached context blurb(s)` + loading the ~2M-node graph into RAM before the first extraction (see §D).
- One transient: a chunk hung **3,812s** on a bad vLLM endpoint (`OpenAI API Connection Error`) before the watchdog force-killed it (`Detected stuck task ... forcing cleanup`). This is a **separate reliability bug (§T)**, not the systemic scaling bottleneck.

Prior measured context (`docs/SCALING_ISSUES.md` §3.3, §7.2): a **2.67 GB** GraphML write at 1.55M/3.11M took **~10 min** on Lustre; parsing 1.63M nodes at PC boot took **~13–14 min**. At 1.98M/4.15M both are larger.

---

## Root cause (ranked)

### P — PRIMARY (systemic, unbounded growth): full-graph GraphML rewrite on the default `NetworkXStorage`

**Mechanism.** AP-RAG constructs the stock `LightRAG` class in `pipeline/ingest.py` and **never passes `graph_storage=`** (grep confirms: `pipeline/ingest.py:1855-1900` sets only `kv_storage`, `doc_status_storage`, `vector_storage`; `KV_STORAGE` is read at `pipeline/ingest.py:250` but there is **no `GRAPH_STORAGE` read anywhere in `pipeline/`**). So `graph_storage` falls to the LightRAG default:

- `LightRAG/lightrag/lightrag.py:281` → `graph_storage: str = field(default="NetworkXStorage")` (a **literal** default — it does *not* call `get_env_value`, so the `.env` key `LIGHTRAG_GRAPH_STORAGE` is dead for this path; see *Docs/code disagreements*).

`NetworkXStorage` holds the whole graph as one in-memory `networkx.Graph` and serializes it in full on every persist:

- `LightRAG/lightrag/kg/networkx_impl.py:130-139` `write_nx_graph()` → `atomic_write(file_name, lambda tmp: nx.write_graphml(graph, tmp), ...)`. `nx.write_graphml` walks **every node and every edge** → **O(V+E)** per call. The recurring log line is emitted here (`:133`).
- `LightRAG/lightrag/kg/networkx_impl.py:718-753` `index_done_callback()` calls `write_nx_graph(self._graph, ...)` at `:736`.
- **It blocks the event loop.** `atomic_write` (`LightRAG/lightrag/file_atomic.py:114`) runs `write_fn(tmp)` **directly** (`write_fn(tmp)` at ~`:132`), *not* in a thread/executor. So `nx.write_graphml` runs synchronously inside the awaited `index_done_callback`; while it runs, **no** extraction / LLM / embed coroutine makes progress. The ingest is single-process/single-loop by design (`pipeline/kv_flush_throttle.py:37-39`), so there is nowhere for the work to overlap.

**Why it scales with corpus size.** Cost per flush = O(current V+E), which grows monotonically, while **useful work per flush stays constant** (one interval's worth of new docs). The flush/work ratio therefore degrades forever. At 1.98M/4.15M each write is multi-GB and multi-minute (extrapolating the measured ~10 min @ 1.55M/3.11M). Over an 8h run these full rewrites consume a large, growing fraction of walltime doing nothing but re-serializing already-persisted data.

**Related O(V+E) costs from the same backend** (also grow with corpus, secondary within §P):
- **Startup RAM load / parse:** `__post_init__` reads the entire GraphML into a `networkx.Graph` at boot (`networkx_impl.py:164`, log at `:167`) — this is the ~13-min startup parse; paid **every walltime cycle** (interruption-driven ingest, `SCALING_ISSUES.md` §3.9).
- **RAM residency:** the full graph lives as Python objects for the whole run (tens of GB at multi-M nodes, `SCALING_ISSUES.md` §3.3/§7.2).

**Is the throttle already mitigating this?** Yes, partially — and it is already maxed. `pipeline/kv_flush_throttle.py` wraps `index_done_callback` and flushes at most once per `KV_FLUSH_INTERVAL` (default 300s, `pipeline/ingest.py:282`; installed at `:1914-1920`). The graph **is** covered: `_DATA_STORE_ATTRS` includes `"chunk_entity_relation_graph"` (`kv_flush_throttle.py:66`) and `_FILE_BACKED_CLASS_NAMES` includes `"NetworkXStorage"` (`:73-77`). **But the throttle only reduces flush *frequency*, not per-flush *cost*.** Each surviving flush is still a full O(V+E) rewrite that grows every interval, and raising the interval further just widens the crash-loss window (`SCALING_ISSUES.md` §3.3) and hides progress (§3.10). Throttling is not a remaining lever; the per-flush cost itself must be eliminated.

### S — SECONDARY (also scales, NOT fixed by §P): entity-merge re-summarization LLM churn

**Mechanism.** For each doc, `merge_nodes_and_edges` (`LightRAG/lightrag/operate.py:2914`) merges the doc's entities/relations into the graph. `_merge_nodes_then_upsert` (`:2000`) reads the **existing** node's accumulated descriptions from the graph (`:2047-2049`) and builds `description_list = already_description + sorted_descriptions` (`:2159`), then calls `_handle_entity_relation_summary` (`:2176`; edge equivalent at `:2531`). That function (`:265-347`) fires an **LLM summary call** when `len(current_list) >= force_llm_summary_on_merge` **or** `total_tokens >= summary_max_tokens` (gate at `:321-347`); otherwise it just concatenates.

**Why it scales.** As the corpus grows, (a) more of each doc's entities already exist in the graph with accumulated fragments, and (b) hot entities (MEMORY, PARTICIPANTS, WORD FREQUENCY, author names…) repeatedly cross the threshold and get **re-summarized on essentially every doc that touches them**. So summary LLM calls per doc rise with corpus size. Each Qwen3-32B summary is seconds-to-tens-of-seconds and (per §S) runs inside the per-doc merge. This is the `default:summary:<hash>` flood in the log and matches the historically observed "merge wall" (`SCALING_ISSUES.md` §3.2: throughput → `rate=0/hr`, 6,090-stage merge batches at 0.4–3 stages/min).

**Config gate.** `FORCE_LLM_SUMMARY_ON_MERGE` (field `LightRAG/lightrag/lightrag.py:366-370`, env-driven; default `8` per `LightRAG/lightrag/constants.py:30`) and `SUMMARY_MAX_TOKENS` (`lightrag.py:529`, default `1200`, `constants.py:32`). Raising the threshold makes fewer (larger) entities summarize; setting it to ~1e9 turns summarization off entirely (defer mode) but then descriptions grow unbounded → a *different* O(N) merge/embed wall (`SCALING_ISSUES.md` §3.2, §3.5). The prior chosen compromise was `100` (§3.2).

### T — TERTIARY (separate reliability bug, NOT scaling): stuck-endpoint hang

The 3,812s hang on a dead vLLM endpoint is a failover-latency bug (watchdog fired but late). It costs a fixed one-off, does not grow with corpus, and is orthogonal to §P/§S. Track it separately (tighten the per-chunk LLM timeout / stuck-task detection in `pipeline/ingest.py`); do not conflate it with the scaling fix.

### Ordering honesty (§P vs §S)

Both §P and §S grow with corpus and both are visible in the log. **From code + this single log alone I cannot prove which consumes more of the 118-docs/8h walltime** — that depends on runtime durations not in the excerpt. §P (graph flush) is bounded by `KV_FLUSH_INTERVAL` frequency but each flush is a hard multi-minute event-loop stall; §S (summaries) is spread across every doc. The measurement that settles it:

- **§P time:** the wall-clock gap between consecutive `Writing graph with … nodes … edges` log lines' start and the next pipeline log line, × flush count → total seconds blocked in `write_nx_graph`.
- **§S time:** count `default:summary:` cache-save lines per doc over the run, and read the per-merge timing already logged at `operate.py:2323` (`[_merge_nodes_then_upsert] … completed in %.4fs`) / `:2908` — sum the summary-bearing merges.

Instrument both for one cycle before assuming a ratio. Note the two fixes are independent and can (should) both be applied.

---

## Recommended fix (ranked)

### Fix 1 (PRIMARY) — switch `graph_storage` to an incremental DB backend (Neo4j)

This eliminates the entire §P class (full-graph rewrite, RAM residency, startup parse) by replacing full-file persistence with per-upsert DB writes.

**Why Neo4j.** It is already the proven backend for this exact store on the PC (`SCALING_ISSUES.md` §7.7 — retrieval parity verified, startup 15 min → 2 min, RAM 33.7 GB → 0.25 GB) and the migration tooling already exists (below). Its persistence is incremental:
- `LightRAG/lightrag/kg/neo4j_impl.py:1058` `upsert_node` = a single `MERGE (n) SET n += $properties` per node; `:1104` `upsert_nodes_batch`, `:1188` `upsert_edges_batch`.
- `LightRAG/lightrag/kg/neo4j_impl.py:470-472` `index_done_callback` is a **no-op** (`# Neo4J handles persistence automatically / pass`) → flushing costs nothing; the graph never gets re-serialized. Persist becomes **O(delta)**.

**Alternatives available in `LightRAG/lightrag/kg/` (all upstream, config-only, all incremental/DB-backed):**
- `Neo4JStorage` — `neo4j_impl.py` (recommended; proven here).
- `MemgraphStorage` — `memgraph_impl.py` (Bolt-compatible, in-memory DB; single-node, lighter to run as a sidecar).
- `PGGraphStorage` — `postgres_impl.py` (Apache AGE extension on PostgreSQL; attractive because KV/doc-status can share the same PG instance).

**Exact AP-RAG change (patch-free — edits stay in `pipeline/`, never in `LightRAG/`):**

1. In `pipeline/ingest.py`, add a `GRAPH_STORAGE` env read next to the existing `KV_STORAGE` read (`~:250`), and pass it into `rag_kwargs`, mirroring the `KV_STORAGE` block at `pipeline/ingest.py:1857-1862`:

   ```python
   # near the other storage env reads (~line 250)
   GRAPH_STORAGE = os.environ.get("GRAPH_STORAGE", "").strip()

   # in the rag_kwargs assembly block (~line 1857, beside kv_storage/doc_status)
   if GRAPH_STORAGE:
       rag_kwargs["graph_storage"] = GRAPH_STORAGE
       print(f"[Fix-graph] Using graph_storage={GRAPH_STORAGE}")
   ```
   This is the same injection pattern the repo already uses for `kv_storage`/`doc_status_storage`/`vector_storage`; it changes only AP-RAG code. Default empty ⇒ unchanged `NetworkXStorage` behavior, so it's opt-in and safe to land.

2. Provide the Neo4j service + credentials LightRAG reads directly (`neo4j_impl.py:174-182`): env `NEO4J_URI` (e.g. `bolt://127.0.0.1:7687`), `NEO4J_USERNAME`, `NEO4J_PASSWORD` (optionally `NEO4J_DATABASE`, `NEO4J_WORKSPACE`). On HPC compute nodes this must be a **sidecar** (Apptainer/Singularity Neo4j container on node-local NVMe) — the Qdrant sidecar in the ingest jobs is the working precedent. On offline clusters (Narval/Trillium) the Neo4j image must be pre-staged (no compute-node internet — see `CLAUDE.md`).
3. Set `GRAPH_STORAGE=Neo4JStorage` in the ingest job env.

**DB needed:** Neo4j (Community 5.x is fine; `SCALING_ISSUES.md` §7.7 ran Community 5.26.9). Memgraph or PostgreSQL+AGE are drop-in alternatives per the class names above.

**Migration path for the existing 5,680-doc GraphML → Neo4j (REQUIRED — LightRAG does NOT auto-import).** Switching `graph_storage` makes LightRAG read from Neo4j only; it will **not** read `graph_chunk_entity_relation.graphml`. The existing graph must be imported once, or you lose it and re-extract. Use the tool that already exists:

- `scripts/migrate_to_db_backends.py` streams the GraphML with `iterparse` (`_iter_graphml`, `:120-154`) — **never** `nx.read_graphml` (that OOM'd the box; §7.7) — and upserts through LightRAG's own `Neo4JStorage.upsert_nodes_batch`/`upsert_edges_batch` (`migrate_graph`, `:157-203`). Schema is correct by construction and idempotent (`MERGE`). Measured: 1.63M nodes ≈ 100s, 3.3M edges ≈ 10.5 min (§7.7).
- **Caveat — RESOLVED (2026-07-14).** The script used to hard-code the PC serving backends (PG + Qdrant). It now takes `--ingest-graph`: graph-only import, no Postgres/Qdrant needed (empty Json/Nano stand-ins live in a staging working dir, so the multi-GB ingest KV JSONs are never loaded — the login-node OOM gotcha), graph-only verify incl. Neo4j-side node/edge counts, and it stamps `STORAGE_DIR/.graph_backend=Neo4JStorage` on success (which is what un-gates Neo4JStorage ingest runs). SLURM wrapper: `slurm/job_graph_migrate_neo4j.slurm`.
- After import, resume ingest with `GRAPH_STORAGE=Neo4JStorage` + Neo4j env set. New nodes/edges upsert incrementally; no GraphML is ever written again.
- **Fallback to migration:** starting *fresh* into Neo4j (`fresh` mode preserves the LLM-response cache so re-extraction is cache-cheap) still re-pays all merge + embed work for 5,680 docs, which is far more expensive than the ~12-min import. Prefer migration.

### Fix 2 (SECONDARY, independent of Fix 1) — cap entity-merge re-summarization

Fix 1 does nothing for §S. Tune the existing gates (env-only, read by LightRAG at `lightrag.py:366`/`:529`, no code change):
- **Raise `FORCE_LLM_SUMMARY_ON_MERGE`** (default 8) to a middle value (e.g. `100`, the value `SCALING_ISSUES.md` §3.2 validated) so only true hubs ever summarize, not every ordinary entity. Trade-off: longer un-summarized descriptions between summaries (bounded by `SUMMARY_MAX_TOKENS`).
- **Do not go to ~1e9 (full defer)** — it removes the LLM flood but reintroduces unbounded descriptions → an O(N) merge/embed wall + embedder OOM (`SCALING_ISSUES.md` §3.2, §3.5), and shifts cost to the corpus-end `scripts/finalize_summaries.py` pass.
- Right invariant is *bounded description length*, not fragment count (§3.2 residual risk 2) — but the threshold knob is the cheap, available lever now.

### Fix 3 (interim, if Fix 1 can't land immediately)

Nothing on the file backend removes the O(V+E) per-flush cost. The only file-side lever is `KV_FLUSH_INTERVAL` (already applied, already maxed — raising it further trades throughput for a bigger crash-loss window and observability blackout, §3.10). Treat Fix 3 as "already exhausted"; go to Fix 1.

---

## Patch-free constraint

The fix **must not edit anything under `LightRAG/`** (upgradability rule, `CLAUDE.md` / `SCALING_ISSUES.md` §5). Confirmation:
- **Fix 1** is (a) a constructor kwarg passed from `pipeline/ingest.py` (`graph_storage=`, the same mechanism already used for `kv_storage`/`vector_storage`), (b) env vars LightRAG itself reads (`NEO4J_*`), and (c) a run of/edit to `scripts/migrate_to_db_backends.py` (AP-RAG's own script). **No `LightRAG/` file is touched.** ✅
- **Fix 2** is env-only (`FORCE_LLM_SUMMARY_ON_MERGE`, `SUMMARY_MAX_TOKENS`), read by stock LightRAG. ✅
- No upstream change is required. (If a future need arises to *offload* `nx.write_graphml` to a thread to unblock the loop while staying on NetworkX, **that** would require editing `LightRAG/kg/networkx_impl.py` and is therefore disallowed — which is another reason to move off NetworkX rather than patch it.)

---

## Acceptance criteria

1. **Persist is O(delta), not O(V+E).** After Fix 1, the ingest log **no longer contains** `Writing graph with N nodes, M edges` (that string lives only in `NetworkXStorage.write_nx_graph`). Confirm the graph backend in use is Neo4j (startup log / `rag.chunk_entity_relation_graph` class name).
2. **Throughput no longer degrades with corpus size.** docs/hr at 5,680 docs ≈ docs/hr at, say, 8,000 docs (within noise), with GPUs healthy. Compare two equal-length cycles at different corpus sizes; the per-doc time should be flat, not rising.
3. **Startup is corpus-independent.** Boot-to-first-extraction no longer includes a multi-minute GraphML parse (§7.7 measured 15 min → 2 min on the same store).
4. **No event-loop stalls at flush time.** No multi-minute gaps in doc-completion timestamps aligned to flush ticks.
5. **Graph integrity preserved across the migration.** Post-import Neo4j node/edge counts match the source GraphML (the script logs both); `rag.chunk_entity_relation_graph.get_node(<known entity>)` returns the merged description (the `verify()` path in `migrate_to_db_backends.py:206-224`).
6. **(Fix 2)** `default:summary:` cache-save lines per doc drop after raising the threshold; no `rate=0/hr` merge-wall stalls.
7. **Regression guard:** run one small end-to-end ingest cycle against Neo4j and confirm retrieval parity (same chunks/entities for a fixed query) vs the file-based store, as §7.7 did for the serving side.

---

## Risks / rollback

- **Sidecar operational cost on HPC.** A Neo4j service must run alongside each ingest job (Apptainer sidecar on node-local NVMe, Qdrant precedent). On offline clusters (Narval/Trillium — no compute-node internet) the image must be pre-staged. If the sidecar dies mid-run, ingest stalls on graph writes → add a health check like the vLLM endpoint checks.
- **Portability trade-off.** The "expensive intermediates are portable files" property (cross-cluster Globus race, `SCALING_ISSUES.md` §5 constraint 4) weakens: a live Neo4j store is heavier to move than a GraphML file. Mitigation: Neo4j `dump`/`load` or re-run the (fast) GraphML→DB import per cluster; or keep the GraphML as the portable archive and DB as the working store.
- **Migration correctness.** If the graph-only migration is run with the wrong `STORAGE_DIR` or against a non-empty Neo4j, you can double-load; the `MERGE` upserts are idempotent but verify counts (criterion 5) before resuming ingest.
- **Rollback is trivial and safe.** Fix 1 is opt-in: unset `GRAPH_STORAGE` (or set it back to `NetworkXStorage`) and ingest reverts to the file backend and the existing `graph_chunk_entity_relation.graphml` — no data migration needed to roll back, because the GraphML on disk is untouched by the DB run (the DB is a separate copy). Keep the pre-migration GraphML until the DB run is validated.

---

## Docs/code disagreements found while writing this

1. **RESOLVED (2026-07-14): `FORCE_LLM_SUMMARY_ON_MERGE` had three conflicting "canonical" values across docs** (`8` in the CANONICAL table, `1e9` in its "Defer-mode MANDATORY" section, `100` validated in `SCALING_ISSUES.md` §3.2). The Narval log's `default:summary:` flood proves that run executed the old script default `8`. §3.2 records the full arc: defer-mode 1e9 *was* the 2026-07-03 mandate, it then caused the merge wall + §3.5 embedder OOMs, and `100/1200/12000` is the validated fix — exactly this doc's Fix 2. Resolution: `100/1200/12000` is now **baked as the default in every ingest SLURM job**, and `CANONICAL_INGEST_PARAMS.md` was rewritten to a single consistent story (defer-mode marked superseded).
2. **RESOLVED (2026-07-14): `.env` `LIGHTRAG_GRAPH_STORAGE=NetworkXStorage` (`.env:71`) is dead for the ingest path.** The LightRAG constructor field is a literal default (`lightrag.py:281`, no `get_env_value`), and `pipeline/ingest.py` passed no `graph_storage` kwarg. Fix 1 landed: ingestion now reads **`GRAPH_STORAGE`** (not `LIGHTRAG_GRAPH_STORAGE`), and `.env` carries a comment stating which keys the ingest path actually reads.
3. **`docs/SCALING_ISSUES.md` §3.3 already flags "ingest side still open"** for exactly this backend — this doc is consistent with it and is the concrete ingest-side implementation of §3.3's "Directions for the reviewer."
