# Handoff — Ingest `papers_batch2` (938 new papers) into `rag_storage_full` on Fir

**Written:** 2026-07-26
**For:** a Claude Code instance continuing this work
**Cluster:** Fir (Alliance Canada) · **Project dir (WORKDIR):** `/home/devon7y/scratch/devon7y/westbury_rag`
**Status when written:** papers transferred + verified; **ingest NOT yet launched** (waiting on the user's go-ahead).

---

## TL;DR

938 new PDFs are already staged at `fir:$WORKDIR/papers_batch2/`. Run **one vLLM + resume-ingest cycle** to **ADD** them to the existing `rag_storage_full` store (doc_status **9,704 processed → ~10,635**). Three things you must not get wrong:

1. **Force the NanoVectorDB backend** (move `qdrant_latest.sif` aside) — the store's canonical vectors are NanoVDB `vdb_*.json`; the on-disk Qdrant is stale/empty and would split the vectors.
2. **Override the job's `--mem` and `--time`** — the defaults (`32G` / `2h`) will OOM and time out on a 10k-doc store.
3. **Ingest from `papers_batch2/` only** — never re-ingest `papers_full/`, and never rsync batch2 into `papers_full/` (233 filename collisions would overwrite wrong-vintage files).

Single cycle. **No job chains** (the user forbids self-resubmitting chains). Don't launch until the user says go.

---

## 1. Current state (verified 2026-07-26)

| Item | Value |
|---|---|
| `papers_batch2/` (ingest THIS) | **938** PDFs (931 genuinely-new + 7 retries) |
| `papers_full/` (do NOT touch) | **9,711** PDFs — existing corpus, already ingested |
| `rag_storage_full/` doc_status | **9,704 processed** (0 pending / processing / failed) |
| Canonical vectors | **NanoVDB**: `vdb_chunks.json` (880 MB), `vdb_entities.json` (1.2 GB), `vdb_relationships.json` (556 MB), all Jul 23 |
| Graph / chunks KV | `graph_chunk_entity_relation.graphml` 3.4 GB · `kv_store_text_chunks.json` 1.7 GB |
| `qdrant_storage_full/` | **STALE** — Jul 20, empty `collections/`. Ignore it. |
| Endpoints dir | `vllm_endpoints_westbury_qwen3_32b/` — empty (no stale endpoints) |
| Fir scratch free | ~3.0 TB |

### Why a separate dir, and why exactly these 938
The Mac corpus had **700 filename relabels** (disambiguation letters, e.g. `Baddeley_1966.pdf → Baddeley_1966b.pdf`) applied via `data/rename_log.jsonl`. Mapping the current Mac corpus through those renames against Fir's `papers_full/`:
- **931** papers are genuinely new (content not yet on Fir).
- **233** of those new filenames **collide** with existing physical files in `papers_full/` → a naive rsync into `papers_full/` would have overwritten 233 wrong-vintage files. This is why batch2 is a **separate directory** and the ingest reads only batch2.
- **7** papers were staged in `papers_full/` before but never got a processed doc_status entry (retries): `Hollis_Etal_2006b.pdf`, `McClaughlin_Eysenck_1967.pdf`, `McKinnon_Singer_1966.pdf`, `Rossano_Moak_1998.pdf`, `Tussing_Greene_2001.pdf`, `Willemsen_1973a.pdf`, `Williams_1988.pdf` — copied into batch2 under current names so this run re-attempts them.
- **7** Fir docs are "orphans" (renamed outside the tool → not in rename_log): `Erickson_Unknown.pdf`, `Friedman_Unknown.pdf`, `Fyshe_Etal_Unknown.pdf`, `Gatti_Etal_Unknown.pdf`, `Shalamberidze_2026a.pdf`, `Shalamberidze_Etal_2025b.pdf`, `Yanitski_2024b.pdf`. Content-hash dedup prevents re-ingest; only their store labels stay old. Handled in Phase 3.

### What "add to the existing store" means
Resume-ingest points at the same `WORKING_DIR` (`rag_storage_full`). LightRAG **skips the 9,704 already-processed docs by content hash** and processes only the new ones, **merging their entities/relations incrementally into the existing graph + KV stores**. This is the required way to combine corpora (per CLAUDE.md: never merge store files — always ingest into one working dir). The 7 orphan-content dupes are auto-skipped.

---

## 2. HPC access

Robot automation aliases are **dead** (MFA enforcement). Drive everything through the **login-node ControlMaster socket** — run commands as `ssh fir '<cmd>'` (sbatch/squeue/scancel/scontrol/tail all work on the login node).

```bash
ssh -O check fir            # exit 0 = socket live (it was live when this was written)
```
If the socket is dead, re-auth with the stored passcode (valid 24h, at `~/.claude/hpc_passcode`):
```bash
sshpass -P "Passcode" -f ~/.claude/hpc_passcode ssh -o StrictHostKeyChecking=accept-new \
  -o ControlMaster=yes -o ControlPath="~/.ssh/cm-fir-%C" -o ControlPersist=12h -fN fir
```
If no passcode / it fails, ask the user for a fresh one (then save it to `~/.claude/hpc_passcode`, `chmod 600`).

---

## 3. Pre-flight (do these before submitting)

```bash
# a) Confirm the staging is intact
ssh fir 'cd /home/devon7y/scratch/devon7y/westbury_rag
  echo "batch2: $(ls -1 papers_batch2/*.pdf | wc -l)  (expect 938)"
  echo "papers_full: $(ls -1 papers_full/*.pdf | wc -l)  (expect 9711, untouched)"
  grep -o "\"status\": *\"[a-z_]*\"" rag_storage_full/kv_store_doc_status.json | sort | uniq -c'

# b) SAFETY SNAPSHOT + doc-id baseline for Phase 3 (≈9 GB; 3 TB free). This snapshot is
#    ALSO the pre-batch2 doc-id set the Phase-3 reconciliation must scope to.
ssh fir 'cd /home/devon7y/scratch/devon7y/westbury_rag
  cp -r rag_storage_full rag_storage_full.pre_batch2 && echo "snapshot done"'

# c) CRITICAL — force NanoVectorDB (disable the Qdrant sidecar for this run).
#    The job auto-starts Qdrant when qdrant_latest.sif exists, which would seed from the
#    STALE empty qdrant_storage_full/ and split the vectors from the canonical vdb_*.json.
ssh fir 'cd /home/devon7y/scratch/devon7y/westbury_rag
  mv qdrant_latest.sif qdrant_latest.sif.batch2off && echo "Qdrant disabled for this run"'
#    The ingest log should then say: "No Qdrant SIF found — using NanoVectorDB."
#    RESTORE it after the run (Phase 6).
```

---

## 4. Phase 1 — vLLM (serves the ingest LLM)

Model `Qwen/Qwen3.6-35B-A3B-FP8` on 1×H100, served as `Qwen/Qwen3.6-35B-A3B`. Submit **2 endpoints** and match the vLLM walltime to the ingest (12h). For 938 docs the bottleneck is insert parallelism, not the LLM, so 2 endpoints is plenty.

```bash
ssh fir 'cd /home/devon7y/scratch/devon7y/westbury_rag
  sbatch --time=12:00:00 job_westbury_vllm_fp8_fir.slurm
  sbatch --time=12:00:00 job_westbury_vllm_fp8_fir.slurm'
```
Wait until **both** endpoint files appear (FP8 weights take ~5–15 min to load):
```bash
ssh fir 'ls -1 /home/devon7y/scratch/devon7y/westbury_rag/vllm_endpoints_westbury_qwen3_32b/*.txt 2>/dev/null | wc -l'   # want 2
```

---

## 5. Phase 2 — resume-ingest the 938 (add to `rag_storage_full`)

Submit **after** the endpoint files exist (the ingest also self-discovers + health-checks endpoints, so no SLURM dependency chain is needed — this keeps it a single clean cycle):

```bash
ssh fir 'cd /home/devon7y/scratch/devon7y/westbury_rag
  sbatch \
    --time=12:00:00 --mem=256G \
    --export=ALL,PAPERS_SUBDIR=papers_batch2,STORAGE_SUBDIR=rag_storage_full,N_VLLM=2,REBUILD_EMBEDDINGS=0 \
    job_westbury_ingest_v2_fir.slurm'
```

Notes on the overrides:
- `PAPERS_SUBDIR=papers_batch2` → read only the new dir.
- `STORAGE_SUBDIR=rag_storage_full` → **add to the existing store** (default is a different dir!).
- `REBUILD_EMBEDDINGS=0` → this is an add, not a reembed.
- **Do NOT** pass `QDRANT_SUBDIR` — Qdrant is disabled (pre-flight c), so the run extends the NanoVDB `vdb_*.json`.
- `--mem=256G` (job default `32G` **will OOM** loading the 3.4 GB graphml + 2.6 GB NanoVDB; bump to `498G` if you still see OOM in the `.err`).
- `--time=12:00:00` (job default `2h` is far too short).
- **Leave chunker + concurrency at defaults** — chunk size is settled at 512 tokens and must match the original run; `PARALLEL_DOCS=24 / LLM_MAX_ASYNC=48 / MAX_PARALLEL_INSERT=24` are proven. Only raise `MAX_PARALLEL_INSERT` if the log shows the vLLMs idle and throughput is poor.

### Monitor
```bash
ssh fir 'squeue -u devon7y'
ssh fir 'tail -50 /home/devon7y/scratch/devon7y/westbury_rag/logs/westbury_ingest_<JOBID>.out'
# processed count should climb 9704 -> ~10635:
ssh fir 'grep -o "\"status\": *\"processed\"" /home/devon7y/scratch/devon7y/westbury_rag/rag_storage_full/kv_store_doc_status.json | wc -l'
```

If 12h isn't enough (large graph merges can be slow), it's **resumable** — submit one more identical cycle to finish the tail. That's a manual single cycle, not a forbidden auto-chain.

---

## 6. Completion verification + restore

```bash
ssh fir 'cd /home/devon7y/scratch/devon7y/westbury_rag
  echo "processed: $(grep -o "\"status\": *\"processed\"" rag_storage_full/kv_store_doc_status.json | wc -l)  (expect ~10635)"
  ls -la --time-style=+%Y-%m-%d rag_storage_full/vdb_chunks.json rag_storage_full/graph_chunk_entity_relation.graphml   # mtimes should be today, sizes grown
  tail -20 logs/westbury_ingest_<JOBID>.err'   # clean shutdown / KV flush, no traceback
```
Expected: processed ≈ **10,635** (9,704 + 931; the 7 retries may or may not parse — check the log; the 7 orphan dupes are skipped). Then:

```bash
# Restore the Qdrant SIF
ssh fir 'cd /home/devon7y/scratch/devon7y/westbury_rag && mv qdrant_latest.sif.batch2off qdrant_latest.sif'
# Cancel the vLLM jobs (they don't self-exit)
ssh fir 'scancel <VLLM_JOBID_1> <VLLM_JOBID_2>'
# Once you trust the result, the safety snapshot can go:
# ssh fir 'rm -rf /home/devon7y/scratch/devon7y/westbury_rag/rag_storage_full.pre_batch2'
```

---

## 7. Phase 3 — post-ingest reconciliation (LATER, at PC redeploy; PC is currently down)

Do **not** do these as part of the ingest run — they belong to the PC redeploy.

1. **Doc-id-scoped `file_path` reconciliation.** The original 9,704 docs carry **old-vintage** `file_path` labels (e.g. `Baddeley_1966.pdf`), but the manifest + Drive map use **current** names (`Baddeley_1966b.pdf`). Remap them using `data/rename_log.jsonl` (old→new) across doc_status, `full_docs`, `text_chunks.file_path`, and the vector payloads.
   - **CRITICAL:** because the 233 collisions mean a *new* doc can legitimately carry a name that is *also* an old doc's label, the remap must be keyed on **doc-id (content hash), scoped to the pre-batch2 doc-ids** captured in `rag_storage_full.pre_batch2/kv_store_doc_status.json` — **never** a blind file_path→file_path replace, or you'll clobber the new docs' correct labels.
2. **7 orphans** (see §1) were renamed outside the tool, so they're absent from `rename_log.jsonl`. Optionally map them to current names by hand.
3. **PC redeploy:** derive the PC's Qdrant from the updated NanoVDB store (existing migrate/reembed step), copy the store + refreshed `data/papers_metadata.json` + `data/drive_links.json` to `C:\rag_server\`, restart the stack.
4. **Drive map gap:** 292 papers currently lack Drive links — refresh `data/drive_links.json` from the Drive Desktop mount with `scripts/build_drive_map.py mount` before redeploy.

---

## 8. Gotchas / invariants

- **No job chains** (no self-resubmit; single cycles only — chains burn fairshare).
- **Fir only** for this run — the ~8 GB store + the papers are already there; racing to another cluster would require Globus'ing the whole store first.
- The completed run's canonical vectors are **NanoVDB** (`vdb_*.json`), not Qdrant — the on-disk `qdrant_storage_full/` is stale/empty. Keep Qdrant disabled for the add (pre-flight c).
- Job defaults you **must** override: `--mem` (32G→256G) and `--time` (2h→12h).
- Never edit anything inside `LightRAG/` (upstream stays patch-free).
- Rollback: `scancel` the jobs and restore from `rag_storage_full.pre_batch2/` if the merge went wrong; `papers_batch2/` itself can stay.
