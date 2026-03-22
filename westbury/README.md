# Westbury Papers RAG Pipeline

A separate LightRAG knowledge graph database for the Westbury lab corpus and related papers, running in parallel with the existing CML RAG database.

---

## Corpus

- **Source:** `/Volumes/T7/Westbury papers/` (T7 SSD)
- **Size:** 1,316 PDFs after deduplication (originally 1,345; 29 duplicates removed)
- **Content:** Papers from Westbury lab and related researchers — humor, psycholinguistics, word frequency, entropy, semantic memory, cognitive science
- **HPC location:** `/home/devon7y/scratch/devon7y/westbury_rag/papers/`

---

## Architecture

### Databases (separate from CML)

| Component | Path |
|---|---|
| Local storage (post-ingestion) | `LightRAG/rag_storage_westbury/` |
| HPC storage (during ingestion) | `/home/devon7y/scratch/devon7y/westbury_rag/rag_storage/` |
| HPC papers | `/home/devon7y/scratch/devon7y/westbury_rag/papers/` |

### Storage backends (same as CML — file-based)

| Type | Backend |
|---|---|
| KV store | JsonKVStorage |
| Vector store | NanoVectorDBStorage |
| Graph | NetworkXStorage |
| Doc status | JsonDocStatusStorage |

### Local scripts

| File | Purpose |
|---|---|
| `westbury/.env` | Server config (port 9622, separate WORKING_DIR) |
| `ingest_westbury.py` | Single-node ingestion (simple, slower) |
| `ingest_westbury_parallel.py` | **Parallel ingestion — use this for large runs** |
| `mcp_server_westbury.py` | MCP server → `query_westbury_papers` tool |
| `query_westbury.py` | Interactive CLI query tool |

---

## Parallel Ingestion Pipeline

### Why parallel?

At ~12 papers/hour (single vLLM node, MAX_ASYNC=4), 1,316 papers would take ~110 hours. The parallel pipeline targets ~8 hours by:
1. **3× vLLM nodes** — separate GPU nodes each running Qwen2.5-72B on 4× H100s
2. **MAX_ASYNC=32** — 32 concurrent LLM requests in flight (up from 4)
3. **Round-robin load balancing** — ingestion coordinator distributes requests across all 3 vLLM endpoints

Single ingestion process = no database write conflicts (file-based storage is safe).

### SLURM jobs

| File | Job | Resources | Walltime |
|---|---|---|---|
| `westbury/job_vllm.slurm` | `westbury_vllm` (array 1-3) | 4× H100, 128G, 24 CPUs each | 10h |
| `westbury/job_ingest_parallel.slurm` | `westbury_ingest` | CPU only, 32G, 8 CPUs | 10h |

### How it works

1. **vLLM array** (3 jobs) — each node loads Qwen2.5-72B (takes ~25–35 min), then writes its `http://hostname:8000/v1` to `westbury_rag/vllm_endpoints/{jobid}.txt`
2. **Ingestion job** — starts after the array job begins (SLURM `after:` dependency), polls for 3 endpoint files, then starts processing papers
3. **Round-robin** — `ingest_westbury_parallel.py` cycles requests across all discovered endpoints
4. **Document truncation** — documents over 60,000 tokens are truncated (65K context window leaves 5K headroom for prompts)
5. **Contextual retrieval** — `contextualize_chunks=True` (Anthropic approach: LLM generates situating context for each chunk before embedding)

### Submitting

```bash
# From local machine (ControlMaster must be active)
cd /Users/devon7y/VS_Code/rag_testing

# Submit with default 3 vLLM nodes
bash westbury/submit_pipeline.sh

# Or specify node count
bash westbury/submit_pipeline.sh 5
```

### Monitoring

