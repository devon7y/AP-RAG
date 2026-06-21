# aprag

A small client for the **AP-RAG** academic-papers knowledge base. It gives you two
ways in, both thin HTTP clients over the AP-RAG query server (no models or data run
locally):

- **`aprag`** — a CLI for humans and scripts.
- **`aprag-mcp`** — an MCP server so an agent (Claude Code, Claude Desktop, …) can query.

Both expose the same two capabilities:

- a **synthesized answer** (an LLM writes a cited answer over retrieved context), and
- **raw retrieval** (the underlying chunks/entities/relationships, no LLM) — the
  primitive for agentic multi-hop retrieval.

## Install

```bash
pip install -e .        # from the repo root (dev)
# or:  pip install .    # for others
```

This puts `aprag` and `aprag-mcp` on your PATH (in the active environment).

## Point it at a server

Precedence: `--server URL` > `--local` > `$APRAG_QUERY_URL` > `http://localhost:8001`.

```bash
export APRAG_QUERY_URL=http://<host>:8001    # e.g. the always-on PC over Tailscale
```

## CLI

```bash
aprag ask "What does the corpus say about humor and incongruity?" --mode hybrid
aprag chunks "humor incongruity entropy" --mode naive --chunk-top-k 5
aprag chunks "surprisal" --mode local --entities      # also show graph entities/relations
aprag chunks "humor" --json | jq '.data.chunks | length'
aprag health
```

Modes: `local`, `global`, `hybrid`, `mix`, `naive`. `ask` defaults to `hybrid`;
`chunks` defaults to `naive`.

## MCP

```bash
claude mcp add --scope user aprag \
    --env APRAG_QUERY_URL=http://<host>:8001 -- aprag-mcp
```

Tools the agent gets:

- `aprag_query(question, mode="hybrid")` → synthesized answer.
- `aprag_retrieve(question, mode="naive", top_k?, chunk_top_k?)` → raw chunks
  (+ entities/relationships in graph modes). Stateless — the agent accumulates and
  dedupes evidence across hops.

If `aprag-mcp` is not on the PATH the client uses, register with the absolute path to
the console script (e.g. `/path/to/venv/bin/aprag-mcp`).
