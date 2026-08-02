# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**AP-RAG** (Academic Papers RAG) is a fork/wrapper of [LightRAG](https://github.com/HKUDS/LightRAG) specialized for ingesting and querying scientific literature. The driving use case is the **Westbury lab corpus** (~1,300–1,466 PDFs: humor, psycholinguistics, word frequency, entropy, semantic memory, cognitive science). It is a **work in progress** — much of the `docs/*.md` content is operational session notes, not stable docs.

The core specialization vs. upstream LightRAG is **structure-aware chunking for papers and books** plus an academic entity schema; everything else (knowledge-graph construction, multi-mode retrieval, storage backends) is inherited from LightRAG.

## Repository layout (read this first — the boundary is non-obvious)

This repo is **not** a clone of LightRAG at its root. The git repo tracks the root scripts plus `aprag/`, `pipeline/`, `scripts/`, `slurm/`, `tests/`, and `docs/`. The upstream library lives in a nested, **gitignored** subdirectory:

- **`LightRAG/`** — upstream LightRAG, its own git repo and its own `LightRAG/CLAUDE.md` (consult that file for library internals: the `LightRAG` class, storage backends, query modes, `operate.py`). It is `pip install -e`'d as `lightrag_hku` into both `venv/` (Python 3.14) and `LightRAG/.venv/`. **Do not edit `LightRAG/` unless you are deliberately patching the upstream library**; AP-RAG behavior is driven by passing custom functions (e.g. `chunking_func=`) into the stock `LightRAG` class, not by forking it.

  **Why LightRAG is nested rather than vendored/rewritten:** the whole point of keeping upstream LightRAG as an unmodified, self-contained subdirectory is *upgradability*. When a newer LightRAG is published, the goal is to drop it in (`git pull` / re-`pip install -e`) and keep the AP-RAG academic-paper wrapper working **without breaking anything** — so AP-RAG always rides the latest RAG engine, or can be swapped for an entirely different/better system later if that's ever justified. **This only works if the fork stays patch-free.** Every line edited *inside* `LightRAG/` becomes a manual merge conflict on the next upgrade, so anything AP-RAG needs must be expressed as an injected function/wrapper from `pipeline/` (chunking, contextualization, embedding, LLM calls), never as an in-library edit. Treat a clean `git status` inside `LightRAG/` as the target state.
- **`pipeline/`** — the academic-paper pipeline as an importable package (`from pipeline.X import …`): the structure-aware chunkers (`scientific_chunker.py`, `book_chunker.py`), the contextual-retrieval wrapper (`contextual_retrieval.py`), and the ingest entry point (`ingest.py`). This is where the core specialization lives.
- **`scripts/`** — standalone maintenance/utility scripts (not a package): prechunkers (`prechunk_papers.py`, `prechunk_books.py`), `rebuild_graph.py`, `reembed_missing.py`, `migrate_nano_to_qdrant.py`, `dedup_doc_status.py`, `verify_chunks.py`, the PDF/OCR tools, and the Octen embedding `server.py`. Scripts that need the chunkers import them from `pipeline`.
- **`slurm/`** — per-cluster SLURM jobs (kept westbury-named, since they target the westbury corpus runs): `job_westbury_*` and `job_books_*`.
- **`tests/`** — the fast, local chunker tests (`pytest tests/`).
- **`docs/`** — operational runbooks and notes (point-in-time; verify against code).
- **Root scripts** — the query/serve layer. `query.py` / `mcp_server.py` belong to the older small "CML" corpus (~76 papers, OpenAI embeddings, file-based storage). The current corpus is served by `query_server.py` (the PC HTTP API: `/query` synthesized answer + `/retrieve` raw chunks) plus the **`aprag/`** package (the `aprag` CLI and `aprag-mcp` MCP server — thin clients over that API; this replaced the old `mcp_server_westbury.py`). **Ingestion is no longer at the root** — the legacy root ingest scripts (`ingest.py`, `ingest_westbury*.py`) were removed; the sole ingest entry point is now `pipeline/ingest.py`.
- **`lightrag-explainer/`** — an unrelated Next.js 16 slideshow app (a presentation about LightRAG). Not part of the RAG pipeline.

## End-to-end architecture

The pipeline has three physically separate stages. Understanding which machine runs which stage is essential.

### 1. Ingestion — batch, on HPC (Alliance Canada clusters)