```bash
# Job queue
ssh fir 'squeue -u devon7y --format="%.12i %.20j %.8T %.10M %R"'

# Live ingestion progress (rate + ETA printed each paper)
ssh fir 'tail -f /home/devon7y/scratch/devon7y/westbury_rag/logs/ingest_JOBID.out'

# Check how many vLLM endpoints have registered
ssh fir 'ls /home/devon7y/scratch/devon7y/westbury_rag/vllm_endpoints/'

# Document processing status
ssh fir 'python3 -c "
import json
with open(\"/home/devon7y/scratch/devon7y/westbury_rag/rag_storage/kv_store_doc_status.json\") as f:
    d = json.load(f)
from collections import Counter
print(dict(Counter(v[\"status\"] for v in d.values())))
print(\"Total:\", len(d))
"'
```

### Downloading results

```bash
rsync -avz fir:/home/devon7y/scratch/devon7y/westbury_rag/rag_storage/ \
  /Users/devon7y/VS_Code/rag_testing/LightRAG/rag_storage_westbury/
```

---

## Configuration

### Key settings (`westbury/.env`)

```
PORT=9622                          # separate from CML (9621)
INPUT_DIR=/Volumes/T7/Westbury papers
WORKING_DIR=.../LightRAG/rag_storage_westbury
LLM_MODEL=Qwen/Qwen2.5-72B-Instruct
EMBEDDING_MODEL=text-embedding-3-large  (OpenAI, 3072 dims)
CHUNK_SIZE=1200
CHUNK_OVERLAP_SIZE=150
ENTITY_TYPES=["Author", "Concept", "Method", "Theory", "Dataset",
              "Result", "Experiment", "Finding", "Institution", "Publication"]
```

### Parallel ingestion settings (`ingest_westbury_parallel.py`)

```python
llm_model_max_async      = 32   # concurrent entity extraction calls
contextualize_max_async  = 32   # concurrent contextualization calls
embedding_func_max_async = 16   # concurrent OpenAI embedding calls
MAX_DOC_TOKENS           = 28_000  # truncation limit (32K context - 4K headroom)
```

---

## MCP Server

Registered as `lightrag-westbury`. Claude gets tool `query_westbury_papers`.

```bash
# Registration (already done)
claude mcp add --scope user lightrag-westbury -- \
  /Users/devon7y/VS_Code/rag_testing/LightRAG/.venv/bin/python \
  /Users/devon7y/VS_Code/rag_testing/mcp_server_westbury.py
```

Loads from `LightRAG/rag_storage_westbury/` on startup (must exist before using).

---

## Known Issues & Lessons Learned

### vLLM startup timeout
- **Problem:** Qwen2.5-72B at 65K context takes 25–35 min to load. Original 20-min timeout caused array tasks to fail silently.
- **Fix:** Increased to 60 min in `job_vllm.slurm`.

### Context window overflow (original single-node job)
- **Problem:** `contextualize_chunks=True` sends the full document with each chunk. Documents >32K tokens exceeded the original `--max-model-len 32768`.
- **Fix:** Increased to `--max-model-len 65536` and added 60K-token truncation in the ingestion script.

### Single-node speed
- **Observed rate:** ~12 papers/hour (MAX_ASYNC=4, 1 node)
- **Required for 8h target:** ~165 papers/hour → 3 nodes + MAX_ASYNC=32

### Cannot merge LightRAG databases
- File-level merging of two LightRAG databases is not safe (entities would be duplicated, graph would be split into two disconnected subgraphs).
- To combine corpora: ingest all papers into the same `WORKING_DIR` in a single run (LightRAG handles incremental ingestion and entity merging automatically).

---

## Comparison: CML vs Westbury

| | CML RAG | Westbury RAG |
|---|---|---|
| Papers | ~76 | 1,316 |
| Port | 9621 | 9622 |
| Storage | `rag_storage/` | `rag_storage_westbury/` |
| MCP tool | `query_papers` | `query_westbury_papers` |
| Ingestion | `ingest.py` | `ingest_westbury_parallel.py` |
| Query CLI | `query.py` | `query_westbury.py` |
