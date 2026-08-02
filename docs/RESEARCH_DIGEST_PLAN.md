# Research Digest — implementation plan

Two deliverables, in dependency order:

1. **Publication dates at month precision** (day where it comes free) in the metadata layer.
2. **"Research Digest"** — a new chat tool in the web app (sidebar: below *Talk to Author*, above *Papers Atlas*): give it a topic + a time window, it writes a chronologically sectioned summary of the corpus's research in that window, then the chat continues as a normal session.

Corpus sizing facts behind this plan (from `data/papers_metadata.json`, 9,655 records):

- Sources: 8,243 `llm`, 1,393 `crossref`, 18 `web`, 1 `manual`
- Of the 8,243 LLM records, **3,123 already carry a DOI** (extracted off the page) → ~4,516 records total are direct-DOI-fetchable
- **5,120 records have no DOI** → need bibliographic matching
- Types: 8,890 article, 290 preprint, 214 chapter, 146 book, 58 report, 46 thesis. The preprint count is almost certainly an undercount (LLM often types arXiv preprints as `article`), so preprint detection must sweep PDFs, not trust `type`.

---

## Part 1 — Date backfill

### Schema

Add to each manifest record:

- `date` — ISO string truncated to known precision: `"2026-03-17"` | `"2026-03"` | `"2026"`. Precision is implicit in string length. Never pad.
- `date_source` — `"arxiv_stamp" | "preprint_stamp" | "crossref" | "openalex" | "llm"`.
- `date_flag` — set instead of `date` when a candidate date's year contradicts the canonical (filename) year; reviewed manually, mirrors `year_flag`.