Entry point: **`pipeline/ingest.py`**, launched by SLURM. For each PDF it:
1. **Discovers + validates vLLM endpoints** — separate GPU jobs (`slurm/job_westbury_vllm_*.slurm`) each serve **Qwen3-32B (FP8)** and write `http://host:8000/v1` to an endpoints dir. The ingest script health-checks each, cross-checks the job is still in `squeue`, deletes stale files, and **round-robins LLM calls across all endpoints** with retry + exponential backoff + endpoint eviction/re-discovery.
2. **Extracts PDF text** preserving page boundaries (form-feed `\n\f\n`) so the chunker can strip repeated headers/footers.
3. **Chunks** with the custom structure-aware chunker (see below) — passed to LightRAG as `chunking_func=`.
4. **Contextualizes** each chunk (Anthropic-style: LLM writes a situating blurb before embedding), **extracts entities/relations** into the knowledge graph, and **embeds** via a local **Octen-Embedding-8B-INT8** server (dim **4096**).
5. Writes vectors to **Qdrant** (Apptainer sidecar on node-local NVMe) when `QDRANT_URL` is set, else NanoVectorDB JSON.

Concurrency is tuned by env vars (`PARALLEL_DOCS`, `LLM_MAX_ASYNC`, `CONTEXT_MAX_ASYNC`, `EMBED_FUNC_MAX_ASYNC`, `MAX_PARALLEL_INSERT`); the proven values are in [docs/CANONICAL_INGEST_PARAMS.md](docs/CANONICAL_INGEST_PARAMS.md). A SIGALRM watchdog (`CHUNK_TIMEOUT`) kills documents that hang the chunker and moves the offending PDF aside.

### 2. Storage artifacts (the LightRAG working directory)

`rag_storage_westbury_qwen3_32b/` holds the graph + KV stores + vectors. The **expensive-to-regenerate** intermediates are `kv_store_llm_response_cache.json`, `kv_store_text_chunks.json`, the entity/relation KV stores, and `graph_chunk_entity_relation.graphml`. Vector DB files (`vdb_*.json` or Qdrant collections) are **derived** and can be rebuilt from those. This split is what makes the ingest modes below possible.

### 3. Serving — always-on Windows PC, reached over Tailscale

