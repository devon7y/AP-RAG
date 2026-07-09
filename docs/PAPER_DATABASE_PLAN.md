# Paper Database — feature plan

A browsable, sortable, filterable table of every paper in the corpus, opened from a
**Paper Database** button in the web sidebar (directly under **Research Digest**), plus a
universal search bar that finds papers even when the user only half-remembers the details.

---

## 0. Key discovery: title is already stored

The APA manifest (`data/papers_metadata.json`, 9,967 records) **already carries `title`**
— 9,958 of 9,967 records have one (99.9%). No new recovery pipeline is needed; only a tiny
backfill for the 9 stragglers (see §6). Full field inventory, with fill counts:

| Field | Filled | Notes |
|---|---|---|
| `title` | 9,958 | already there — the user-visible headline column |
| `authors` | 9,938 | list of `{family, given}` |
| `year` | 9,967 | canonical (filename-derived) year |
| `date` / `date_precision` / `date_source` | 9,967 | earliest-appearance date from the date backfill |
| `container_title` | 9,041 | journal / book title |
| `volume` / `issue` / `pages` | 8,018 / 4,581 / 7,992 | |
| `publisher` | 2,099 | |
| `doi` | 7,318 | linkable |
| `keywords` / `subjects` / `affiliations` | ~8,400 / 8,418 / 8,038 | already power `/facets` + filters |
| `abstract` | 7,563 | large — excluded from the table payload, shown in the row detail |
| `type` | 9,967 | article / book / chapter / … |
| `source` | 9,967 | crossref vs LLM-extracted (provenance badge) |
| `editors`, `disambig`, `date_flag`, `year_flag` | sparse | detail view only |

Payload reality check: the manifest is **19 MB** on disk (9.3 MB without abstracts) — far
too big to ship to the browser. The table must be **server-paginated**; abstracts load
per-row on demand.

---

## 1. Backend — new `GET /papers` endpoint on `query_server.py` (PC)

One new read-only endpoint next to `/search` and `/facets`, reusing the existing
`aprag_search` filter machinery (`record_matches`, `Filters`) — no LightRAG patch, no new
state.

```
GET /papers?offset=0&limit=50
            &sort=year|date|title|first_author|journal   &order=asc|desc
            &q=<quick text match>
            &authors=…&year_from=…&year_to=…&journals=…&subjects=…&keywords=…&affiliations=…
            &types=article,book
```

Response:

```json
{
  "papers": [ { "filename", "title", "authors", "year", "date", "date_precision",
                "container_title", "volume", "issue", "pages", "doi", "type",
                "publisher", "keywords", "subjects", "source",
                "apa", "drive_url" } ],
  "total": 9967,        // after filters — drives the pagination footer
  "offset": 0, "limit": 50
}
```

Implementation notes:

- **Slim rows**: `abstract`, `affiliations`, `editors`, flags are omitted from list rows.
  A companion `GET /papers/{filename}` returns the full record (abstract, affiliations,
  flags, `hades_path`) for the detail drawer.
- **`q` (quick match)**: case-insensitive substring match over title + author family names
  + journal + DOI + filename. This is the *instant* tier of the universal search (§4);
  it runs in-process over the manifest (a 10k-record linear scan is sub-millisecond).
- **Sorting**: `first_author` sorts on `authors[0].family`; `date` sorts on the ISO date
  string (already lexicographically ordered); missing values sort last.
- **Filters**: reuse the existing `Filters` model + `aprag_search.record_matches` verbatim
  so the table's filters behave identically to the chat filters. Add one new dimension:
  `types` (article/book/chapter…), a trivial extension to `record_matches`.
- **APA string**: reuse `apa_citations`' formatter so the table can show/copy a
  ready-made APA7 reference per row.
- Key-gated like every other endpoint (`Depends(require_api_key)`).
- Manifest is loaded once and cached in-process (mtime-checked reload, same pattern the
  server already uses), so pagination doesn't re-read 19 MB per request.

Semantic search needs **no new backend** — `POST /search` (Qdrant chunk search folded into
ranked papers, filter-aware) already exists and returns ranked papers with APA + pages.

**Deployment**: `query_server.py` + `aprag_search.py` changes must be redeployed to the PC
(`C:\rag_server`) and the query server restarted.

## 2. Next.js proxy routes (server-side, key never reaches browser)

Mirroring `api/facets` / `api/stats`:

- `web/app/(chat)/api/papers/route.ts` — proxies `GET /papers` (and `/papers/{filename}`
  via a `filename` param), forwarding pagination/sort/filter params.
- `web/app/(chat)/api/papers/search/route.ts` — proxies `POST /search` for the semantic
  tier of the universal search.
- Client helpers added to `web/lib/aprag/client.ts` (`listPapers`, `getPaper`,
  `searchPapers`) with the standard header/timeout/error handling.

## 3. Frontend — `/papers` page + sidebar button

**Entry point**: a `SidebarMenuButton` in `app-sidebar.tsx` directly under Research Digest
(above Papers Atlas), icon `LibraryIcon`/`TableIcon`, tooltip "Paper Database — browse,
sort, and filter every paper in the corpus". It navigates to a **full page** at
`web/app/(chat)/papers/page.tsx` — a dialog can't do a 10k-row table justice, and a page
gives us shareable URLs.

