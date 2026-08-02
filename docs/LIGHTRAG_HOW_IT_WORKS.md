# How LightRAG Works

LightRAG is a graph-augmented RAG system. Unlike traditional RAG that only retrieves raw text chunks via vector similarity, LightRAG builds a **knowledge graph** of entities and relationships extracted from your documents, then uses that graph structure — alongside vector search — to answer queries.

---

## High-Level Architecture

```
Documents
    │
    ▼
┌─────────────────────────────────────────────┐
│              INSERT PIPELINE                │
│  Chunk → LLM Extract → Graph + Vector DBs  │
└─────────────────────────────────────────────┘
                    │
          ┌─────────┴─────────┐
          │    3 Vector DBs   │
          │  Entity VDB       │
          │  Relation VDB     │
          │  Chunk VDB        │
          └─────────┬─────────┘
          ┌─────────┴─────────┐
          │  Knowledge Graph  │
          │  nodes = entities │
          │  edges = relations│
          └─────────┬─────────┘
                    │
┌─────────────────────────────────────────────┐
│               QUERY PIPELINE                │
│  Keywords → Search → Context → LLM → Answer│
└─────────────────────────────────────────────┘
```

---

## Storage Layout

LightRAG maintains **11 separate storage namespaces** across three storage types:

| Type | Namespace | Contents |
|------|-----------|----------|
| KV | `text_chunks` | Raw chunk text |
| KV | `full_docs` | Full documents |
| KV | `full_entities` | Entity metadata |
| KV | `full_relations` | Relation metadata |
| KV | `entity_chunks` | Chunk ID lists per entity |
| KV | `relation_chunks` | Chunk ID lists per relation |
| KV | `llm_response_cache` | Cached LLM outputs |
| Vector | `entities_vdb` | Entity description embeddings |
| Vector | `relationships_vdb` | Relation description embeddings |
| Vector | `chunks_vdb` | Raw chunk embeddings |
| Graph | `chunk_entity_relation_graph` | The knowledge graph |
| Doc Status | `doc_status` | Per-document processing state |

Each storage type is pluggable. The defaults are `JsonKVStorage`, `NanoVectorDBStorage`, and `NetworkXStorage`, but you can swap in PostgreSQL, Neo4j, Milvus, Redis, MongoDB, etc.

---

## The Insert Pipeline

### Phase 1 — Enqueue (`apipeline_enqueue_documents`)

- Normalizes input to a list of strings
- Generates a deterministic MD5 ID per document: `compute_mdhash_id(content, prefix="doc-")`
- Filters out already-processed documents by checking `doc_status`
- Each document is assigned a status: `ENQUEUED → PROCESSING → SUCCESS/FAILED`

### Phase 2 — Chunk (`chunking_by_token_size` in `operate.py:99`)

Documents are split into overlapping token windows:

```
chunk_token_size = 1200 tokens  (configurable)
chunk_overlap_token_size = 100  (configurable)
step = chunk_token_size - chunk_overlap_token_size = 1100
```

Each chunk is stored in `text_chunks` (KV) and `chunks_vdb` (vector). You can also split on a character (e.g., `"\n\n"`) before token-splitting.

### Phase 3 — Extract Entities & Relations (`extract_entities` in `operate.py:2766`)

For every chunk, the LLM is called with a structured extraction prompt. The output format uses `<|#|>` as a field delimiter and `<|COMPLETE|>` as a terminator:

```
entity<|#|>entity_name<|#|>entity_type<|#|>entity_description
relation<|#|>source_entity<|#|>target_entity<|#|>keywords<|#|>description
<|COMPLETE|>
```

A second "gleaning" pass optionally re-prompts the LLM to catch missed entities. All LLM responses are cached by a hash of (chunk content + prompts) to avoid redundant calls.

N-ary relationships (A relates to B and C) are decomposed into binary edges before storage.

### Phase 4 — Merge & Upsert (`merge_nodes_and_edges` in `operate.py:2396`)

Since the same entity (e.g., "CRISPR") may appear in dozens of chunks, all instances are merged:

**For entities (`_merge_nodes_then_upsert`):**
1. Collect all descriptions for this entity name across all chunks
2. If there are fewer than `force_llm_summary_on_merge` (default: 8) descriptions → concatenate with `<SEP>`
3. If the combined text is too long → map-reduce summarization via LLM
4. Collect all source chunk IDs (capped at 300)
5. Upsert the merged node to the knowledge graph and embed the description into `entities_vdb`

**For relations (`_merge_edges_then_upsert`):**
- Same description merging logic
- Keywords are concatenated and deduplicated
- `weight` = number of times the relation was found (frequency proxy for importance)
- Upserted to the graph and embedded into `relationships_vdb`

Entity and relation updates run concurrently under a keyed lock (one lock per entity/relation name) to prevent race conditions.

