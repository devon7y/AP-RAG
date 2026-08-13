# The single paper database

As AP-RAG grew from a chat site into chat + digest + trends + graph + papers
browser + atlas, each feature accumulated its own snapshot of "what papers exist
and what are they called" — and the snapshots diverged (at one point the atlas
showed 517 papers the Papers browser 404'd on, and the daily author game was
indexing a matrix from a different vintage than its author table). This document
defines the merged architecture: **one database, everything else derived, one
command to propagate.**

## The database

Two files at the repo root, always changed together, guarded by `data/.aprag.lock`:

| File | Contents | Written by |
|---|---|---|
| `data/papers_metadata.json` | filename → full bibliographic record (title, authors, year, `date`/`date_precision`, journal, DOI, abstract, keywords, subjects, affiliations) | `scripts/build_apa_manifest.py`, `scripts/backfill_dates*.py`, `scripts/add_papers.py`, the `academic-pdfs` intake skill |
| `data/drive_links.json` | filename → Google Drive `webViewLink` | `scripts/build_drive_map.py`, `scripts/add_papers.py drive-map`, the intake skill |

Filenames (`Author_Year.pdf`) are the primary key everywhere: the manifest, the
drive map, the RAG store's `file_path`, the PC's PDF folder, the atlas paper
table. Renames are appended to `data/rename_log.jsonl` by the intake skill and
re-applied downstream by `refresh_paper_table.py`.

**Nothing may read a copy.** The former copy points are gone:

- `web/data-pipeline/raw/papers_metadata.json` (hand-copied, no script made it) —
  deleted; `pipeline.py` and `export_metadata.py` now read `data/` directly.
- `data/papers_metadata.repaired.json` (stale unmerged fork) — moved to
  `data/backups/`.
- `web/server-data/chunk_text.json` (175-paper passage relic) — deleted; passage
  prose always comes from the PC `/chunk_text`.

## Who consumes it

| Consumer | How it gets the database |
|---|---|
| PC query server (`query_server.py` — backs chat, digest, trends, graph, papers browser, PDF reader) | `C:\rag_server\papers_metadata.json` + `drive_links.json`, deployed by propagate; **loaded once per process — the restart is part of the deploy** |
| Web atlas + trends static packs (`web/public/data/*`) | derived by `web/data-pipeline/` scripts reading `data/` directly |
| Daily author game (`web/server-data/author_game.json`) | derived by `export_metadata.py`; self-contained (names + cosine matrix + candidate chunk ids), so it cannot drift out of index space with `authors.json` |
| OpenAlex citation layer (`web/public/data/citations.json`) | `scripts/fetch_openalex.py`, keyed on manifest DOIs |
| `aprag` CLI / MCP | HTTP → the PC server |

## Propagation: one command

```bash
scripts/propagate_papers.sh              # everything
scripts/propagate_papers.sh --skip-pc    # derived files only
scripts/propagate_papers.sh --citations  # + OpenAlex refresh
```

It (1) sanity-checks the pair, (2) rebuilds the web's derived metadata
(`refresh_paper_table.py` → `export_metadata.py` → `build_cluster_trends.py`),
(3) deploys both files to the PC and restarts the query server, (4) rsyncs PDFs
to the PC. `scripts/refresh_dates.sh --deploy` also ships both files now.

### What stays batch (and why)

- **RAG ingest** (HPC, GPU): chat retrieval, the knowledge graph, and digest
  content only see ingested papers. The PC scopes `/papers` to
  manifest ∩ ingested, so un-ingested additions never look queryable.
- **Atlas layout** (`web/data-pipeline/hpc_layout.py` on HPC → `pack_full.py`):
  map geometry needs the chunk embeddings. Until the next layout run, new papers
  are in every list/filter/trend but not on the map; `refresh_paper_table.py`
  prints the pending count. The layout job must be fed the canonical
  `data/papers_metadata.json` (ship it with the job payload).
- **Vercel**: the live site serves `web/public/data` from the deployed build —
  commit and push after propagating.

## Rules

1. New feature needs paper metadata? Read the PC API, or derive at build time
   from `data/` — never check in a snapshot that isn't rebuilt by
   `propagate_papers.sh` or the layout chain.
2. Derived artifacts join on `public/data/papers.json` row order.
   `refresh_paper_table.py` updates fields in place and never reorders; anything
   that changes row order is a full layout rebuild.
3. Renaming PDFs outside the intake skill requires appending to
   `data/rename_log.jsonl` (or running `add_papers.py reconcile`) — otherwise
   the rename breaks the primary key everywhere at once.
