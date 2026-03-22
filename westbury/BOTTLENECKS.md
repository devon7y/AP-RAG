# Westbury RAG Pipeline — Bottlenecks & Limitations

This document describes observed performance issues, failure modes, and architectural
limitations in the LightRAG-based Westbury paper ingestion pipeline. Written to guide
optimization work.

---

## 1. GPU Utilisation — Bursty, Not Steady

**Observed behaviour:** vLLM alternates between full saturation (99% KV cache, 48
concurrent requests) and complete idle (0% KV cache, 0 requests). The pattern repeats
every few minutes rather than running at steady load.

**Impact:** Average GPU utilisation is ~50–60% despite the GPU being capable of much
more. Effective throughput is ~12–23 docs/hr instead of the theoretical maximum.

**Root cause:** The LightRAG pipeline processes documents in discrete waves:
1. Chunks are extracted and submitted to the LLM (burst of requests)
2. Entity/relation results come back and are written to graph + VDB (CPU/disk, GPU idle)
3. Embeddings are computed (MIG GPU, vLLM GPU idle)
4. Next batch starts

`MAX_PARALLEL_INSERT` controls how many documents are in flight simultaneously. At
`MAX_PARALLEL_INSERT=16` (our current setting), the pipeline doesn't generate enough
concurrent LLM requests to keep the GPU fed between write phases.

**What has been tried:**
- `MAX_PARALLEL_INSERT=8` → improved over default 2, still bursty
- `MAX_PARALLEL_INSERT=16` → better, still idle gaps
- `MAX_PARALLEL_INSERT=32` → queued for next run

**Suspected bottleneck after GPU:** NetworkX graph merge locking (see §4).

---

## 2. "Content Already Exists" Conflict on Restart

**Observed behaviour:** When a run is interrupted and restarted with existing "pending"
docs in storage, the new ingest job fails to submit those docs with:
```
Content already exists. Original doc_id: doc-XXXX
```

**Impact:** Hundreds to thousands of orphan "failed" entries created per restart.
Documents already queued as "pending" are not re-processed; they remain stuck.

**Root cause:** LightRAG stores document content in `kv_store_full_docs.json` keyed by
content hash at submission time (when status = "pending"). On restart, the ingest script
tries to re-submit the same papers, but the content hash already exists in full_docs
under the old pending entry's `doc_id`. LightRAG rejects the new submission.

The ingest script only skips docs with `status == "processed"`. It does not skip
`status == "pending"` docs, so it re-submits them and hits the conflict.

**Current mitigation:** A pre-run cleanup step in the SLURM script strips all
non-"processed" entries from both `kv_store_doc_status.json` AND `kv_store_full_docs.json`
before each new job. This means pending docs lose their in-progress state and are
re-submitted cleanly.

**Better fix needed:** The ingest script should either:
- Skip docs with `status == "pending"` (treat them as queued, not re-submit), OR
- Provide a resume mechanism that reattaches the pipeline to existing pending entries
  without re-submitting content

---

## 3. Stale vLLM Endpoint Files — Silent Total Failure

**Observed behaviour:** When a vLLM SLURM job is cancelled via `scancel`, the `trap
cleanup EXIT SIGTERM` handler in the SLURM script does not reliably fire. The endpoint
file (e.g. `vllm_endpoints_westbury_qwen3_32b/28818145.txt`) is left on disk.

When a new ingest job starts, it discovers the stale endpoint file and connects to the
old (dead) vLLM node. The initial health check may pass briefly if the node is still
reachable, but then all subsequent LLM calls fail silently with `APIConnectionError`.
Every document in the run is marked "failed". This ran undetected for 6+ hours in one
incident.

**Impact:** Complete loss of an entire job run (2115 failures, 0 new docs processed).

**Current mitigation:** Manual pre-flight check before every submission (see
`PRE_FLIGHT.md` Check 3). The `westbury-submit` skill automates this.

**Better fix needed:**
- The vLLM SLURM script should clean up its endpoint file at the END of the job
  (after `wait` returns), not just via trap. Trap is unreliable for `scancel`.
