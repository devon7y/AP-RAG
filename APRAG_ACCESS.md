# AP-RAG (`aprag`) — Giving Someone Access via Tailscale

How to give a new user access to the AP-RAG academic-papers knowledge base. There are
two ways in, both thin clients over the always-on PC:

- **`aprag` CLI** — for humans and scripts.
- **`aprag-mcp` MCP server** — so an agent (Claude Code, Cursor, Codex, Gemini CLI, …) can query.

Both expose the same two capabilities:

- **`aprag ask` / the `aprag_query` tool** — a synthesized, cited answer (gpt-5-mini over the
  retrieved context).
- **`aprag chunks` / the `aprag_retrieve` tool** — the raw retrieved chunks (plus graph
  entities/relationships in graph modes), **no LLM**. This is the primitive for agentic
  multi-hop retrieval: read the chunks, pick a lead, query again with a refined question
  and/or a different mode.

The corpus currently covers ~1,300 papers from the Westbury lab (humor, psycholinguistics,
word frequency, entropy, semantic memory, cognitive science) and is expanding beyond it. All
heavy computation runs on a dedicated PC — the user's machine just forwards requests over the
network and gets results back.

**Query modes:** `hybrid` (default for `ask`) · `local` · `global` · `mix` · `naive`
(default for `chunks`).

---

## System architecture

```
User's machine
└── aprag package  (CLI `aprag` and/or MCP `aprag-mcp`)
    └── POST http://<PC_TAILSCALE_IP>:8001/{query,retrieve}
        └── PC (Windows, always on)
            ├── query_server.py (FastAPI, port 8001)
            │   ├── LightRAG knowledge graph
            │   ├── Qdrant vector DB (local, port 6333)
            │   └── Octen-Embedding-8B-INT8 (local, port 8000)
            └── gpt-5-mini via OpenAI API (answer synthesis — /query only)
```

The user's machine runs zero models and holds zero data. It just needs Python, Tailscale,
and the `aprag` package (which pulls in two small dependencies: `httpx` and `mcp`).

---

## Prerequisites for the new user

- **Tailscale** installed and connected to the shared network
- **Python 3.10+** (any distribution)
- For MCP use: an MCP-capable client (e.g. **Claude Code CLI**:
  `npm install -g @anthropic-ai/claude-code`)
- The PC Tailscale IP: `100.98.84.84` (confirm this is still current before sharing)

---

## Step 1 — Invite them to the Tailscale network

1. In the Tailscale admin console: **Settings → Users → Invite users** (or a direct invite link)
2. They install Tailscale and accept the invite
3. Verify they can reach the PC: `ping 100.98.84.84`
4. Verify the query server is reachable:
   ```bash
   curl http://100.98.84.84:8001/health
   # Expected: {"status":"ok","storage":"...","llm":"gpt-5-mini","lightrag_has_aquery_data":true}
   ```

---

## Step 2 — Install the `aprag` package

Give them the repo (they need at least the `aprag/` package and `pyproject.toml`). Then, in
whichever Python environment they'll use:

```bash
pip install .          # from the repo root  (or: pip install -e .  for a dev checkout)
```

This puts **`aprag`** and **`aprag-mcp`** on the PATH of that environment. Verify:

```bash
aprag --version
```

---

## Step 3 — Point it at the server

Server selection precedence: `--server URL` > `--local` > `$APRAG_QUERY_URL` >
`http://localhost:8001`. The simplest setup is the env var:

```bash
export APRAG_QUERY_URL=http://100.98.84.84:8001
aprag health        # should print the server's /health JSON
```

---

## Step 4 — CLI usage

```bash
aprag ask "What research has been done on humor and incongruity?" --mode hybrid
aprag chunks "humor incongruity entropy" --mode naive --chunk-top-k 5
aprag chunks "surprisal" --mode local --entities       # also show graph entities/relationships
aprag chunks "humor" --json | jq '.data.chunks | length'
```

---

## Citations: APA7 + clickable local / hades PDF links

