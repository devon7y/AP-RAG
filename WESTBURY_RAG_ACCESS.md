# Westbury RAG — Giving Someone Access via Tailscale

This document explains how to give a new user access to the Westbury papers knowledge graph MCP server. It covers what the system is, how it works, and the exact steps to get a new user set up.

---

## What they're getting access to

A Claude Code MCP tool called `query_westbury_papers` that lets Claude search a knowledge graph built from ~1300 papers from the Westbury lab (humor, psycholinguistics, word frequency, entropy, semantic memory, cognitive science). All the heavy computation runs on a dedicated PC — the new user's machine just forwards queries over the network and gets answers back.

**Query modes:**
- `hybrid` (default) — combines entity-focused + broad theme retrieval. Best for most questions.
- `local` — specific entity/paper/concept lookups. Fast.
- `global` — cross-paper trends and themes.
- `naive` — plain vector search, no graph reasoning.

---

## System architecture

```
User's machine
└── Any MCP-compatible client (Claude Code, Cursor, Codex, Gemini CLI, etc.)
    └── mcp_server_westbury.py  (thin HTTP client, ~65 lines)
        └── POST http://<PC_TAILSCALE_IP>:8001/query
            └── PC (Windows, always on)
                ├── query_server.py (FastAPI, port 8001)
                │   ├── LightRAG knowledge graph (59K entities, 73K relationships)
                │   ├── Qdrant vector DB (local, port 6333)
                │   └── Octen-Embedding-8B-INT8 (local, port 8000)
                └── gpt-5-mini via OpenAI API (LLM synthesis)
```

The user's machine runs zero models and holds zero data. It just needs Python, two packages, and Tailscale.

---

## Prerequisites for the new user

- **Tailscale** installed and connected to the shared network
- **Python 3.10+** (any distribution)
- **Claude Code CLI** installed (`npm install -g @anthropic-ai/claude-code` or via brew)
- The PC Tailscale IP: `100.98.84.84` (confirm this is still current before sharing)

---

## Step 1 — Invite them to the Tailscale network

In the Tailscale admin console:

1. Go to **Settings → Users → Invite users**, or share a direct invite link
2. They install Tailscale on their machine and accept the invite
3. Verify they can reach the PC: `ping 100.98.84.84`
4. Verify the query server is reachable:
   ```bash
   curl http://100.98.84.84:8001/health
   # Expected: {"status":"ok","storage":"...","llm":"gpt-5-mini"}
   ```

---

## Step 2 — Give them the MCP client file

Send them `mcp_server_westbury.py` (reproduced in full at the bottom of this document). They can place it anywhere on their machine — a reasonable location is `~/westbury_rag/mcp_server_westbury.py`.

---

## Step 3 — Install dependencies

They need two Python packages: `mcp` (the MCP server framework) and `httpx` (async HTTP client). Install into whichever Python they'll use to run the script:

```bash
pip install mcp httpx
```

Or with uv:

```bash
uv pip install mcp httpx
```

Verify:
```bash
python -c "from mcp.server.fastmcp import FastMCP; import httpx; print('ok')"
```

---

## Step 4 — Register the MCP server with your client

The MCP server uses the **stdio transport** — the client launches it as a subprocess. How you register it depends on your client:

**Claude Code CLI:**
```bash
claude mcp add --scope user lightrag-westbury -- \
    python /path/to/mcp_server_westbury.py
```

**Cursor** — add to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:
```json
{
  "mcpServers": {
    "lightrag-westbury": {
      "command": "python",
      "args": ["/path/to/mcp_server_westbury.py"]
    }
  }
}
```

**OpenAI Codex CLI** — add to `~/.codex/config.json`:
```json
{
  "mcpServers": {
    "lightrag-westbury": {
      "command": "python",
      "args": ["/path/to/mcp_server_westbury.py"]
    }
  }
}
```

**Gemini CLI** — add to `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "lightrag-westbury": {
      "command": "python",
      "args": ["/path/to/mcp_server_westbury.py"]
    }
  }
}
```

**Generic MCP config** (any client supporting the standard `mcp.json` format):
```json
{
  "mcpServers": {
    "lightrag-westbury": {
      "command": "python",
      "args": ["/path/to/mcp_server_westbury.py"]
    }
  }
}
```

To override the query server URL without editing the file, add an `env` block:
```json
{
  "mcpServers": {
    "lightrag-westbury": {
      "command": "python",
      "args": ["/path/to/mcp_server_westbury.py"],
      "env": {
        "WESTBURY_QUERY_URL": "http://100.98.84.84:8001"
      }
    }
  }
}
```

**Verify (Claude Code):**
```bash
claude mcp list
# Should show: lightrag-westbury: python /path/to/mcp_server_westbury.py - ✓ Connected
```

---

## Step 5 — Test it

In any session with the MCP tool active:

```
Query the Westbury papers: what research has been done on humor and incongruity?
```

The LLM should invoke `query_westbury_papers` and return a substantive answer. If it returns `[no-context]`, see troubleshooting below.

---

## Troubleshooting

### `[no-context]` response

The server is reachable but the query returned no results from the knowledge graph.

