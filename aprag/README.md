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

Precedence: `--server URL` > `--local` > `$APRAG_QUERY_URL` > **config file** > `http://localhost:8001`.

The most robust option is the config file — it's read at runtime, so it works in every
shell with no env var or re-sourcing:

```bash
aprag config set-server http://<host>:8001   # persists to ~/.config/aprag/config
aprag config show                            # show the resolved server + every source
```

Or use the env var / a per-call flag:

```bash
export APRAG_QUERY_URL=http://<host>:8001     # e.g. the always-on PC over Tailscale
aprag ask "…" --server http://<host>:8001     # one-off override
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

- `aprag_query(question, mode="hybrid", reasoning="none", …)` → synthesized, APA-cited answer.
- `aprag_search(question, …)` → ranked papers for a topic (not an answer).
- `aprag_retrieve(question, mode="naive", top_k?, chunk_top_k?, …)` → raw chunks
  (+ entities/relationships in graph modes). Stateless — the agent accumulates and
  dedupes evidence across hops.
- `aprag_corpus(facet, q?, limit?)` → the values the metadata filters actually accept
  (authors/journals/subjects/keywords/affiliations/types), plus `stats` and `health`.
  Call this before filtering rather than guessing at spellings.
- `aprag_papers(filename? | q?, …)` → browse the manifest as a table, or one paper's
  full record. A pure metadata read, so it still answers when Qdrant is down.
- `aprag_similar(filename, top_k?)` → the papers nearest a given paper.
- `aprag_locate(filename, quote, hint_page?)` → which PDF page a quoted passage sits
  on; `page=null` means the passage could not be confirmed in that paper.
- `aprag_graph(action, …)` → knowledge-graph entities and their connections; how you
  follow up an entity that `aprag_retrieve` surfaced.
- `aprag_trends(dim?, term?, limit?)` → corpus-wide publication trends.

The first five accept the metadata filters (`papers`, `authors`, `year`/`year_from`/
`year_to`, `date_from`/`date_to`, `journals`, `subjects`, `keywords`, `affiliations`,
`types`). A filter value that matches no paper is rejected with "did you mean"
suggestions instead of returning an empty result that reads like an empty corpus, and
every failure is raised as a real MCP error rather than returned as prose.

If `aprag-mcp` is not on the PATH the client uses, register with the absolute path to
the console script (e.g. `/path/to/venv/bin/aprag-mcp`).