`aprag ask` (and the `aprag_query` MCP tool) return answers with **APA7 in-text citations**
(`(Westbury & Hollis, 2019)`) and an **APA7 `### References`** list — not the raw file paths the
underlying engine produces. Each reference resolves to a usable PDF location:

- If the cited PDF is **on your machine**, the reference becomes a clickable `file://` link.
  Matching is by **filename** (identical across the corpus, hades, and your copy — the path may
  differ). Set where to look with `APRAG_PAPERS_DIR` (`os.pathsep`-separated; defaults include
  `~/Zotero`, `~/Documents/papers`, `~/Papers`, `~/Downloads`):
  ```bash
  export APRAG_PAPERS_DIR="$HOME/Zotero:$HOME/Documents/papers"
  aprag ask "humor and incongruity"            # local hits become file:// links
  aprag ask "…" --papers-dir /Volumes/lab/pdfs # add a dir for this call
  aprag ask "…" --no-local                     # skip local search; show hades paths
  ```
- Otherwise it shows a **Google Drive link** to that exact PDF (`[open in Drive]`), when a Drive
  map is configured (see below) — then the **hades path** as a last resort, then the bare filename.
  Fallback order: **local → Drive → hades → filename**.

Local resolution happens entirely client-side (the server can't see your filesystem); the server
emits the APA7 text + the Drive/hades locator, and the client swaps in a `file://` link when it
finds the PDF locally. `aprag chunks` / `aprag_retrieve` are unchanged (raw, no citations).

**Google Drive fallback (private, internal).** Put the corpus in a shared Drive folder, then build
a `filename → Drive link` map and point the server at it — references to papers a reader doesn't
have locally become one-click `[open in Drive]` links (which only open for accounts the folder is
shared with; nothing is exposed publicly):

```bash
# enumerate the Drive folder once (rclone remote, or the Drive API) → drive_links.json
python3 scripts/build_drive_map.py rclone gdrive:aprag_papers --out drive_links.json
# deploy drive_links.json next to query_server.py; the server finds it via APRAG_DRIVE_MAP
```

Bonus: a user who runs **Google Drive for Desktop** and adds the synced folder to
`APRAG_PAPERS_DIR` gets instant local `file://` opening for *every* paper (Drive streams it on
click) — no per-file links needed for them. Set `HADES_PAPERS_BASE=""` on the server to drop the
hades fallback once the Drive map covers the corpus.

**Page numbers.** Each end-of-answer reference also shows the **PDF page(s)** the cited passages
came from — `(p. 12)` / `(pp. 3, 12, 19)` — so you can jump there in Preview. (In-text citations
stay page-less. The page is the physical PDF page, which may differ from a journal's printed page.)
Pages appear only for corpora ingested with page-tracking; older stores simply omit them.

---

## Metadata-filtered search

Filter the semantic search by the extracted bibliographic metadata — e.g. *papers about meaning,
but only those authored by Westbury*. Filters available: `--author`, `--year` / `--year-from` /
`--year-to`, `--journal`, `--subject`, `--keyword`, `--affiliation` (list flags are repeatable).

```bash
# rank matching PAPERS (a "find papers" tool, not a synthesized answer)
aprag search "meaning" --author Westbury
aprag search "incongruity humor" --year-from 2015 --subject "Cognitive Psychology"

# scope a synthesized answer or raw chunks to the same filter
aprag ask    "what predicts funniness?" --author Westbury --year-from 2010
aprag chunks "semantic memory" --keyword meaning --journal Cognition
```

`aprag search` returns each paper as an APA7 citation + a clickable local/hades link + a snippet,
ranked by semantic relevance within the filter. The MCP equivalents are the **`aprag_search`** tool
and the same optional filter args on **`aprag_query`** / **`aprag_retrieve`**.

Filtering is resolved against the bibliographic manifest and runs as a parallel Qdrant query
(semantic search restricted to the matching files) — see the implementation notes below.

---

## Step 5 — Register the MCP server with your client

The MCP server uses the **stdio transport** — the client launches `aprag-mcp` as a subprocess.

**Claude Code CLI:**
```bash
claude mcp add --scope user aprag \
    --env APRAG_QUERY_URL=http://100.98.84.84:8001 -- aprag-mcp
```

**Cursor** (`~/.cursor/mcp.json`), **OpenAI Codex CLI** (`~/.codex/config.json`),
**Gemini CLI** (`~/.gemini/settings.json`), or any client taking the standard `mcp.json` shape:
```json
{
  "mcpServers": {
    "aprag": {
      "command": "aprag-mcp",
      "env": { "APRAG_QUERY_URL": "http://100.98.84.84:8001" }
    }
  }
}
```

If `aprag-mcp` is not on the PATH the client uses to launch subprocesses, replace
`"command": "aprag-mcp"` with the absolute path to the console script (e.g.
`/path/to/venv/bin/aprag-mcp`).

**Verify (Claude Code):**
```bash
claude mcp list
# Should show: aprag: aprag-mcp - ✓ Connected
```

The agent then gets two tools: `aprag_query(question, mode)` and
`aprag_retrieve(question, mode, top_k, chunk_top_k)`.

---

## Step 6 — Test it

CLI: `aprag ask "what is humor?"`. MCP: in a session with the tool active, ask the agent a
research question about the corpus — it should invoke `aprag_query` (or `aprag_retrieve` for
raw evidence) and return a substantive answer. If retrieval comes back empty, see below.

---

## Troubleshooting

### Empty results / no answer

The server is reachable but retrieval returned nothing.

1. Check the PC query server is healthy: `curl http://100.98.84.84:8001/health`
2. Test directly (bypassing the CLI/MCP layer):
   ```bash
   curl -X POST http://100.98.84.84:8001/query \
     -H "Content-Type: application/json" -d '{"question":"what is humor?","mode":"hybrid"}'
   curl -X POST http://100.98.84.84:8001/retrieve \
     -H "Content-Type: application/json" -d '{"question":"humor","mode":"naive","chunk_top_k":3}'
   ```
   If these return real data, the issue is the client process (probably a stale instance — below).

### `/retrieve` returns HTTP 501

The PC's installed LightRAG predates `aquery_data`. Upgrade `lightrag_hku` in `C:\rag_server\venv`.
`/query` is unaffected; `/health` reports `lightrag_has_aquery_data`.

### Stale MCP process

If a previous `aprag-mcp` instance is still alive: `pkill -f aprag-mcp`, then retry (the client
restarts it automatically).

### Connection refused / timeout

The PC query server may be down. Bring the stack up from the Mac with
`bash restart_aprag_pc.sh`, or see [PC_RAG_SERVER_STARTUP.md](PC_RAG_SERVER_STARTUP.md). If
`curl …/health` hangs, check Tailscale (`tailscale status`) and that the PC's IP is still
`100.98.84.84`.

---

## Notes for LLM implementation

If an LLM is setting this up autonomously, the precise technical context:

**The client** is the `aprag` package: `aprag.cli` (CLI), `aprag.mcp` (stdio MCP server, tools
`aprag_query` and `aprag_retrieve`), `aprag.client` (the shared async HTTP client — the one place
that knows the wire protocol), and `aprag.references` (client-side local PDF resolution).
Endpoints: `POST /query` → `{"answer", "references", "mode"}` where `references` is a list of
`{n, apa, intext, filename, hades_path, pages}`; `POST /retrieve` → `LightRAG.aquery_data()` output
`{"status","message","data":{entities,relationships,chunks,references},"metadata"}` (chunks:
`{content,file_path,chunk_id,reference_id}`; `naive` mode returns chunks only); `POST /search` →
`{"status","papers":[{filename,apa,hades_path,pages,score,n_chunks,snippet}],"count","matched_files"}`;
`GET /health`. All of `/query`, `/retrieve`, `/search` accept an optional `filters` object
(`{authors[],year,year_from,year_to,journals[],subjects[],keywords[],affiliations[]}`). The server
URL is `$APRAG_QUERY_URL` (default `http://localhost:8001`). After a `/query`, the CLI/MCP call
`aprag.references.localize_answer(...)` to rewrite the `### References` block — cited PDFs found
under `$APRAG_PAPERS_DIR` become clickable `file://` links, the rest keep their hades path.

**Citation rewriting** is done server-side in `query_server.py` via the root module
`apa_citations.py`: `/query` calls `LightRAG.aquery_llm()` (returns the answer **and** the
`reference_id → file_path` map in one call — no LightRAG patch), rewrites numeric `[n]` citations
to APA7 in-text, and rebuilds the references from a filename→bib-record manifest. **Deploy
`apa_citations.py` and `papers_metadata.json` alongside `query_server.py` in `C:\rag_server\`.**
The manifest is built by `scripts/build_apa_manifest.py` (Crossref full records for DOI papers +
LLM extraction otherwise), keyed by the canonical PDF filename. Server env vars: `APA_MANIFEST`
(default: next to `query_server.py`), `HADES_PAPERS_BASE` (default
`hades.psych.ualberta.ca:/Users/Shared/aprag_papers`). A missing manifest entry degrades to a
filename-derived citation; a missing manifest file leaves answers working with bare-filename
citations.

**Reference page numbers** come from a `page_start` the structure-aware chunker now stamps on every
chunk (the physical PDF page, matched from the form-feed-delimited extraction). It is stored in the
text-chunks KV but not surfaced by `aquery_data`, so `query_server.py` reads it back read-only via
`_rag.text_chunks.get_by_ids([chunk_id,...])` and groups distinct pages per reference. **Pages only
appear after a re-ingest** with the page-aware chunker.

**Metadata-filtered search** is a parallel path that does not patch LightRAG: `aprag_search.py`
resolves the `filters` against the manifest → a set of filenames, then `query_server.py` runs a
Qdrant query (`_rag.chunks_vdb._client.query_points`) with a `file_path` match-any payload filter +
the query embedding (`pc_embed(..., context="query")`). `/search` folds the hits into ranked papers;
filtered `/query` synthesizes an APA-cited answer from them; filtered `/retrieve` returns the chunks.
These use semi-private LightRAG attributes read-only — never edit `LightRAG/`; if an upgrade renames
them, fix the server (it 501s if the Qdrant handles are absent).

**hades fallback share:** create `/Users/Shared/aprag_papers` on `hades.psych.ualberta.ca` (user
`exp`) and populate it with the corpus PDFs under their canonical filenames (these must match the
names stored in the RAG so client-side filename matching and the fallback paths line up).

**The query server** (`query_server.py`) runs on the PC at `C:\rag_server\` — FastAPI/uvicorn on
port 8001. It loads LightRAG once at startup from `C:\rag_server\rag_storage_westbury_qwen3_32b\`
(this on-disk dir keeps its legacy name until the next full reingest) using:
- Vector storage: `QdrantVectorDBStorage` (Qdrant at `http://localhost:6333`)
- Embeddings: Octen-Embedding-8B-INT8 at `http://localhost:8000/v1`, dim 4096, no `model_name` set
  (so Qdrant uses legacy collection names `lightrag_vdb_{namespace}`)
- LLM: gpt-5-mini via OpenAI API (answer synthesis, `/query` only)

**Qdrant collections** on the PC (all require `workspace_id: "_"` in the payload):
`lightrag_vdb_entities`, `lightrag_vdb_relationships`, `lightrag_vdb_chunks`.

**Auto-start / restart on the PC:** Windows Task Scheduler tasks `OctenEmbedServer`, `Qdrant`,
and `WestburyQueryServer` (the latter is a legacy task name, kept until the infra is renamed).
`restart_aprag_pc.sh` (run from the Mac) restarts all three in the correct order; details in
[PC_RAG_SERVER_STARTUP.md](PC_RAG_SERVER_STARTUP.md).

**`/retrieve` requirement:** the installed LightRAG must have `aquery_data` (the PC runs 1.4.10,
which does). `/health.lightrag_has_aquery_data` confirms it.