1. Check the PC query server is healthy:
   ```bash
   curl http://100.98.84.84:8001/health
   ```
2. Test the query directly (bypassing the MCP layer):
   ```bash
   curl -X POST http://100.98.84.84:8001/query \
     -H "Content-Type: application/json" \
     -d '{"question":"what is humor?","mode":"hybrid"}'
   ```
   If this returns a real answer, the issue is the MCP process (probably a stale old instance — see below).

### Stale MCP process

If the MCP server was previously running an old version of the script, it may still be alive. Kill it:
```bash
pkill -f "mcp_server_westbury"
```
Then retry — Claude Code will restart it automatically.

### Connection refused / timeout

The PC query server may not be running. It should auto-start on login via Windows Task Scheduler (`WestburyQueryServer` task). To start it manually:
- SSH to the PC and run: `C:\rag_server\start_query_server.bat`
- Or via Task Scheduler: right-click `WestburyQueryServer` → Run

### Tailscale not connected

If `curl http://100.98.84.84:8001/health` hangs or times out:
- Check Tailscale is running on their machine (`tailscale status`)
- Check the PC is online in the Tailscale admin console
- Confirm the PC's Tailscale IP is still `100.98.84.84` (it can change if the machine is re-enrolled)

---

## Notes for LLM implementation

If an LLM is setting this up autonomously on behalf of a user, here is the precise technical context:

**The MCP client script** (`mcp_server_westbury.py`) is a stdio MCP server using `FastMCP`. It exposes one tool: `query_westbury_papers(question: str, mode: str = "hybrid") -> str`. It makes an async POST to `{QUERY_SERVER_URL}/query` with JSON body `{"question": ..., "mode": ...}` and returns `response["answer"]`. The URL defaults to `http://100.98.84.84:8001` but can be overridden via the `WESTBURY_QUERY_URL` environment variable.

**The query server** (`query_server.py`) runs on the PC at `C:\rag_server\`. It is a FastAPI app using uvicorn on port 8001. It loads LightRAG once at startup from `C:\rag_server\rag_storage_westbury_qwen3_32b\` using:
- Vector storage: `QdrantVectorDBStorage` (Qdrant at `http://localhost:6333`)
- Embeddings: Octen-Embedding-8B-INT8 at `http://localhost:8000/v1` (OpenAI-compatible endpoint), dim=4096, no `model_name` set (so Qdrant uses legacy collection names `lightrag_vdb_{namespace}`)
- LLM: gpt-5-mini via OpenAI API

**Qdrant collections** on the PC (all require `workspace_id: "_"` in payload for LightRAG to find them):
- `lightrag_vdb_entities` — 59,786 points
- `lightrag_vdb_relationships` — 73,074 points
- `lightrag_vdb_chunks` — 3,621 points

**Auto-start** on the PC: both Qdrant and the query server are registered as Windows Task Scheduler tasks that trigger at user logon (`Qdrant` and `WestburyQueryServer` tasks). Startup scripts are at `C:\rag_server\start_qdrant.bat` and `C:\rag_server\start_query_server.bat`.

**Python environment on PC**: `C:\rag_server\venv\` with LightRAG installed from custom source at `C:\rag_server\LightRAG\` (not PyPI — use this version).

---

## The MCP client file (full source)

```python
#!/usr/bin/env python3
"""
MCP server for the Westbury Papers LightRAG knowledge graph.

Thin HTTP client that forwards queries to the PC query server
(running LightRAG + Qdrant + Octen embeddings + gpt-5-mini).

Registration:
    claude mcp add --scope user lightrag-westbury -- \
        python /path/to/mcp_server_westbury.py
"""

import os
import sys

import logging
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

import httpx
from mcp.server.fastmcp import FastMCP

QUERY_SERVER_URL = os.environ.get(
    "WESTBURY_QUERY_URL", "http://100.98.84.84:8001"
)

mcp = FastMCP("lightrag-westbury")


@mcp.tool()
async def query_westbury_papers(question: str, mode: str = "hybrid") -> str:
    """
    Search the Westbury papers knowledge graph to answer research questions.

    This database covers papers from the Westbury lab and related researchers,
    spanning topics such as humor, psycholinguistics, word frequency, entropy,
    semantic memory, and cognitive science broadly.

    Use this tool whenever the user asks about:
    - Research findings from Westbury or collaborators
    - Humor, incongruity, or entropy in language
    - Psycholinguistic norms and word properties
    - Semantic foraging and memory search
    - Specific papers, authors, or concepts in this corpus

    Args:
        question: The research question to answer from the papers.
        mode: Retrieval strategy:
              - "hybrid" (default): combines entity-focused + theme-focused retrieval
              - "local": best for specific entity/paper questions
              - "global": best for broad cross-paper themes and trends
              - "naive": simple vector search, fastest but no graph reasoning
    """
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{QUERY_SERVER_URL}/query",
                json={"question": question, "mode": mode},
            )
            resp.raise_for_status()
            return resp.json()["answer"]
    except httpx.HTTPStatusError as exc:
        print(f"ERROR: Query server returned {exc.response.status_code}", file=sys.stderr)
        return f"Query failed: server returned {exc.response.status_code}"
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return f"Query failed: {exc}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
```
