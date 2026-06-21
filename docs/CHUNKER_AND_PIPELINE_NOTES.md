# Westbury Chunker and Pipeline Notes

This note documents the current structure-aware chunker and the related Westbury ingest changes that were added around the same time.

It covers:

- the scientific chunker used by `ingest_cml_octen_v2.py`
- the rebuild-from-cache embedding flow
- the updated `job_westbury_ingest_v2.slurm` behavior
- the `westbury-submit` skill changes that support `fresh`, `resume`, and `reembed`

## 1. Scientific Chunker

The old behavior relied on LightRAG's default fixed-length token chunking.
The current pipeline uses a custom structure-aware chunker implemented in `westbury/scientific_chunker.py` and passed into LightRAG via `chunking_func=SCIENTIFIC_CHUNKER`.

For reference, LightRAG's built-in defaults are token-based chunking with:

- `CHUNK_SIZE=1200`
- `CHUNK_OVERLAP_SIZE=100`

The Westbury v2 ingest path does not use those defaults for this pipeline because the scientific chunker replaces them.

### Goals

- preserve scientific document structure better than flat token splitting
- reduce bad splits across section, paragraph, and sentence boundaries
- avoid tiny orphan chunks
- keep chunk overlap useful without leaking across unrelated sections
- exclude low-value back matter such as references and acknowledgements

### Split priority

The chunker prefers this split hierarchy:

1. section
2. paragraph
3. sentence
4. token-level hard split as a last resort

### Main behavior

- Detects major scientific sections such as `Abstract`, `Introduction`, `Methods`, `Results`, `Discussion`, `Conclusion`, `References`, and common numbered variants.
- Preserves paragraph boundaries whenever possible.
- Splits oversized paragraphs on sentence boundaries.
- Uses sentence segmentation rules that avoid common scientific false splits:
  - abbreviations like `Dr.`, `Fig.`, `Vol.`
  - `e.g.` and `i.e.`
  - decimals like `3.14`
  - initials like `J. Smith`
- Isolates figure and table captions instead of merging them into unrelated prose.
- Excludes `References` by default.
- Excludes `Acknowledgements` by default.
- Injects sentence-aware overlap from the previous chunk, but only within the same section.
- Rebalances adjacent same-section chunks to eliminate undersized chunks where possible.
- Falls back to hard token slicing only when a single sentence is still too large.

### Current config surface

The chunker is configured through `ChunkerConfig` or these env vars:

- `CHUNK_TARGET_TOKENS` default `800`
- `CHUNK_MAX_TOKENS` default `1000`
- `CHUNK_MIN_TOKENS` default `300`
- `CHUNK_OVERLAP_TOKENS` default `150`
- `CHUNK_EXCLUDE_REFS` default `1`
- `CHUNK_EXCLUDE_ACK` default `1`

### Additional hardening added after Fir cache review

The first test run on Fir showed false-positive section detection from PDF page furniture and noisy extracted headers. The chunker was tightened in several ways.

#### Header detection fixes

- Catch-all numbered header detection now requires a dotted prefix, so `1. Feature Extraction` still matches but `72 ROBERT J. BLANCHARD` does not.
- Roman numeral matching is uppercase-only for this path, so `V. Discussion` can match but lowercase date-like lines such as `v. August 18, 2018` do not.
- Known-section matching now requires the line to begin like a real heading, which blocks lowercase fragments such as `stimuli.`, `data.`, and `theory`.

#### Page-furniture cleanup

The chunker now preprocesses extracted text before section detection and removes repeated running headers and footers when page breaks are preserved in the source text.

This targets lines such as:

- journal mastheads
- author running heads
- repeated page-number lines
- date-like page boundary noise

#### Hard vs soft headings

Not every heading should force a new top-level section. The chunker now distinguishes:

- hard section boundaries:
  - `Abstract`
  - `Introduction`
  - `Methods`
  - `Results`
  - `Discussion`
  - `Conclusion`
  - `References`
  - `Acknowledgements`
  - similar major sections
- soft subsection headings:
  - `Participants`
  - `Stimuli`
  - `Apparatus`
  - `Procedure`
  - `Data Analysis`
  - other subsection-like labels

Soft headings are retained as structure cues but do not always force a new section-level split. This reduces over-fragmentation and the number of sub-`min_tokens` chunks.

#### Inline heading refinement

Some PDF text extraction collapses a heading into the start of the next paragraph. The chunker now looks for known headings at paragraph starts and can split them out, for example when extracted text looks like:

`Research Methods We recruited...`

instead of:

`Research Methods`

`We recruited...`

#### Rebalancing changes

