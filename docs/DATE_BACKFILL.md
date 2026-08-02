# Publication-date backfill

Adds a **publication date** to every record in the APA manifest (`data/papers_metadata.json`)
and keeps it current as papers are added. This is Part 1 of [RESEARCH_DIGEST_PLAN.md](RESEARCH_DIGEST_PLAN.md).

## The fields

| field | example | meaning |
|---|---|---|
| `date` | `2024-03-17` / `2024-03` / `2024` | ISO, truncated to known precision — never zero-padded past what's known |
| `date_precision` | `day` / `month` / `year` | explicit precision |
| `date_source` | see below | which source supplied the date |
| `date_flag` | `date=2021-08-05; filename_year=2022` | set when the date's year disagrees with the canonical filename year (online-first / reprints). The citation `year` is **never** overwritten. |

**Semantics: earliest public appearance** — the earliest of a work's online/print/posted dates
(and preprint v1). That's the axis a recency digest needs. Not the "Received/Accepted" submission date.

## The pipeline (one command)

```bash
scripts/refresh_dates.sh                 # metadata sources only
scripts/refresh_dates.sh --llm           # + gpt-5-mini Batch reads the PDFs
scripts/refresh_dates.sh --llm --deploy  # + push manifest to the PC and restart
```

Run it **after adding papers** (`add_papers.py promote`). Every stage is **idempotent** (only
touches records still lacking a day) and **cached** (only queries DOIs/titles not seen before),
so re-running does just the new work. Caches live in `data/state/.*_cache.json` (gitignored).

Under the hood it runs `backfill_dates.py all`, which chains these stages in priority order —
each fills gaps the previous left. Sources are tried cheapest/most-authoritative first:

1. **records** — build APA records for any corpus PDFs missing from the manifest (Crossref by
   printed DOI, else gpt-5-mini reads the PDF, else arXiv), each dated. (`backfill_records.py`)
2. **dates** — Crossref by DOI: earliest of `published-online / published-print / issued / posted`
   (+ guarded `created`); arXiv v1; else a year-precision fallback from the filename year.
3. **bibmatch** — for no-DOI records, Crossref bibliographic search (title+author) → date + DOI.
4. **pubmed** — `ArticleDate[Electronic]` (epub). **The big win for psych/neuro journals:**
   Crossref often stores only the issue month, but PubMed has the exact electronic-publication
   day, frequently a year earlier (the true earliest appearance).
5. **openalex** — `publication_date`. OpenAlex **pads an unknown day to `-01`**, so we accept a
   day only when it is **not the 1st**.
6. **s2** — Semantic Scholar `publicationDate` (a 4th aggregator; same day≠01 rule, and it can
   lift a year-only record to month).
7. **preprint** — bioRxiv/medRxiv + OSF/PsyArXiv posting day via their APIs. (Note: most `10.1101`
   DOIs in this corpus are CSHL *journals*, not bioRxiv preprints, so this finds few.)

Then, separately (async, optional, `--llm`): **`backfill_dates_llm.py`** submits an OpenAI
**Batch** job (gpt-5-mini) that reads each remaining month/year PDF and extracts the printed
**appearance** date only — "Published/Available online", "First published", "Posted", preprint
stamps — and **hard-rejects Received/Accepted/Submitted** (submission-pipeline dates, often a
year early, that would corrupt the axis). Merge accepts the model's day only when it matches the
known month, or is an earlier online-first date. `submit` → poll `collect`.

## Running a single stage

```bash
python3 scripts/backfill_dates.py <records|dates|bibmatch|pubmed|openalex|s2|preprint|report>
python3 scripts/backfill_dates_llm.py <test|submit|collect>
python3 scripts/backfill_dates.py report        # precision histogram by decade
```

Optional API keys (env): `NCBI_API_KEY` (PubMed 10/s vs 3/s), `S2_API_KEY` (Semantic Scholar quota).

## Coverage and the ceiling

As of the last full run (9,967 records): **~53% day, ~20% month, ~27% year**. Recent papers are
much higher (2010s ~84% day, 2020s articles ~88%). The year-only tail is mostly pre-1990 print,
where an exact day never existed.

**The day genuinely does not exist for everything.** After cross-checking Crossref + PubMed +
OpenAlex + Semantic Scholar + the PDF, ~12% of even 2020s *articles* have no exact publication
day in any free source — many psychology/cognition journals only ever expose month/issue
granularity. Closing that last gap needs paid publisher APIs (Elsevier, APA, Wiley…) or manual
lookup; it is not reachable from open metadata.
