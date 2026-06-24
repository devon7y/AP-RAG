# AP-RAG — Academic Papers RAG

**AP-RAG** is a retrieval-augmented-generation system specialized for **scientific literature**. It is a thin, upgrade-friendly **wrapper around [LightRAG](https://github.com/HKUDS/LightRAG)** that adds structure-aware chunking for papers and books, an academic entity schema, and Anthropic-style contextual retrieval — while leaving the LightRAG knowledge-graph engine completely unmodified.

The driving use case is the **Westbury lab corpus** (~1,300+ PDFs: humor, psycholinguistics, word frequency, entropy, semantic memory, cognitive science), and the design generalizes to any collection of academic PDFs.

> **Status:** active work in progress. The serving/access layer (`aprag`) and the ingest pipeline are in use; several `docs/*.md` files are operational notes rather than stable docs.

---

## Design philosophy: a wrapper, not a fork

The core idea is **upgradability**. Upstream LightRAG lives in a nested, git-ignored `LightRAG/` subdirectory and is never edited. Everything AP-RAG adds is expressed as **functions injected into the stock `LightRAG` class** — a custom `chunking_func`, an embedding function, an LLM function — never as an in-library patch.

```
import lightrag (unmodified, upstream)  ──►  LightRAG(chunking_func=…, embedding_func=…, llm_model_func=…)
                                                        ▲
        AP-RAG wrappers (this repo, in pipeline/) ─────┘
        structure-aware chunker · contextual retrieval · academic schema
```

Why it matters: when a newer LightRAG ships, you drop it in (`git checkout <tag>` + `pip install -e`) and the wrapper keeps working — AP-RAG always rides the latest engine, or can be swapped for a different one entirely. **This only works while the fork stays patch-free**, so a clean `git status` inside `LightRAG/` is the target state. (Currently pinned to **LightRAG v1.5.3**.)

---

## Key features

- **Structure-aware chunking for papers** — splits on a section → paragraph → sentence → token priority; detects scientific sections (Abstract/Methods/Results/…), distinguishes hard section boundaries from soft subsection headings, strips running heads / page numbers / mastheads, avoids false sentence splits on abbreviations and decimals, isolates figure/table captions, adds sentence-aware overlap **within a section only**, and excludes References + Acknowledgements by default.
- **Book chunking** — chapter detection, skips contents/index pages, handles multi-line chapter headings.
- **Contextual retrieval** (Anthropic-style) — before embedding, an LLM writes a short situating blurb for each chunk, implemented as a wrapper around the chunker so the LightRAG core stays untouched.
- **Academic entity schema** — Author, Concept, Method, Theory, Dataset, Result, Experiment, Finding, Institution, Publication.
- **Agent-ready access layer** — an `aprag` CLI and an `aprag-mcp` MCP server expose both synthesized answers and raw multi-hop retrieval.
- **Multiple ingest modes** — `resume`, `fresh` (reuse the expensive LLM cache), and `reembed` (rebuild only the vector DB).

---

## Architecture

The pipeline has three physically separate stages. Knowing which machine runs which stage is essential.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. INGEST  — batch, on HPC GPU nodes (Alliance Canada H100 clusters)        │
│    pipeline/ingest.py (launched by SLURM)                      │
│    PDFs → extract text → structure-aware chunk → contextualize → extract    │
│    entities/relations (Qwen3-32B FP8, vLLM) → embed (Octen-8B, dim 4096)    │
│    → write graph + KV stores + vectors (Qdrant or NanoVectorDB)             │
└────────────────────────────────────────────────────────────────────────────┘
                                   │  (storage artifacts: graph + KV + vectors)
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 2. SERVE  — always-on PC, reached over Tailscale                            │
│    server.py        :8000  Octen embeddings (OpenAI-compatible)             │
│    query_server.py  :8001  loads LightRAG + Qdrant + embedder               │
│        POST /query     → synthesized cited answer (gpt-5-mini)              │
│        POST /retrieve  → raw entities/relationships/chunks, no LLM          │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 3. CLIENTS  — any machine (run no models, hold no data)                     │
│    aprag CLI   ·   aprag-mcp MCP server  →  POST to the PC's :8001          │
└────────────────────────────────────────────────────────────────────────────┘
```

Note the model asymmetry: **Qwen3-32B at ingest time, gpt-5-mini at query time**, **Octen-Embedding-8B-INT8 (dim 4096)** for embeddings throughout.

---

## Repository layout

| Path | What it is |
|---|---|
| `pipeline/` | The pipeline package: structure-aware chunkers (`scientific_chunker.py`, `book_chunker.py`), the contextual-retrieval wrapper (`contextual_retrieval.py`), and the ingest entry point (`ingest.py`). Imported as `from pipeline.X import …`. |
| `scripts/` | Standalone maintenance/utility scripts: prechunkers, graph/embedding rebuilders, Qdrant migration, PDF/OCR tools, and the Octen embedding `server.py`. |
| `slurm/` | Per-cluster SLURM jobs for the corpus runs (`job_westbury_*`, `job_books_*`). |
| `tests/` | Fast, local chunker tests (`pytest tests/`). |
| `docs/` | Runbooks and operational notes. |
| `aprag/` | Installable access package — the `aprag` CLI and `aprag-mcp` MCP server (thin clients over the query server). |
| `query_server.py`, `scripts/server.py` | The PC serving stack (LightRAG query API + Octen embedding server). |
| `LightRAG/` | **Upstream LightRAG, git-ignored.** Its own repo; pinned to v1.5.3; never edited. |
| `lightrag-explainer/` | Unrelated Next.js slideshow app (git-ignored). Not part of the pipeline. |
| `CLAUDE.md` | In-depth internal guide to the codebase. |
| `APRAG_ACCESS.md` | How to give a new user access (Tailscale + `aprag`). |
| `docs/CANONICAL_INGEST_PARAMS.md` | Proven ingest parameters and the standard SLURM submission pattern. |

---

## Installation

### 1. Clone and add the LightRAG engine

`LightRAG/` is git-ignored — clone it into place and install it editable:

```bash
git clone https://github.com/devon7y/AP-RAG.git
cd AP-RAG

# Add the (unmodified) LightRAG engine, pinned to the supported version
git clone https://github.com/HKUDS/LightRAG.git
git -C LightRAG checkout v1.5.3
python -m pip install -e LightRAG
```

### 2. Install the `aprag` client (for querying)

```bash
pip install -e .          # exposes `aprag` and `aprag-mcp` on your PATH
```

The client only needs `httpx` and `mcp` — it runs no models and holds no data; it forwards to the query server.

### 3. (Optional) run the chunker tests

These are the only fast, machine-independent tests; run them from the repo root after `pip install -e .` (which registers the `pipeline` package):

```bash
python -m pytest tests/ -v
python -m pytest tests/test_chunkers_pdf.py -v        # runs chunkers over real sample PDFs
```

---

## Usage

### Query the knowledge base

Point the client at a running query server and ask:

```bash
export APRAG_QUERY_URL=http://<host>:8001        # e.g. the always-on PC over Tailscale

aprag ask "What does the corpus say about humor and incongruity?" --mode hybrid
aprag chunks "humor incongruity entropy" --mode naive --chunk-top-k 5
aprag chunks "surprisal" --mode local --entities      # also show graph entities/relations
aprag health
```

- `ask` → a synthesized, **cited** answer (gpt-5-mini over retrieved context).
- `chunks` → **raw** retrieved chunks (+ graph entities/relationships in graph modes), **no LLM** — the primitive for agentic multi-hop retrieval.
- Modes: `local`, `global`, `hybrid`, `mix`, `naive`.

Register the MCP server so an agent (Claude Code, Claude Desktop, …) can query:

```bash
claude mcp add --scope user aprag --env APRAG_QUERY_URL=http://<host>:8001 -- aprag-mcp
```

It exposes two tools: `aprag_query(question, mode)` → synthesized answer, and `aprag_retrieve(question, mode, …)` → raw chunks. Full setup (Tailscale, etc.): see [APRAG_ACCESS.md](APRAG_ACCESS.md) and [aprag/README.md](aprag/README.md).

### Run the serving stack (on the PC)

```bash
python -m uvicorn server:app       --host 0.0.0.0 --port 8000   # Octen embeddings (source: scripts/server.py)
python -m uvicorn query_server:app --host 0.0.0.0 --port 8001   # query API (loads LightRAG + Qdrant)
```

### Run ingestion (on HPC)

Ingestion needs GPUs and is submitted via SLURM on Alliance Canada H100 clusters (Fir / Rorqual / Nibi / Trillium). The standard pattern is **N vLLM jobs serving Qwen3-32B + one ingest job** with a SLURM dependency; per-cluster scripts are suffixed `_ror` / `_nibi` / `_tril`. Exact `sbatch` commands and proven parameters are in [docs/CANONICAL_INGEST_PARAMS.md](docs/CANONICAL_INGEST_PARAMS.md).

**Ingest modes:**

| Mode | What it does | When |
|---|---|---|
| `resume` (default) | Continue; skip already-processed docs; reuse all caches. | Normal incremental runs. |
| `fresh` | Wipe doc-status/graph/vectors but **keep** the LLM response cache. | Re-run without paying for LLM extraction again. |
| `reembed` (`REBUILD_EMBEDDINGS=1`) | Rebuild **only** the vector DB from cached chunks + graph; no vLLM needed. | Switching embedding model or vector backend. |

---

## Configuration

Behavior is driven by environment variables (no code edits needed):

| Variable | Purpose |
|---|---|
| `CHUNKER_TYPE` | `scientific` (default), `book`, or `auto` (per-document structure routing — classify each PDF as book/paper via TOC + chapter/IMRaD detection and dispatch to the matching chunker; see `pipeline/document_router.py`). |
| `ROUTER_PAGE_THRESHOLD` / `ROUTER_MIN_CHAPTERS` / `ROUTER_MIN_IMRAD` / `ROUTER_DETECT_TOC` / `ROUTER_TOC_SCAN_PAGES` | `CHUNKER_TYPE=auto` thresholds (defaults 50 / 3 / 3 / 1 / 15). Page count is only a tie-breaker; structure (TOC, chapters, IMRaD) decides first. |
| `CHUNK_TARGET_TOKENS` / `CHUNK_MAX_TOKENS` / `CHUNK_MIN_TOKENS` / `CHUNK_OVERLAP_TOKENS` | Chunk sizing (defaults 512 / 640 / 192 / 51; lowered from 800/1000/300/150 per the chunk-size eval — see scripts/chunk_eval/). |
| `CHUNK_EXCLUDE_REFS` / `CHUNK_EXCLUDE_ACK` | Drop References / Acknowledgements sections. |
| `CONTEXTUALIZE_CHUNKS` | `1` (default) enables contextual retrieval via the chunker wrapper. |
| `CONTEXT_MAX_ASYNC`, `LLM_MAX_ASYNC`, `EMBED_FUNC_MAX_ASYNC`, `PARALLEL_DOCS`, `MAX_PARALLEL_INSERT` | Concurrency tuning (see `docs/CANONICAL_INGEST_PARAMS.md`). |
| `QDRANT_URL` | Use Qdrant for vectors; otherwise file-based NanoVectorDB. |
| `APRAG_QUERY_URL` | Where the `aprag` client sends requests. |

> Changing the embedding model or its dimension requires rebuilding the vector store (`reembed` mode) — embeddings must be identical at index and query time.

---

## Acknowledgements

AP-RAG is built on **[LightRAG](https://github.com/HKUDS/LightRAG)** by HKUDS, which provides the knowledge-graph construction, multi-mode retrieval, and storage backends. AP-RAG adds the academic-paper specialization on top and keeps LightRAG unmodified so it can be upgraded independently. All credit for the underlying RAG engine goes to the LightRAG authors.
