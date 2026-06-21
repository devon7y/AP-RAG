# Investigation: 233 `unknown_source` Docs

## Summary of Findings (Contradictory — Needs Resolution)

233 docs in `kv_store_doc_status.json` have `file_path: 'unknown_source'` and `status: 'processed'`.
These are present on both HPC (Ror/Tril) and the PC — they were synced from the PC early in the project.

---

## What We Know For Certain

### Origin
- All 233 have identical `created_at` timestamps on both PC and Ror (down to the second)
- Created on **2026-03-21 between 01:56–02:01 AM EDT** (5-minute window)
- They are a subset of the PC's 637 processed docs (exact same doc IDs)
- The PC also has `file_path: 'unknown_source'` for all 233 — predates file path tracking in the script
- They were transferred to HPC via `kv_store_doc_status.json` and `kv_store_full_docs.json` sync

### Content Verification
- All 233 doc IDs verified: `doc_id == "doc-" + md5(content)` ✓
- Full text content exists in `kv_store_full_docs.json` for all 233
- Content is real (sample snippets: "Activating event knowledge", "Varieties of cognitive penetration", etc.)
- Chunk IDs exist in `kv_store_doc_status.json` (`chunks_list` field) — 3,218 total chunks

### Graph Status
- **0 of 3,218 chunks appear in `graph_chunk_entity_relation.graphml`**
- Checked by cross-referencing `source_id` fields on all graphml nodes and edges

### PDF Identity
- `pdftotext` was used to hash all 1,466 PDFs in `papers/` and `papers_large/` on Ror
- **0 matches** found — the PDF text extracted by pdftotext does not hash to any of the 233 doc IDs
- Conclusion: the PC used a different PDF extraction library (likely `pymupdf`, `pypdf`, or `pdfminer`) that produces different text output → different hash → no match

---

## The Contradiction

| Evidence | Implies |
|---|---|
| `status: 'processed'` in doc_status | Pipeline completed successfully |
| Valid content in `kv_store_full_docs.json` | Text was extracted and stored |
| 3,218 chunk IDs in `chunks_list` | Chunking was done |
| 5-minute processing time for 233 docs | Too fast for live LLM entity extraction |
| 0/3,218 chunks in graphml | Graph step was never completed |

## Possible Explanations

1. **PC ran the pipeline but graphml was wiped**: The PC may have completed full ingestion (chunking + LLM entity extraction + graph), but the graphml was later cleared or overwritten before the sync to HPC. The KV stores survived but graphml did not.

2. **PC only registered docs without full processing**: The PC may have only done the "register document" step (text extraction + chunking + storing in KV stores) but the LLM/graph step either failed silently or was never run. Status was incorrectly set to `processed`.

3. **LLM cache hits made it fast**: If the LLM response cache already had entries for all these docs' prompts, entity extraction could complete very quickly. But 5 minutes for 233 docs still seems too fast even with cache hits.

## What Codex Needs to Determine

1. Does `kv_store_text_chunks.json` contain the 3,218 chunk IDs from these docs? If yes, the chunks are fully stored and only the graph step is missing. If no, the docs need full reprocessing.

2. Does `kv_store_llm_response_cache.json` contain LLM cache entries for prompts derived from these chunks? If yes, the entity extraction was done and only `merge_nodes_and_edges` needs to be re-run (the `rebuild_graph.py` script can do this).

3. Which PDF extraction library did the PC use? Check the PC's venv/installed packages and the LightRAG version running there. This would explain the hash mismatch and potentially identify the 233 PDFs.

## Relevant Files

- `kv_store_doc_status.json` — 233 entries with `file_path: 'unknown_source'`, `status: 'processed'`
- `kv_store_full_docs.json` — full text content for all 233
- `kv_store_text_chunks.json` — **not yet checked** for the 3,218 chunk IDs
- `kv_store_llm_response_cache.json` — **not yet checked** for cache entries
- `graph_chunk_entity_relation.graphml` — confirmed 0 of 3,218 chunks present
- `rebuild_graph.py` — script designed to re-run only the graph step using cached LLM outputs

## Storage Paths
- Ror: `/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/`
- Tril: `/scratch/devon7y/westbury_rag/rag_storage_westbury_qwen3_32b/`
- PC: `C:\rag_server\rag_storage_westbury_qwen3_32b\`
