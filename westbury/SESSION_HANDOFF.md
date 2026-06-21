# Session Handoff — Westbury RAG Ingestion

**Date:** 2026-04-05 (Edmonton time, MDT = UTC-6)
**Prepared for:** Next LLM session to continue ingestion work

---

## Project Overview

LightRAG knowledge graph ingestion of Westbury lab papers (~1,466 PDFs total).
- **LLM:** Qwen/Qwen3-32B (FP8) served via vLLM
- **Embeddings:** Octen/Octen-Embedding-8B-INT8
- **Vector DB:** Qdrant (Apptainer sidecar on local NVMe)
- **Primary cluster:** Rorqual (`/scratch/devon7y/westbury_rag/`)

---

## Current State (as of this session end)

### Rorqual — Active Jobs Running
| Job | Type | Time Left | Status |
|---|---|---|---|
| 9813654 | vLLM | ~7.5h | RUNNING on rg31609 |
| 9813655 | vLLM | ~7.5h | RUNNING on rg32501 |
| 9813656 | vLLM | ~7.5h | RUNNING on rg32602 |
| 9813657 | ingest | ~7.75h | RUNNING on rg21701 |

### Doc Counts (Rorqual, last checked ~10:10 PM MDT)
- **Processed:** 1,458
- **Small papers remaining:** ~84 (papers/)
- **Large papers remaining:** 178 (papers_large/) — not yet started
- **Failed:** 0

### Trillium — Jobs Pending
| Job | Type | ETA Start |
|---|---|---|
| 408691–408693 | vLLM ×3 | ~1:05–1:12 AM MDT |
| 408694 | ingest | after vLLMs |

Tril fairshare is 0.049 (poor) — jobs may be slow to start.

---

## Canonical Ingest Parameters

These are the settings from successful Trillium 10h/12h runs. Now baked into `job_westbury_ingest_v2_ror.slurm` defaults.

| Parameter | Value |
|---|---|
| `N_VLLM` | 3 |
| `PARALLEL_DOCS` | 32 |
| `LLM_MAX_ASYNC` | 32 |
| `CONTEXT_MAX_ASYNC` | 32 |
| `EMBED_FUNC_MAX_ASYNC` | 16 |
| `MAX_PARALLEL_INSERT` | 16 |
| `MAX_DOC_TOKENS` | 20000 |

See [CANONICAL_INGEST_PARAMS.md](CANONICAL_INGEST_PARAMS.md) for submission commands.

---

## Storage Paths

| Cluster | Scratch | RAG Storage |
|---|---|---|
| Rorqual | `/scratch/devon7y/` | `/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/` |
| Trillium | `/scratch/devon7y/` | `/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/` |

Key subdirs under `westbury_rag/`:
- `papers/` — 1,288 small PDFs
- `papers_large/` — 178 large PDFs (>50 pages, not yet ingested)
- `vllm_endpoints_westbury_qwen3_32b/` — endpoint files (must clear before resubmit)
- `qdrant_storage_westbury/` — persistent Qdrant data on Lustre
- `logs/` — SLURM stdout/stderr

---

## SLURM Scripts (on HPC and local)

| Script | Location | Notes |
|---|---|---|
| `job_westbury_vllm_ror.slurm` | Ror + local | vLLM job for Rorqual |
| `job_westbury_ingest_v2_ror.slurm` | Ror + local | Ingest job for Rorqual — **auto-resubmit REMOVED this session** |
| `job_westbury_vllm_tril.slurm` | Tril only | vLLM job for Trillium |
| `job_westbury_ingest_v2_tril.slurm` | Tril + local | Ingest job for Trillium |
| `job_westbury_rebuild_graph_ror.slurm` | Ror + local | Graph rebuild (no vLLM needed) |

---

## Standard Job Submission (Rorqual)

```bash
# 1. Clean stale pending entries
ssh -o ControlPath="~/.ssh/cm-ror-%C" ror "python3 -c \"
import json; from pathlib import Path
storage = Path('/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b')
for fname in ('kv_store_doc_status.json', 'kv_store_full_docs.json'):
    p = storage / fname; d = json.loads(p.read_text())
    stale = [k for k,v in d.items() if isinstance(v,dict) and v.get('status') in ('pending','processing')]
    for k in stale: d.pop(k)
    p.write_text(json.dumps(d))
    print(f'Removed {len(stale)} from {fname}')
\""

# 2. Clear stale endpoints
ssh -o ControlPath="~/.ssh/cm-ror-%C" ror "rm -f /scratch/devon7y/westbury_rag/vllm_endpoints_westbury_qwen3_32b/*"

# 3. Submit 3 vLLMs + ingest
ssh -o ControlPath="~/.ssh/cm-ror-%C" ror "
cd /scratch/devon7y/westbury_rag
VLLM1=\$(sbatch --parsable --time=Xh:00:00 job_westbury_vllm_ror.slurm)
VLLM2=\$(sbatch --parsable --time=Xh:00:00 job_westbury_vllm_ror.slurm)
VLLM3=\$(sbatch --parsable --time=Xh:00:00 job_westbury_vllm_ror.slurm)
sbatch --time=Xh:00:00 --dependency=after:\$VLLM1:\$VLLM2:\$VLLM3 job_westbury_ingest_v2_ror.slurm
"
```