---

## The Query Pipeline

### Step 1 — Keyword Extraction (`get_keywords_from_query` in `operate.py:3247`)

The LLM extracts two kinds of keywords from the user's query:

- **High-level (HL) keywords** — broad topics and concepts (used in global search)
- **Low-level (LL) keywords** — specific entities and details (used in local search)

These are cached to avoid re-extraction on repeated queries.

### Step 2 — Search (mode-dependent)

The retrieved keywords are used to search the vector stores. Which stores are searched depends on the query mode:

| Mode | Searches | Description |
|------|----------|-------------|
| `naive` | `chunks_vdb` | Pure vector similarity — no graph |
| `local` | `entities_vdb` (LL keywords) | Entity-centric; finds connected edges |
| `global` | `relationships_vdb` (HL keywords) | Relation-centric; sorted by weight × degree |
| `hybrid` | Both `entities_vdb` + `relationships_vdb` | Round-robin merge of local + global |
| `mix` | All three VDBs | Graph results + raw chunks |

All modes apply a cosine similarity threshold (default: 0.2). Results below the threshold are dropped.

### Step 3 — Token Truncation (`_apply_token_truncation` in `operate.py:3615`)

The raw search results are pruned to fit within the LLM's context window:

- Entities sorted by cosine similarity → kept until `max_entity_tokens` reached
- Relations sorted by `relation_weight × node_degree` → kept until `max_relation_tokens` reached

### Step 4 — Chunk Retrieval (`_merge_all_chunks` in `operate.py:3786`)

For each entity/relation that survived truncation, LightRAG looks up which chunks originally mentioned it (via `entity_chunks` and `relation_chunks` KV stores), fetches those chunk texts from `text_chunks`, and deduplicates them.

This is the key insight: **the graph tells you which chunks are semantically relevant**, not just which chunks are textually similar to the query.

### Step 5 — Context Construction (`_build_context_str` in `operate.py:3888`)

The final context string for the LLM is assembled:

```
**Entity: {entity_name} ({entity_type})**
Description: {description}
Source chunks: {source_ids}

**Relation: {src} -> {tgt}**
Description: {description}
Keywords: {keywords}
Weight: {weight}

**[Chunk ID: {chunk_id}]**
{content}
```

If a reranker model is configured (`enable_rerank=True`), chunks are re-scored and filtered by `min_rerank_score` before being included.

### Step 6 — LLM Response

The assembled context is passed to the LLM with `PROMPTS["rag_response"]` (or `"naive_rag_response"` for naive mode). The response type is configurable (paragraphs, bullet points, etc.) via `QueryParam`.

---

## Why It's Slow / Memory-Hungry

Each query involves up to **three LLM calls**:
1. Keyword extraction
2. (Occasionally) Description summarization during inserts
3. Final response generation

The knowledge graph and all three vector stores are typically **held in memory** (especially with NetworkX + NanoVectorDB defaults). For large corpora, this can be several gigabytes of RAM.

The `hybrid` and `global` modes are more expensive than `local` or `naive` because they involve more graph traversal and larger search result sets.

---

## Query Mode Cost Comparison

```
naive   ──── cheapest (vector search only, no graph)
local   ──── moderate (entity vector search + edge lookup)
global  ──── moderate-expensive (relation search + centrality ranking)
hybrid  ──── expensive (local + global combined)
mix     ──── most expensive (hybrid + raw chunk search)
```

---

## Concurrency & Caching

- LLM calls are queued with a priority-based async semaphore (`llm_model_max_async`, default: 4)
- Embedding calls have a separate queue (`embedding_func_max_async`, default: 8)
- All LLM responses are cached in `llm_response_cache` by hash of inputs
- Entity/relation extraction caching is controlled separately by `enable_llm_cache_for_entity_extract`

---

## Key Source Files

| File | Role |
|------|------|
| [lightrag/lightrag.py](../LightRAG/lightrag/lightrag.py) | Main `LightRAG` class, storage wiring, insert/query entry points |
| [lightrag/operate.py](../LightRAG/lightrag/operate.py) | All core logic: chunking, extraction, merging, querying |
| [lightrag/base.py](../LightRAG/lightrag/base.py) | Abstract storage interfaces (`BaseKVStorage`, `BaseVectorStorage`, `BaseGraphStorage`) |
| [lightrag/prompt.py](../LightRAG/lightrag/prompt.py) | All LLM prompt templates |
| [lightrag/utils.py](../LightRAG/lightrag/utils.py) | Tokenizers, embedding wrapper, async queue, caching |
| [lightrag/kg/](../LightRAG/lightrag/kg/) | Storage backend implementations |
| [lightrag/llm/](../LightRAG/lightrag/llm/) | LLM provider bindings (OpenAI, Anthropic, Ollama, etc.) |