- OR: The ingest script should validate the endpoint responds to a live health check
  and belongs to an active SLURM job before trusting it, and re-poll if stale.
- OR: Endpoint files should include the serving node hostname, and the ingest script
  should cross-check against `squeue` output at startup.

---

## 4. NetworkX Graph Merge — Write Contention

**Observed behaviour:** LightRAG uses a single in-memory NetworkX graph for entity and
relation storage, protected by a global lock during merge operations.

**Impact:** When many documents complete entity extraction simultaneously, all writers
queue behind the lock. This is a likely contributor to the bursty GPU utilisation (§1):
while graph writes are happening, the LLM pipeline stalls waiting for the lock, causing
the GPU to go idle.

**Suspected scaling ceiling:** `MAX_PARALLEL_INSERT` above some threshold (likely
16–32) will not improve throughput because graph merge becomes the bottleneck, not the
GPU.

**Better fix needed:**
- Batch graph merges: accumulate entity/relation updates across multiple documents and
  apply in a single lock-held write rather than one write per document.
- OR: Switch from NetworkX to a graph database backend (Neo4j, etc.) that supports
  concurrent writes.
- OR: Use a write-ahead log pattern: each worker appends to a per-worker file, a
  separate merger process consolidates periodically.

---

## 5. NanoVectorDB — Not Scalable Beyond ~100K Vectors

**Observed behaviour:** NanoVectorDB stores all vectors in a single JSON file. At
ingestion completion, the three VDB files will be approximately:
- `vdb_entities.json`: ~59K vectors → ~1.8 GB (partial, 233 docs)
- `vdb_relationships.json`: ~73K vectors → ~2.2 GB (partial, 233 docs)
- `vdb_chunks.json`: ~3.6K vectors → ~130 MB (partial, 233 docs)

At full ingestion (1316 docs), these files will be 5–6× larger (~10–12 GB each for
entities/relationships).

**Mac:** Loading the full VDB causes 4+ GB RAM spike, 5+ minute startup, and severe
system lag during queries.

**Windows (PC):** Python's `json.load()` cannot allocate a contiguous buffer large
enough to parse a 2+ GB JSON file. `MemoryError` even with 21 GB free RAM.

**Current mitigation:** Migrated query-time VDB to Qdrant on the PC. Migration must be
repeated after each HPC ingest run (NanoVectorDB is still used during HPC ingest).

**Better fix needed:**
- Configure LightRAG to use Qdrant (or another disk-backed VDB) during HPC ingest,
  eliminating NanoVectorDB entirely. LightRAG supports Qdrant natively via
  `LIGHTRAG_VECTOR_STORAGE=QdrantVectorDBStorage`. This would mean the Mac/PC query
  server and the HPC ingest share the same Qdrant database format, removing the
  migration step.
- This requires running a Qdrant server accessible from the HPC compute nodes, or
  writing directly to Qdrant on the PC via Tailscale during ingest.

---

## 6. `ainsert()` Return Value Does Not Indicate Success

**Observed behaviour:** The ingest script logs `✓` when a document is accepted by the
pipeline queue. This is the return value of `ainsert()`, which completes as soon as the
document is accepted — not when entity extraction finishes.

**Impact:** The log appears to show successful processing of all 1316 papers in ~28
minutes at ~2300/hr. In reality, extraction happens asynchronously over hours. Actual
success/failure is only visible in `kv_store_doc_status.json`. This makes it very easy
to mistake a broken run (where extraction is silently failing) for a successful one.

**Better fix needed:**
- The ingest script should report real-time extraction completion counts, not just
  submission counts.
- A background thread polling `kv_store_doc_status.json` every 30 seconds and
  printing `[processed: X | processing: Y | pending: Z | failed: W]` would give an
  accurate picture of pipeline health.

---

## 7. `contextualize_chunks=True` — Required but Expensive