---

## Known Issues & Fixes

### Auto-resubmit (FIXED this session)
- Old `job_westbury_ingest_v2_ror.slurm` on HPC had auto-resubmit code that spawned runaway job chains
- **Fixed:** Removed from Ror script this session. Tril script never had it.
- **Watch for:** If the ingest finishes and spawns new jobs, the HPC script got overwritten again

### PARALLEL_DOCS deadlock
- Rorqual previously deadlocked with `PARALLEL_DOCS > 1`
- This session we switched to canonical params (`PARALLEL_DOCS=32`) — **first real test on Ror is the current job (9813657)**
- If it deadlocks, fall back to `PARALLEL_DOCS=1`
- Trillium never deadlocked at PARALLEL_DOCS=32

### Graphml corruption (FIXED this session)
- Concurrent ingest jobs wiped the graphml to 0 bytes
- Restored from `.bak` + applied sed fix: `sed -i 's/<data"/<data key="/g'`
- Graphml is now valid (322MB) as of ~10:50 PM MDT
- The ingest script has a backup/restore trap on EXIT — but concurrent jobs can still race

### LLM Response Cache
- `kv_store_llm_response_cache.json` is 245MB — valid JSON but too large to load on login node
- Do not try `python3 -c "json.loads(open(...).read())"` on login node — gets OOM killed
- Use `tail -c 20` to check if properly terminated

### Trillium SSH
- No `robot-tril-slurm` alias — use `ssh tril` directly
- ControlPath: `~/.ssh/cm-tril-%C`

---

## GPU Fairshare (as of this session)

| Cluster | GPU FairShare | Notes |
|---|---|---|
| Rorqual | 0.345 | Best — use this first |
| Nibi | 0.192 | Fresh, good backup |
| Fir | 0.104 | Moderate |
| Trillium | 0.049 | Poor — jobs queue slowly |

---

## Pending Work

1. **Small papers (Rorqual):** ~84 remaining — current job should finish them
2. **Large papers (papers_large/):** 178 PDFs, 0 processed — need separate run with higher `MAX_DOC_TOKENS` (suggest 60000+)
3. **Tril sync:** After Ror job finishes, Globus transfer updated storage to Tril
4. **233 unknown_source docs:** Documented in [UNKNOWN_SOURCE_233_DOCS.md](UNKNOWN_SOURCE_233_DOCS.md) — needs investigation (handed to Codex)
5. **Sync final state to PC:** Once all small papers done, transfer graphml + KV stores to `pc:/cygdrive/c/rag_server/rag_storage_westbury_qwen3_32b/`

---

## SSH / Auth

- Passcode stored at `~/.claude/hpc_passcode` — valid ~24h
- ControlMaster sockets: `~/.ssh/cm-ror-%C`, `~/.ssh/cm-tril-%C`, `~/.ssh/cm-fir-%C`, `~/.ssh/cm-nibi-%C`
- Re-auth: `sshpass -P "Passcode" -f ~/.claude/hpc_passcode ssh -o ControlMaster=yes -o ControlPath="~/.ssh/cm-ror-%C" -o ControlPersist=12h -fN ror`
- Always check ControlMaster before assuming auth works: `ssh -O check ror 2>&1`

---

## Globus Endpoints

| Cluster | Endpoint ID |
|---|---|
| Rorqual | `f19f13f5-5553-40e3-ba30-6c151b9d35d4` |
| Trillium | `ad462f99-8436-42b4-adc6-3644e36c1b67` |
| Nibi | `07baf15f-d7fd-4b6a-bf8a-5b5ef2e229d3` |
| Fir | `8dec4129-9ab4-451d-a45f-5b4b8471f7a3` |

Transfer command (Ror → Tril):
```bash
globus transfer f19f13f5-5553-40e3-ba30-6c151b9d35d4 ad462f99-8436-42b4-adc6-3644e36c1b67 \
  --label "Ror->Tril rag_storage" --sync-level checksum --batch - <<'EOF'
--recursive /scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/ /scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/
EOF
```
