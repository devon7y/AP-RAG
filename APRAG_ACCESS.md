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
`aprag_query` and `aprag_retrieve`), and `aprag.client` (the shared async HTTP client — the one
place that knows the wire protocol). Endpoints: `POST /query` → `{"answer", "mode"}`;
`POST /retrieve` → `LightRAG.aquery_data()` output `{"status","message","data":{entities,
relationships,chunks,references},"metadata"}` (chunks: `{content,file_path,chunk_id,reference_id}`;
`naive` mode returns chunks only); `GET /health`. The server URL is `$APRAG_QUERY_URL` (default
`http://localhost:8001`).

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