- **`scripts/server.py`** — FastAPI on `:8000`, serves Octen embeddings (OpenAI-compatible `/v1/embeddings`).
- **`query_server.py`** — FastAPI on `:8001`, loads the LightRAG store once + Qdrant (`:6333`) + the Octen embedder. `POST /query` synthesizes answers with **gpt-5-mini** (OpenAI API); `POST /retrieve` returns raw structured retrieval (entities/relationships/chunks via LightRAG's stock `aquery_data`, **no LLM**) — the agent-orchestrated multi-hop primitive. Note the asymmetry: **Qwen3-32B at ingest time, gpt-5-mini at query time.**
- **`apa_citations.py`** (root) — rewrites the answer LLM's numeric citations into **APA7**: `/query` calls LightRAG's `aquery_llm` (returns the answer **and** the `reference_id → file_path` map in one call — so no `LightRAG/` patch), then this module replaces in-text `[n]` with `(Author, Year)` and rebuilds `### References` from a filename→bib-record manifest (`papers_metadata.json`, built by [scripts/build_apa_manifest.py](scripts/build_apa_manifest.py) via Crossref-full + LLM extraction; records carry authors/year/title/journal/etc. **plus** keywords/abstract/subjects/affiliations for filtered search). The end references also show the **PDF page(s)** the cited passages came from (`pp. 3, 12`); the server reads those from a `page_start` the chunker stamps on each chunk via `_rag.text_chunks.get_by_ids(...)` (in-text citations stay page-less; pages need a page-aware re-ingest). `/query` returns `{answer, references, mode}`. Deploy `apa_citations.py` + `aprag_search.py` + `papers_metadata.json` next to `query_server.py`. Server env: `APA_MANIFEST`, `HADES_PAPERS_BASE`.
- **`aprag_search.py`** (root) — **metadata-filtered semantic search** (pure helpers; the user's "BM25" turned out to mean *filter a semantic search by metadata*). `query_server` resolves a `filters` dict (`authors/year[_from/_to]/journals/subjects/keywords/affiliations`) against the manifest → matching filenames, then runs a **parallel Qdrant query** (`_rag.chunks_vdb._client` + `pc_embed`) with a `file_path` match-any filter — read-only use of LightRAG objects, **no patch**. Exposed as `POST /search` (ranked papers) and an optional `filters` field on `/query` + `/retrieve`.
- **`aprag/`** — an installable package (`pip install -e .`) exposing two thin clients over `query_server.py`: the **`aprag`** CLI (`aprag ask` = synthesized, `aprag chunks` = raw chunks, `aprag search` = metadata-filtered paper search) and the **`aprag-mcp`** stdio MCP server (tools **`aprag_query`** + **`aprag_retrieve`** + **`aprag_search`**; modes `hybrid`/`local`/`global`/`mix`/`naive`; all accept the metadata filters). Server URL via `APRAG_QUERY_URL`. `aprag/references.py` does **client-side** APA citation linking with fallback order **local → Drive → hades → filename**: it matches each cited PDF by filename under `$APRAG_PAPERS_DIR` (a clickable `file://` link — incl. a Google Drive for Desktop mount), else a per-file **Google Drive** link (`[open in Drive]`), else the hades share path. The Drive links come from a `filename → webViewLink` map (`drive_links.json`, built by [scripts/build_drive_map.py](scripts/build_drive_map.py) via rclone or the Drive API; server env `APRAG_DRIVE_MAP`); the Drive is private/shared so links open only for the lab's accounts. Set `HADES_PAPERS_BASE=""` to drop hades once the Drive map is complete. Client machines run no models and hold no data. Full deployment + access instructions: [docs/APRAG_ACCESS.md](docs/APRAG_ACCESS.md).

## The academic-paper specialization

This is the reason AP-RAG exists. LightRAG's default fixed-length token chunker is replaced by structure-aware chunkers selected via `CHUNKER_TYPE`:

- **`pipeline/scientific_chunker.py`** (default, `CHUNKER_TYPE=scientific`) — splits on a section → paragraph → sentence → hard-token priority. Detects scientific sections (Abstract/Methods/Results/…), distinguishes **hard section boundaries from soft subsection headings** (Participants, Stimuli, Procedure), strips page furniture (running heads, mastheads, page numbers), avoids false sentence splits on abbreviations/decimals/initials, isolates figure/table captions, injects sentence-aware overlap **only within the same section**, rebalances undersized chunks, and **excludes References + Acknowledgements** by default.
- **`pipeline/book_chunker.py`** (`CHUNKER_TYPE=book`) — chapter detection, skips contents/index pages, handles multi-line chapter headings.

Both expose `make_*_chunker(Config.from_env())` returning a LightRAG-compatible `chunking_func`, support an optional pre-computed chunk cache (`chunk_cache.json` / `book_chunk_cache.json`, produced by `scripts/prechunk_*.py`), and carry an `evaluate_chunks()` helper. Tuning is via `CHUNK_TARGET_TOKENS` (800), `CHUNK_MAX_TOKENS` (1000), `CHUNK_MIN_TOKENS` (300), `CHUNK_OVERLAP_TOKENS` (150), `CHUNK_EXCLUDE_REFS`, `CHUNK_EXCLUDE_ACK`. Design rationale and the Fir-cache regression fixes are in [docs/CHUNKER_AND_PIPELINE_NOTES.md](docs/CHUNKER_AND_PIPELINE_NOTES.md).

The entity schema is also academic (Author, Concept, Method, Theory, Dataset, Result, Experiment, Finding, Institution, Publication) — see `ENTITY_TYPES` in `.env`.

## Ingest modes (the operational model)

The v2 pipeline and its SLURM wrapper support three modes, chosen by what gets cleaned before submission:

- **resume** (default) — continue; skip docs already `processed`/`pending`/`processing`; reuse all caches.
- **fresh** — wipe doc-status, graph, and vector files **but preserve `kv_store_llm_response_cache.json`** so the costly LLM extraction is reused on the rerun. (Not a blind `rm -rf`.)
- **reembed** (`REBUILD_EMBEDDINGS=1`) — rebuild **only** the vector DB from cached chunks + graph. **No vLLM job needed.** Use when switching embedding model or vector DB backend. Tuned by `REBUILD_BATCH_SIZE`.

## Commands

### Chunker tests (run locally — these are the only fast, machine-independent tests here)
```bash
pip install -e .                                   # registers the `pipeline` package
python -m pytest tests/ -v
python -m pytest tests/test_chunkers_pdf.py -v     # runs chunkers over real sample PDFs
python -m pytest tests/test_scientific_chunker.py -v -k rebalance   # single test by name
```
The chunkers live in the `pipeline/` package (imported as `from pipeline.scientific_chunker import …`); run from the repo root after `pip install -e .`.

### Lint
```bash
ruff check .          # repo convention inherited from upstream LightRAG
```

### Running ingestion (HPC only — not run locally)
Ingestion needs GPUs and is submitted via SLURM on Fir/Rorqual/Nibi/Trillium (H100). Per-cluster scripts are suffixed `_ror` / `_nibi` / `_tril`. The standard pattern is **3 vLLM jobs + 1 ingest job with a SLURM dependency**; exact `sbatch` commands and parameter values live in [docs/CANONICAL_INGEST_PARAMS.md](docs/CANONICAL_INGEST_PARAMS.md) and [docs/SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md). HPC cluster/SSH/Globus details are in the global `~/.claude/CLAUDE.md` and the `hpc-run` skill — don't duplicate them here. Always clear stale endpoint files and stale `pending`/`processing` doc-status entries before resubmitting.

### VLM (figure/table/equation) ingestion — `INGEST_VLM=1`
Optional native-multimodal path: an external **MinerU** parser service extracts figures/tables/equations and LightRAG's `vlm` role (the **same Qwen3.6** served at ingest) captions them into chunks + the KG. **Off by default** (`INGEST_VLM=0` = the unchanged text-only path). When enabled a run is **vLLM job(s) + a MinerU service job + the ingest job** (not just vLLM + ingest): `sbatch slurm/job_setup_mineru.slurm` once, then `slurm/job_westbury_mineru.slurm` alongside vLLM, then submit ingest with `--export=ALL,INGEST_VLM=1` depending on both. MinerU only *extracts* (its own image analysis stays off via `MINERU_LOCAL_IMAGE_ANALYSIS=false`); Docling is a drop-in fallback (`PARSE_ENGINE=docling`). **⚠️ Only Fir is wired so far (Phase 1). Still TODO:** stage MinerU models for the offline clusters (Nibi/Trillium/Narval have no compute-node internet — Globus the model cache + set `MINERU_MODEL_SOURCE=local`), add per-cluster `job_westbury_mineru_*` jobs, and add the `INGEST_VLM`/`MINERU_*` env block to the `_nibi`/`_ror`/`_tril` ingest jobs. The `mineru` pip extra + `mineru-models-download` flags in the setup job are marked **VERIFY** (depend on the installed MinerU version). Full runbook: [docs/VLM_INGEST.md](docs/VLM_INGEST.md).

### Running the serving stack (on the PC)
```bash
python -m uvicorn server:app       --host 0.0.0.0 --port 8000   # Octen embeddings (source: scripts/server.py)
python -m uvicorn query_server:app --host 0.0.0.0 --port 8001   # query API (loads LightRAG + Qdrant)
```
`restart_aprag_pc.sh` restarts the PC stack. The LightRAG/Octen maintenance utilities in `scripts/` (`rebuild_graph.py`, `reembed_missing.py`, `migrate_nano_to_qdrant.py`, `repair_*.py`, `verify_chunks.py`) are one-off, generally run on the cluster or PC.

## Conventions & gotchas specific to this repo

- **Embedding dim is 4096** (Octen-Embedding-8B), not the 3072 of the old `text-embedding-3-large` path. `docs/PIPELINE_README.md` describes the **superseded** Qwen2.5-72B + OpenAI-embeddings + NanoVectorDB setup — treat the code, `docs/APRAG_ACCESS.md`, and `SESSION_HANDOFF.md` as current when they disagree.
- **Changing the embedding model or its dimension requires rebuilding the vector store** (use reembed mode). Embeddings must be identical at index and query time.
- **Qdrant collections** require `workspace_id: "_"` in the payload for LightRAG to find them; with no `model_name` set, LightRAG uses legacy collection names `lightrag_vdb_{namespace}` (e.g. `lightrag_vdb_entities`).
- **Never `json.load` `kv_store_llm_response_cache.json` on an HPC login node** — it's hundreds of MB and will get OOM-killed. Check integrity with `tail -c 20` instead.
- **LightRAG databases cannot be safely merged** at the file level (entities duplicate, graph splits). To combine corpora, ingest everything into one `WORKING_DIR` in a single run and let LightRAG merge entities incrementally.
- **Watch for auto-resubmit loops** — older HPC copies of `job_westbury_ingest_v2_*.slurm` self-resubmitted and spawned runaway job chains; the v2 scripts here removed it for ingest but rebuild mode never resubmits.
- Use `lightrag.utils.logger` (not `print`) inside library-style code; the ingest scripts use `print(..., flush=True)` for SLURM log streaming, which is intentional.

## Where the runbooks are

`docs/` contains operational notes worth consulting before large runs: `PRE_FLIGHT.md`, `BOTTLENECKS.md`, `JOB_STATUS_CHECK.md`, `PARALLEL_DOCS_FIX.md`, `UNKNOWN_SOURCE_233_DOCS.md` (alongside `CANONICAL_INGEST_PARAMS.md`, `CHUNKER_AND_PIPELINE_NOTES.md`, `SESSION_HANDOFF.md`, `PC_OCTEN_SETUP.md`), plus `LIGHTRAG_HOW_IT_WORKS.md`. These are point-in-time and may be stale — verify against the code.