Originally, rebalancing mainly repaired tiny tail chunks. The current logic performs a local pass across adjacent same-section chunks, so small chunks in the middle of a section can also be merged or repaired.

### Output shape

The chunker is a drop-in LightRAG `chunking_func` via:

```python
from scientific_chunker import ChunkerConfig, make_scientific_chunker

chunker = make_scientific_chunker(ChunkerConfig(target_tokens=800))
```

It returns chunk dictionaries compatible with LightRAG and also exposes richer metadata that is useful when inspecting cached chunks, including:

- `section_title`
- `token_count_without_overlap`
- `overlap_prev_tokens`
- `raw_text_without_overlap`
- `is_hard_split`

### Evaluation helper

`scientific_chunker.py` also includes `evaluate_chunks()`, which can be used to compute chunk-quality metrics without running a full RAG ingest.

### Test coverage

`westbury/test_scientific_chunker.py` covers:

- short paragraphs combining
- slightly oversized paragraphs
- massively oversized paragraphs
- sentence-aware splitting
- hard token fallback
- tiny tail and non-tail rebalancing
- cross-section overlap isolation
- references and acknowledgements exclusion
- LightRAG compatibility
- regression cases from the Fir cache review

At the time of this note, the local test suite passes.

## 2. Ingest v2 Changes Related to Chunking and Caching

The main ingest entrypoint is `westbury/ingest_cml_octen_v2.py`.

### Earlier v2 pipeline improvements

Before the scientific chunker work, the v2 ingest path had already added several reliability and throughput improvements:

- endpoint validation on discovered vLLM endpoints
- resume-aware submission behavior
- live status monitoring during ingestion
- optional Qdrant vector storage
- batched `_insert_done()` flushing
- retry and failover for LLM calls across multiple endpoints

These changes remain part of the current v2 pipeline.

#### Endpoint validation

Discovered endpoint files are no longer trusted blindly.
The ingest script validates them by:

- checking that the SLURM job ID in the filename is still active
- checking that the endpoint responds successfully on `/health`

Stale endpoint files are deleted automatically.

#### Resume support

The ingest script reads `kv_store_doc_status.json` and skips documents already known to LightRAG with status:

- `processed`
- `pending`
- `processing`

This avoids resubmitting work that is already tracked by the pipeline.

#### Live status monitor

A background monitor prints extraction progress from `kv_store_doc_status.json` every 30 seconds during ingestion so progress can be observed without opening the storage manually.

#### Qdrant support

If `QDRANT_URL` is set, the ingest script uses `QdrantVectorDBStorage` instead of the default JSON-backed NanoVectorDB.

This is intended to reduce the very large local JSON vector files produced by long runs.

#### Batched flush

`INSERT_DONE_EVERY_N` controls how often LightRAG flushes storage via `_insert_done()`.

Default behavior in v2 is no longer strictly every document. Larger flush intervals can reduce GPU idle time during heavy ingest.

#### LLM retry and failover

The v2 pipeline wraps LLM calls with:

- multiple retries
- exponential backoff
- endpoint eviction on persistent failures
- endpoint re-discovery if all current endpoints are exhausted

This makes long multi-node ingest runs more robust when individual vLLM endpoints become unhealthy.

### Scientific chunker integration

The v2 ingest script now:

- imports `ChunkerConfig` and `make_scientific_chunker`
- builds `CHUNKER_CONFIG = ChunkerConfig.from_env()`
- creates `SCIENTIFIC_CHUNKER = make_scientific_chunker(CHUNKER_CONFIG)`
- passes `chunking_func=SCIENTIFIC_CHUNKER` into LightRAG
- logs the active chunker config at startup

### Page-break preservation during PDF extraction

To support repeated header/footer stripping, the PDF extraction path now preserves page boundaries using form-feed separators:

```text
\n\f\n
```

instead of flattening all pages into one continuous newline stream.

This makes the page-furniture cleanup meaningful on freshly extracted documents.

### Chunk provenance improvement

The insert call now passes explicit IDs and file paths:

```python
await rag.ainsert(
    text,
    ids=doc_id,
    file_paths=str(pdf_path),
)
```

This fixes the earlier `unknown_source` problem in cached chunk metadata and makes debugging much easier.

### Built-in cache reuse

The current design keeps cache reuse inside the main ingest path rather than as a separate export/import workflow.

In practice that means:

- normal reruns use LightRAG's existing caches automatically when the relevant cached files are present
- `fresh` mode preserves `kv_store_llm_response_cache.json`
- `reembed` mode rebuilds vectors directly from cached intermediates

The goal is to avoid expensive LLM rework without requiring separate one-off helper scripts.