**Observed behaviour:** With `contextualize_chunks=True`, LightRAG sends the full
document (up to 20K tokens) as context alongside every chunk before entity extraction.
A document with 20 chunks generates 20 contextualization requests, each ~28K tokens.
This roughly doubles the LLM token load compared to chunk-only extraction.

**Impact:** Slower throughput; higher KV cache pressure; required for quality (entities
extracted without document context are frequently wrong or decontextualised).

**Mitigation in place:** `CONTEXT_MAX_ASYNC=32` limits concurrent contextualization
requests. Prefix cache hit rate of 70–75% (vLLM reuses the cached document context
across chunks of the same document), reducing effective token cost.

**Possible optimisation:** Increase prefix cache effectiveness by batching all chunks
of the same document into a single LLM call or ensuring identical prompt prefixes
across chunks. Currently at 70–75% hit rate; closer to 100% would significantly
reduce token consumption.

---

## 8. 10-Hour Walltime Limit — Manual Job Chaining Required

**Observed behaviour:** Each ingest SLURM job has a 10-hour walltime. At ~12–23
docs/hr, processing all 1316 papers requires 6–10 job pairs. Each pair must be manually
submitted (or pre-submitted with `--dependency=afterany:PREV_JOB_ID`).

**Impact:** Requires active monitoring and manual intervention. If a job pair fails
silently (e.g. stale endpoint), the chain stalls and the failure may not be noticed for
hours.

**Better fix needed:**
- A SLURM job array or a wrapper job that automatically re-submits itself with updated
  dependencies until a completion condition is met (e.g. `pending == 0`).
- OR: A lightweight cron-like polling job on the login node that checks doc status and
  submits new pairs as needed. (Note: `crontab` is not supported on Fir; would need
  a long-running SLURM job with a sleep loop.)

---

## 9. Ingest Script Skips "Pending" Docs — Lost Progress on Restart

**Observed behaviour:** LightRAG's ingest script only marks a doc as "processed" after
full entity extraction. "Pending" docs (content stored, extraction not started or
in-progress) are not skipped on restart. Combined with §2, this means any pending work
is lost on every restart.

**Impact:** After an interrupted run with e.g. 200 pending docs, the next run cannot
pick up where the pipeline left off. Those docs are either re-submitted (causing
"Content already exists") or wiped and re-processed from scratch.

**Better fix needed:**
- LightRAG should support a true resume: on startup, identify docs with
  `status == "pending"` that have content in `kv_store_full_docs.json` and re-submit
  them directly to the extraction pipeline without re-inserting content.

---

## 10. MAX_PARALLEL_INSERT Previously a No-Op

**Historical issue (now fixed):** The `MAX_PARALLEL_INSERT` environment variable was
set in the SLURM script but never read by `ingest_cml_octen.py`. LightRAG defaulted to
`max_parallel_insert=2` for all early runs. Every run before the fix was operating at
minimum parallelism regardless of what was configured.

**Fix applied:** `ingest_cml_octen.py` now reads `MAX_PARALLEL_INSERT` from the
environment and passes it to the `LightRAG(max_parallel_insert=...)` constructor.

---

## Summary Table

| # | Issue | Severity | Fixed? |
|---|-------|----------|--------|
| 1 | Bursty GPU utilisation / idle gaps | High | Partial (tuning ongoing) |
| 2 | "Content already exists" on restart | High | Mitigated (pre-run cleanup) |
| 3 | Stale endpoint files → silent total failure | Critical | Mitigated (manual pre-flight) |
| 4 | NetworkX graph write contention | Medium | No |
| 5 | NanoVectorDB unscalable at full corpus size | High | Mitigated (Qdrant for queries) |
| 6 | `ainsert()` ✓ marks are misleading | Medium | No |
| 7 | `contextualize_chunks` doubles LLM load | Low (required) | N/A |
| 8 | Manual job chaining required | Medium | Mitigated (dependency submission) |
| 9 | Pending docs lost on restart | High | Mitigated (pre-run cleanup) |
| 10 | `MAX_PARALLEL_INSERT` was a no-op | Critical | **Fixed** |