**Semantics: earliest public appearance** — min of Crossref `published-online` / `published-print` / `issued` / `posted` (preprints) and any preprint stamp. That is the axis the digest cares about ("when did this work appear"). Note the existing `_cr_year` key list in [scripts/build_apa_manifest.py:111-116](../scripts/build_apa_manifest.py#L111-L116) lacks `posted` — the new date extractor must include it.

### Acquisition waterfall — new `scripts/backfill_dates.py`

Resumable subcommand script (state file + per-stage caches, same pattern as `build_apa_manifest.py`). Stages run in order; each only touches records still lacking `date`.

**A. `doi` — direct Crossref fetch (~4,516 records).**
`GET api.crossref.org/works/{doi}` for every record with a DOI; keep full `date-parts` (`[Y,M,D]`, `[Y,M]`, or `[Y]`) from the earliest of the keys above. The builder's existing crossref cache stores *mapped records* (year already truncated), so this is a re-fetch — polite pool at ~1–2 req/s ≈ under 2 hours, run once.

**B. `stamp` — preprint stamp sweep (all PDFs, page 1 only).**
This is the vertical-left-margin date the user described. Extract page-1 text (pdftotext / PyMuPDF, per the `audit_ocr.py` precedent — not pypdf) and regex:

- arXiv stamp: `arXiv:YYMM.NNNNN(vN) [cat] DD Mon YYYY` → **day precision**. Fallback: the arXiv ID alone encodes `YYMM` → month precision.
- bioRxiv/medRxiv: `this version posted <Month> <D>, <YYYY>` footer → day precision.
- PsyArXiv/OSF: no stamp; their DOIs (`10.31234/…`) resolve via stage A with the `posted` key.

Sweep **every** PDF regardless of manifest `type` (the 290 typed-preprint count is unreliable). Scanned preprints whose stamp is image-only fall through to stage D's vision path. Bonus: any stamp hit on a record typed `article` can also fix `type → preprint`.

**B2. `arxiv` — arXiv API lookup for every ID found in B.**
The stamp on a v2+ PDF shows the *revision* date, not first appearance. Batch the collected arXiv IDs against the export API (`id_list`, ~100 per request, free, no auth) and take `<published>` — the authoritative **v1 submission day**. Also fixes `type → preprint`. ~30 lines; strictly better than trusting the stamp date.

**C. `match` — bibliographic matching (~5,120 no-DOI records).**
These fell to the LLM path originally only because no DOI was *printed* — most journal articles are still in Crossref. Match using the metadata we already extracted: Crossref `works?query.bibliographic=<title>&query.author=<surname>` (optionally windowed with `from-pub-date`/`until-pub-date` around the known year), and/or OpenAlex title search. Accept a hit only when normalized-title similarity is high **and** first-author surname **and** year all agree. Take Crossref `date-parts` for precision; treat OpenAlex `publication_date` as **year precision unless Crossref confirms the month** (OpenAlex pads unknown month/day to `-01-01`). Side benefit: backfills `doi` for ~5k records.

**D. `llm` — batch mop-up (residue only; optional).**
Reuse the existing OpenAI Batch machinery (`submit`/`status`/`collect` in `build_apa_manifest.py`, gpt-5-mini, first-2-pages text or JPEGs) with a **date-only schema**: printed cover/issue month, Received/Accepted/Published lines, and any preprint stamp (the vision path reads vertical stamps in scans that stage B's text extraction missed). Expected yield is modest — books and old scans rarely print more than a year — so run it last, on the residue, and only if coverage from A–C disappoints.

**`apply` + `report`.**
`apply` merges candidates into `data/papers_metadata.json` with the year-consistency guard (candidate year ≠ canonical year → `date_flag`, no `date`). `report` prints a coverage histogram (records at day/month/year precision, by type) — the go/no-go input for stage D.

### Downstream refresh after backfill

- Redeploy `papers_metadata.json` to the PC (next to `query_server.py`, `APA_MANIFEST`).
- Re-run the web metadata export (`export_metadata.py` + `pack_atlas.py`) so `web/public/data/papers.json` carries `date` — the digest UI and (later, optionally) the Atlas time machine can use it.

### Expected coverage

Journal articles + preprints (the digest's target population, ~95% of the corpus) should land at month precision for the large majority, day precision for arXiv-stamped preprints and modern Crossref records. Books/chapters/theses stay year-only — the digest handles that gracefully (below).

### Day precision (target: an exact day wherever one exists)

Costs almost nothing extra in code — stages A/B/B2 already return full `Y-M-D` where the source has it, and the truncated-ISO schema stores it untruncated. What day precision actually adds:

- **Guarded fallback — Crossref `created`.** The DOI-deposit timestamp always carries a full day. For born-digital papers it lands within days of online publication; for retro-digitized print papers it is wildly wrong (a 1975 paper's DOI may be created in 2005). Rule: use it only when its year equals the canonical record year, tagged `date_source: "crossref_created"` (auditable, lower confidence). Mainly rescues 2000s papers lacking a `published-online` day.
- **Not used: printed Received/Accepted dates.** Day-precise and common on journal pages, but they are submission-pipeline dates, not publication dates. Conflating them would corrupt "which came first" answers. (Could be stored separately later as a priority signal — out of scope.)
- **Coverage ceiling by era** (corpus: 13% pre-1990, 16% 1990s, 34% 2000s, 26% 2010s, 11% 2020+):
  - **2020+** — near-complete day coverage (arXiv v1 days + modern Crossref online dates). This is where new additions concentrate, i.e. the digest's hot zone.
  - **2010s** — high (online-first era).
  - **2000s** — partial; `created` fallback helps.
  - **Pre-2000 print era (~29%)** — a day mostly *does not exist as a fact*: an issue is "May 1994" (or "Spring 1994"). Month/year is the ceiling regardless of method; no LLM pass can recover what was never assigned.
- **Digest/chat rule for mixed precision:** assert ordering between two works only when both dates' precision supports the claim (or the gap exceeds the coarser precision); otherwise say so — "both March 2026, exact days unknown."

---

## Part 2 — Server changes (PC: `query_server.py` + `aprag_search.py`)

Small and patch-free — date filters ride the existing filtered-search path (`resolve_filter` → filename set → Qdrant `file_path` match-any).

1. **`aprag_search.py`** — add `date_from` / `date_to` (accept `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`) to `FILTER_KEYS` ([aprag_search.py:27](../aprag_search.py#L27)) and `record_matches` ([aprag_search.py:55](../aprag_search.py#L55)). **Precision-aware interval overlap**: expand a record's `date` (or bare `year` when no `date`) to the interval it denotes (`"2026-03"` → `[2026-03-01, 2026-03-31]`; `"2026"` → the whole year) and match if it intersects `[date_from, date_to]`. Year-only records therefore still appear in month-window queries covering their year — the digest prompt marks them as date-imprecise rather than silently dropping them.
2. **`query_server.py`** — extend the `Filters` model ([query_server.py:194](../query_server.py#L194)) and `_filters_dict`; add each reference's `date` in `_enrich_references` ([query_server.py:574](../query_server.py#L574)) and to `/retrieve` chunk/reference payloads; optionally add a per-month histogram to `_compute_facets` for UI range hints.
3. **`aprag/` CLI + MCP** — pass `date_from`/`date_to` through in `aprag/client.py`, `cli.py`, `mcp.py` (parity, ~30 lines).
4. **Tests** — `tests/test_date_filters.py` for the precision-overlap logic (pure functions, runs locally like the chunker tests).
5. **Deploy** — rsync to `pc` `C:\rag_server` + `restart_aprag_pc.sh`.

---

## Part 3 — Web app: the Research Digest tool

Mirrors the *Talk to Author* template exactly (sidebar launcher → `?param` on a fresh chat → captured in `use-active-chat` → sent with first message → persisted on the Chat row → special branch in the chat API route). Citation plumbing is untouched as long as the digest keeps the global `[n]` cite-index contract.

### UI

1. **Sidebar entry** — insert a `<SidebarMenuItem>` between *Talk to Author* (lines 123–135) and *Papers Atlas* (136–147) in [web/components/chat/app-sidebar.tsx](../web/components/chat/app-sidebar.tsx). Name: **Research Digest** (placeholder — rename freely). Opens a dialog.
2. **`digest-dialog.tsx`** (new, mirrors `talk-to-author-dialog.tsx`) — one natural-language box ("Summarize research on LLM agents in autonomous research from the past 3 months") plus optional quick-range presets (3 mo / 6 mo / 12 mo / 3 yr / custom). Explicit presets fill `from`/`to`; otherwise the server infers the range from the text. Submit → `router.push('/chat/<uuid>?digest=<encoded {topic, from?, to?}>')`.
3. **Param plumbing** — `hooks/use-active-chat.tsx`: capture `?digest=` exactly like `?author=` (lines 289–305 pattern), send on first message only (lines 212–214 pattern), restore on reload via `/api/messages`.
4. **Chat row** — new `digest` jsonb column `{topic, from, to, bucket}` + Drizzle migration (mirror of the `personaAuthor` migration). Title prefixed `"(Digest) …"`.
5. **Indicators** — header pill à la `persona-indicator.tsx` showing `Digest · <topic> · Jan–Jun 2026`; greeting variant in `greeting.tsx`.
6. **Dates in citation UI** — show `ref.date` (formatted "Mar 2026") in `citation-popover.tsx` and `rag-references.tsx` when present. Add `date` to `RagReference` in `lib/aprag/types.ts`.

### First-message digest branch in `app/(chat)/api/chat/route.ts`

1. **Range + bucket inference** (only when the dialog didn't set them): a small extraction call in the style of `condense.ts`, anchored to today's date, resolving relative ranges ("past 3 months" → concrete `from`/`to`).
2. **Bucketize**: months when the span ≤ 18 months, else years; final bucket always ends at "now"; cap ~24 buckets (auto-coarsen month→quarter→year if exceeded).
3. **Per-bucket retrieval**: one `/retrieve` per bucket with the topic as the question and `filters: {date_from, date_to}` for that bucket (concurrency ~4, per-bucket `top_k` ~8–10, scaled down as bucket count grows to keep total context ≤ ~50–60k tokens). A paper has exactly one date, so buckets can't duplicate papers. Empty buckets are skipped but reported to the prompt as quiet periods, not errors.
4. **`lib/aprag/digest.ts`** (new, mirrors `persona.ts`): `buildDigestContext` — passages grouped by bucket, each prefixed with its paper's date at stored precision, `[n]` cite-indices running globally across buckets; `buildDigestSystemPrompt` — write chronological `###` sections (oldest → newest), name threads/trends/turning points across sections, state dates explicitly, mark year-only papers as date-imprecise instead of inventing months, close with a trajectory paragraph; cite only provided passages.
5. **Stream + persist**: merge all buckets' references/chunks into one `RagRetrieval` payload for the `data-retrieval` stream part — popovers, reference list, and reload behavior work unchanged.

### Follow-up turns

Regular flow (condense → retrieve → synthesize with full history replayed), with the digest's date range applied as **sticky, dismissible filter chips** (existing `active-filters.tsx` UI): follow-ups default to the window the chat is about, and the user clears the chips to step outside it. Because reference/context dates are now present, fine-grained questions like "which agent system came first?" work at whatever precision the dates have — and the model can honestly say "both March 2026, exact days unknown."

---

## Decisions taken (defaults — change if wrong)

| Decision | Default | Rationale |
| --- | --- | --- |
| Date semantics | Earliest public appearance (online/print/posted/stamp min) | Matches "recent research" intent |
| Storage format | Truncated ISO string, precision implicit | No fake precision; sortable |
| Year conflicts | Filename year stays canonical; conflicting dates → `date_flag` | Consistent with existing `year_flag` design |
| Bucket rule | Months ≤ 18-month span, else years; ≤ 24 buckets | Sections stay readable |
| Follow-up filters | Sticky date chips, user-dismissible | Chat is "about" the window |
| Tool name | "Research Digest" | Placeholder |
| LLM mop-up (stage D) | Deferred until A–C coverage is measured | Low expected yield |
| arXiv date | v1 `<published>` from the API, not the stamp's revision date | "Which came first" wants first appearance |
| Day-precision fallback | Crossref `created`, only when its year matches the record; tagged | Adds days for 2000s papers; guarded against retro-digitization noise |
| Received/Accepted dates | Not used as `date` | Pipeline dates, not publication dates |
| Preprint→journal lineage | Out of scope v1 — date the version in hand | OpenAlex version graph could upgrade later |

## Order of work

1. **Backfill script + run** (stages A–C): one focused session to write, runs complete overnight. Nothing else can show months without it.
2. **Server + clients** (Part 2): small; includes PC redeploy. Can be same session as 1.
3. **Web digest tool** (Part 3): the bulk — roughly one session for plumbing (sidebar/dialog/param/migration/route branch), one for the digest context/prompt + polish. Rollout per the usual loop: implement → `tsc` → deploy → user tests live.
4. **Optional afterward**: stage D mop-up, month-granular Atlas time machine, `aprag` CLI digest command.

Phase 3 degrades gracefully if started early (year buckets only), but the month axis — the point of the feature — needs Phase 1 done first.
