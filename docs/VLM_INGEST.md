# VLM (figure/table/equation) ingestion

Adds figures, charts, and image-based tables/equations to the knowledge graph via
LightRAG's **native multimodal pipeline**. An external **parser service** (MinerU by
default) extracts those items from each PDF into sidecars; LightRAG's `vlm` role —
**the same Qwen3.6 model already served at ingest** — captions them; the captions are
embedded and entity-extracted alongside the text. MinerU only *extracts*; Qwen3.6 does
the captioning (so MinerU's own image analysis is left **off**).

Gated behind `INGEST_VLM=1`. Default (`0`) is the unchanged text-only `ainsert` path.

## ⚠️ Phase 1 (Fir only) — validate before the first real run

Three things genuinely need validation on the cluster (none of these can be exercised
off-cluster):

1. **The empirical crux**: confirm that under `pending_parse`, the scientific chunker +
   contextualization actually run on MinerU's text (the whole design rests on it — the
   code traces say yes, but verify on the first run via chunk shapes / the KG).
2. **VERIFY items**: the exact `mineru[...]` pip extra and `mineru-models-download` flags
   depend on the installed MinerU version — these are flagged inline in the setup job.
3. **Phase 2 (offline clusters)**: Nibi/Trillium/Narval need MinerU models pre-staged
   (Globus the cache, `MINERU_MODEL_SOURCE=local`) and the `_nibi/_ror/_tril` ingest jobs
   wired — currently only Fir is wired. Docling remains a one-env-var fallback if MinerU
   disappoints.

## How it works (code)

- `pipeline/ingest.py`: when `INGEST_VLM=1`, the `vlm` role is wired to the round-robin
  Qwen3.6 endpoint (`role_llm_configs={"vlm": {...}}` + `vlm_process_enable=True`), and
  ingestion switches from `rag.ainsert(text)` to
  `rag.apipeline_enqueue_documents(..., docs_format="pending_parse", parse_engine=PARSE_ENGINE, process_options="ite")`
  followed by a single `rag.apipeline_process_enqueue_documents()`
  (`ingest_native_multimodal()`).
- The scientific chunker **and** the contextualization wrapper still run — under
  `pending_parse` the parser's full document text is passed to `chunking_func` as
  `content`. (Empirically confirm this on the first real run; the whole design rests on it.)
- LightRAG handles resume/dedup, Qdrant selection, and `kv_store_doc_status.json` the
  same as the text path.

## Env vars

| var | default | meaning |
|---|---|---|
| `INGEST_VLM` | `0` | `1` enables the native multimodal path |
| `PARSE_ENGINE` | `mineru` | `mineru` or `docling` |
| `PROCESS_OPTIONS` | `ite` | per-doc flags: i=images, t=tables, e=equations |
| `VLM_MAX_ASYNC` | `LLM_MAX_ASYNC` | max concurrent VLM caption calls |
| `MINERU_API_MODE` | `local` | `local` (self-hosted) or `official` (cloud) |
| `MINERU_LOCAL_ENDPOINT` | — | base URL of the MinerU server (no path); auto-filled from the endpoint file by the SLURM job |
| `MINERU_LOCAL_BACKEND` | `pipeline` | MinerU backend (pipeline = no internal VLM) |
| `MINERU_LOCAL_IMAGE_ANALYSIS` | `false` | keep MinerU's own captioner OFF (LightRAG's `vlm` role captions) |
| `MINERU_ENABLE_TABLE` / `MINERU_ENABLE_FORMULA` | `true` | extract tables / formulas |

Docling fallback: `PARSE_ENGINE=docling` + `DOCLING_ENDPOINT=http://host:port`.

## Run it (Phase 1 — Fir, online)

1. **One-time**: `sbatch slurm/job_setup_mineru.slurm` (builds `venv_mineru`, installs
   MinerU, pre-downloads pipeline models). *(VERIFY the `mineru[...]` pip extra and the
   `mineru-models-download` flags against the installed MinerU version.)*
2. Start the parser service: `sbatch slurm/job_westbury_mineru.slurm` (serves
   `mineru-api`, publishes `http://host:8100` to `$WORKDIR/mineru_endpoints/`).
3. Start the vLLM job(s) as usual (Qwen3.6 — also the captioner).
4. Submit ingest with VLM on, depending on both services:
   ```bash
   sbatch --dependency=after:$VLLM_JOB:$MINERU_JOB \
     --export=ALL,INGEST_VLM=1 slurm/job_westbury_ingest_v2.slurm
   ```

## Verify (first real run)

- Figure/table captions appear as chunks; figure-derived entities appear in the graph
  (`aquery_data` / Qdrant).
- The scientific chunker + contextualization ran on the body text (chunk shapes/ids look
  normal, not one-chunk-per-page).
- Resume re-skips processed docs; Qdrant + `kv_store_doc_status.json` look correct.

## Phase 2 — offline clusters (Nibi / Trillium / Narval) — TODO

Compute nodes there have **no internet**, so MinerU models must be pre-staged:
- Build `venv_mineru` + download models on Fir, then **Globus-transfer** the model cache
  (and venv if compatible) to each cluster; set `MINERU_MODEL_SOURCE=local` in the MinerU
  service job.
- Add per-cluster `job_westbury_mineru_{nibi,ror,tril}.slurm` and wire the same
  `INGEST_VLM`/`MINERU_*` env block into `job_westbury_ingest_v2_{nibi,ror,tril}.slurm`
  (only the Fir ingest job has it today).

## Fallback

If MinerU's offline staging or extraction quality disappoints, switch to **Docling**:
the AP-RAG code is parser-agnostic (`PARSE_ENGINE=docling`), so only the service job and
a couple of env vars change — not the ingest logic.