**The table** (new `web/components/papers/` directory):

- Built with **TanStack Table** (`@tanstack/react-table`, new dep) in fully
  server-side mode (manual pagination + sorting), styled with the existing shadcn
  primitives. Columns:
  - **Title** (primary, wide, click → detail drawer)
  - **Authors** (compact: "Westbury & Hollis" / "Smith et al." — full list on hover)
  - **Year** and **Date** (date shown at its stored precision, with a small
    day/month/year precision badge — reuse the digest's date conventions)
  - **Journal** (`container_title`), **Vol/Issue/Pages** (merged compact column)
  - **Type**, **DOI** (external link icon), **Publisher**
  - **Keywords** / **Subjects** (chip overflow, click a chip → adds it as a filter)
  - **Source** (crossref / llm provenance badge)
  - Column visibility menu (sane defaults: title, authors, year, journal, DOI visible;
    the rest opt-in) — persisted to `localStorage`.
- **Pagination**: classic footer (50/100/200 per page) backed by `total`. Virtualized
  infinite scroll is a possible later upgrade, not needed at 10k rows with server paging.
- **Filter bar**: reuse the chat's existing facet machinery (`facet-input.tsx`,
  `active-filters.tsx`, `/api/facets`) so filter chips look and behave exactly like the
  chat filters: authors, year range, journals, subjects, keywords, affiliations, + type.
- **URL state**: filters/sort/page/search serialize into `searchParams`
  (`/papers?authors=Westbury&year_from=2015&sort=date&order=desc`) — shareable and
  back-button-friendly.

**Row detail drawer** (Sheet, opens on row click):

- Full APA7 reference with a copy button, full author + affiliation list, abstract,
  all keywords/subjects, DOI link, **Open in Drive** (`drive_url`), date provenance
  (`date_source`, flags).
- **"Ask about this paper"** — jumps to a new chat with the chat's paper filter pre-set
  to this paper (wire through the existing `RagFilters` chips), connecting the database
  directly to the RAG.

**Export**: toolbar buttons to download the *current filtered set* as **CSV** and
**BibTeX** (client-side generation from fetched pages; capped with a "fetching N rows"
progress state). Cheap to build, very lab-useful.

## 4. Universal search bar

One prominent search box above the table with **two tiers, merged in one UX**:

1. **Instant tier (as you type, debounced ~250 ms)** — the `q` param of `GET /papers`:
   substring match on title/authors/journal/DOI/filename. The table body simply filters.
   Zero extra infra, feels like a spreadsheet quick-filter.
2. **Semantic tier ("Deep search", Enter or explicit button)** — `POST /search`: the
   query is embedded (Qwen3-Embedding on the PC), matched against chunk vectors in
   Qdrant, and folded into **ranked papers**, honoring any active metadata filter chips.
   Results replace the table body as a ranked list (relevance score column appears,
   sorting locks to relevance), each row expandable to show the **matching chunk
   snippets + PDF pages** — "why did this paper match?". A clear ✕ returns to browse
   mode. This is the "I don't remember the exact title, it was something about humor
   and entropy" path.

Optional tier 3 (later): **natural-language filter parsing** — reuse the chat's existing
LLM filter-extraction (`web/lib/aprag/filters.ts` second-pass machinery) so typing
"Westbury papers after 2015 about word frequency" auto-populates filter chips + a semantic
query. Deferred; tiers 1–2 already cover the stated need without an LLM call per
keystroke.

## 5. Health/offline behavior

The page depends on the PC being up. Reuse the header's existing `/api/health` signal:
when offline, show the standard degraded banner and disable search (the table itself
could later be served from a build-time slim snapshot, but that's out of scope).

## 6. Metadata recovery — DROPPED (user decision, 2026-07-09)

The 9 title-less records (`Brosnan_DeWaal_2003`, `Conrad_1962`, …) are left as-is: the
user asked that paper titles not be updated and the papers not be read. The table shows
the filename for a record with no title. (Context, should this ever be revisited: a
Crossref-only backfill is unsafe here — several of these records carry corrupt
LLM-extracted DOIs/authors, so surname+year bibliographic search matches unrelated
works.) `date` is 100% filled already; PDFs absent from the manifest entirely remain
covered by `backfill_dates.py records`.

## 7. Build order

| Phase | Deliverable | Touches |
|---|---|---|
| **1. Backend** | `GET /papers` + `GET /papers/{filename}` (+ `types` filter), deployed to PC | `query_server.py`, `aprag_search.py` |
| **2. Table MVP** | Sidebar button, `/papers` page, server-paginated sortable table, facet filter bar, URL state, instant `q` search | `app-sidebar.tsx`, `web/app/(chat)/papers/`, `web/components/papers/`, `web/app/(chat)/api/papers/`, `client.ts` |
| **3. Semantic search** | Deep-search mode over `/search` with score + snippet expansion | `api/papers/search`, table search component |
| **4. Detail + polish** | Row drawer, "Ask about this paper" chat handoff, CSV/BibTeX export, column persistence | `web/components/papers/` |
| ~~5. Backfill~~ | dropped — titles stay as they are (user decision; see §6) | — |
| *(later)* | NL filter parsing (tier 3), build-time offline snapshot, virtual scroll | — |

Phases 1–2 are the MVP; 3 delivers the "universal search" promise; each phase ships
independently.