## 3. Rebuild Embeddings Mode

The v2 ingest script also added a built-in rebuild path so embeddings can be regenerated without repeating the LLM-heavy parts of the pipeline.

### Purpose

Use rebuild mode when:

- switching embedding models
- switching vector DB backends
- re-creating vector indices after storage issues

without paying again for:

- contextual chunk generation
- entity extraction
- relation extraction

### Entry point

The mode is enabled with:

- `REBUILD_EMBEDDINGS=1`

Optional tuning:

- `REBUILD_BATCH_SIZE` default `50`

### What it uses

It rebuilds vectors from the cached intermediates already stored in the working directory:

- `kv_store_text_chunks.json`
- `graph_chunk_entity_relation.graphml`

### What it does

- skips the normal LLM ingest pipeline entirely
- initializes LightRAG storage with the current embedding config
- clears old vector DB files
- re-upserts chunk embeddings
- re-upserts entity embeddings
- re-upserts relation embeddings
- flushes and finalizes storage

### What it does not do

- does not call vLLM
- does not re-run contextualization
- does not re-run entity/relation extraction
- does not need the LLM response cache to be regenerated

This makes embedding-only rebuilds much cheaper and faster than a full restart.

## 4. v2 SLURM Job Changes

`westbury/job_westbury_ingest_v2.slurm` now documents and supports both the cached rebuild flow and the new chunker.

### Operational changes

- no destructive cleanup before normal runs
- read-only status report at startup
- optional Qdrant sidecar
- periodic `_insert_done()` flushing controlled by `INSERT_DONE_EVERY_N`
- mode-aware startup messaging
- rebuild mode messaging when `REBUILD_EMBEDDINGS=1`
- no auto-resubmission in rebuild mode
- auto-resubmission for normal ingest runs when unprocessed docs remain
- `CHUNK_*` env vars passed through to the Python ingest script

### Current chunk defaults in the job script

- `CHUNK_TARGET_TOKENS=800`
- `CHUNK_MAX_TOKENS=1000`
- `CHUNK_MIN_TOKENS=300`
- `CHUNK_OVERLAP_TOKENS=150`
- `CHUNK_EXCLUDE_REFS=1`
- `CHUNK_EXCLUDE_ACK=1`

## 5. Submit Workflow Changes

The `westbury-submit` skill was updated so the operational workflow matches the new storage and rebuild behavior.

### Supported modes

- `resume`
  - keep existing progress and continue
- `fresh`
  - restart processing but preserve cached LLM responses for reuse
- `reembed`
  - rebuild only vector DB embeddings from existing cached intermediates

### Fresh-mode behavior

`fresh` no longer means deleting everything blindly.

The current fresh wipe:

- wipes doc status and full-doc tracking
- wipes chunk/entity/relation tracking files that will be regenerated
- deletes graph and vector DB files that will be rebuilt
- preserves `kv_store_llm_response_cache.json`

This is important because it allows cached LLM calls to be reused on the next run.

### Reembed-mode behavior

`reembed` clears only vector DB files and then submits the ingest job with:

- `REBUILD_EMBEDDINGS=1`

No vLLM job is required for this path.

## 6. Practical Storage Notes

There are now multiple relevant categories of cached/intermediate data in the Westbury working directory.

### LLM-derived intermediates worth preserving

- `kv_store_llm_response_cache.json`
- `kv_store_text_chunks.json`
- `graph_chunk_entity_relation.graphml`
- entity/relation tracking KV stores

These are the expensive parts to regenerate.

### Storage that can be rebuilt

- `vdb_*.json` when using NanoVectorDB
- vector collections when using Qdrant

These can be regenerated from cached intermediates when rebuild mode is used.

## 7. Known Constraints and Validation Notes

- Page-furniture stripping is most effective on newly extracted documents because it depends on preserved page separators.
- Existing older cached docs created before the `\f` page-boundary change will not fully reflect that cleanup.
- The chunker has been tested locally in isolation, but the Fir cluster must ingest fresh documents into a fresh test storage directory before the new page-aware cleanup is fully represented in cache.

## 8. Recommended Use

For a clean chunker test on Fir without touching the original database:

1. use a dedicated test storage directory
2. sync the current local `westbury/` directory to Fir
3. run `job_westbury_ingest_v2.slurm` against the test storage
4. inspect `kv_store_text_chunks.json` in that test storage

For embedding-only changes:

1. keep the cached intermediates
2. clear only vectors
3. run with `REBUILD_EMBEDDINGS=1`

This keeps the expensive LLM work reusable while still allowing storage and embedding experiments.
