# PDF reader: passage location — state, findings, and open work

Handoff for whoever picks this up next. Written 2026-08-04, after investigating a user
report that some papers show **"Page 1 of 22 · passage not found in the text layer"** in
the in-app PDF reader.

Everything described as shipped is committed to `main`, deployed to Vercel, and running
on the PC. The two open items at the end are **not** started.

---

## 1. What the feature does

Clicking a citation in chat opens the paper beside the answer, scrolled to the cited
passage with it highlighted.

The corpus store has **no per-chunk page numbers** (`/health` reports
`page_aware: false`) and **no reingest is planned** — the user was explicit about this.
So the page is recovered from the PDF itself at read time:

```
citation click
  → web/lib/pdf/store.ts        openPdf({filename, quote, …})
  → web/components/pdf/pdf-reader.tsx   POSTs the quote to /api/pdf-locate
  → web/app/(chat)/api/pdf-locate/route.ts   (session-gated proxy)
  → query_server.py  POST /pdf_locate
  → aprag_pdf.locate_quote()    finds the page + highlight rectangles
```

`locate_quote` returns the page, fractional rectangles (0–1, top-left origin, so the
client scales them to any zoom), and per-page `spans` when a passage crosses a page
break. `{"page": null, "rects": []}` is a normal answer meaning "not found" — the reader
then opens at page 1 and shows the message the user reported.

**How it locates:** phrase search (`page.search_for`) pins the page in a few ms, then
word-level alignment against that page's own words produces the *contiguous* run the
passage covers, merged into one rectangle per line. Alignment tolerates hyphenation,
dropped ligatures and stray header words. If phrase search finds nothing (some text
layers defeat it), it falls back to aligning against every page and scoring them.

Key files:

| File | Role |
| --- | --- |
| `aprag_pdf.py` | `locate_quote`, `_align_words`, `_page_tokens`, `_merge_line_rects`, plus `/pdf` + `/pdf_page` helpers |
| `query_server.py` | `/pdf`, `/pdf_page`, `/pdf_locate` endpoints (search for "PDF serving") |
| `web/components/pdf/pdf-reader.tsx` | tabs, continuous virtualised scrolling, highlight painting |
| `web/components/pdf/pdf-split.tsx` | the split layout; scopes tabs per chat |
| `tests/test_aprag_pdf.py` | 21 tests, all runnable locally (PyMuPDF + Pillow are in the repo venv) |

---

## 2. What the investigation found

The error message blames the text layer. That is usually **wrong**. Measured over 402
papers sampled from the store (one real chunk each, checked against the PDF of that
name):

| Outcome | Count | Share |
| --- | --- | --- |
| Passage located cleanly | 314 | 78% |
| **Same paper, text extracted differently** | 81 | **20.1%** |
| **A different paper under that name** | 7 | **1.7%** |
| No text layer (scan) | 0 | 0% |

Reproduce with `scripts/audit_store_vs_files.py` (see §4).

### 2a. The 20% — same paper, unusable word order

Every word of the passage is in the PDF, but not in that sequence, so alignment fails.
Cause: **ingest and the reader read the PDF with different extractors.** Ingest used
pypdf for much of the corpus, which jumbles two-column layouts (this is documented in the
repo's own OCR audit); the reader uses PyMuPDF, which does not. The *right* PDF opens and
only the highlight is missing.

This is the common case and the one worth fixing. It needs no data changes — see §5.1.

### 2b. The 1.7% — the file is a different paper

The reported example, verified by hand:

- On disk, `Liu_Etal_2025a.pdf` = *"What can be learned about color from language?"*
- On disk, `Liu_Etal_2025b.pdf` = the LLM item-calibration paper
- The store returns the item-calibration text **for `…2025a`**

So the `a`/`b` disambiguation suffixes were reassigned after ingest. Five of the seven
detected cases carry suffixes (`Kwon_Etal_2023b`, `Friston_Etal_1996a`, `Peterson_1999a`,
`Smith_Etal_2011b`, `Oring_2016a`), which points at suffix recomputation rather than
random corruption.

**This is worse than a missing highlight**: the citation opens the wrong paper, and the
APA reference is built from the same filename, so it names the wrong work.

A separate check found the **manifest and the files agree with each other** (0 of 36
suffixed papers mismatched). It is the *ingested store* that is out of step with both.

---

## 3. Already fixed — do not redo

- **Contiguous highlights.** The highlight used to be the opening phrase plus sampled
  six-word probes, which painted disconnected fragments down the page. It now covers the
  real span. Verified 14/14 papers, every line, no gaps.
- **Blurb prefix.** Chunks are stored as `"<situating blurb>\n\n<passage>"`, the blurb
  written by the ingest model and present in no paper. The client strips it only when the
  blank line falls inside the first 600 characters (`splitChunkContent` in
  `web/components/chat/rag-chunks.tsx`); past that the quote opened with impossible text.
  `locate_quote` now retries from after the blank line. **This did not fix the reported
  Liu case** — that one is §2b.
- **Symbol-only tokens.** Standalone `=` and `−` in statistics text normalise to nothing;
  two in a row desynced alignment. Both sides now drop them.
- **Page scoring.** Candidate pages are scored and the best one wins, behind a quality bar
  that scales with passage length — an earlier version took the first page with any match
  and painted a stray line on the wrong page.
- **Scroll-to-passage, resize anchoring, per-chat tabs, sidebar peek** — all shipped; see
  git log for `web/components/pdf/`.

---

## 4. Reproducing the measurements

`scripts/audit_store_vs_files.py` is the tool. It **must run on the PC** (needs Qdrant on
`:6333`, the PDFs on `D:\aprag_papers`, and the manifest):

```bash
rsync -q scripts/audit_store_vs_files.py pc:/cygdrive/c/rag_server/
ssh pc "cd C:\\rag_server && venv\\Scripts\\python audit_store_vs_files.py --limit 400"
# full corpus + machine-readable report:
ssh pc "cd C:\\rag_server && venv\\Scripts\\python audit_store_vs_files.py --all --out audit.json"
```

To inspect a single paper, `locate_quote` can be called directly on the PC:

```bash
ssh pc "cd C:\\rag_server && venv\\Scripts\\python -c \"
import sys; sys.path.insert(0, r'C:\\rag_server')
import aprag_pdf as p
print(p.locate_quote(r'D:\\aprag_papers\\Liu_Etal_2025a.pdf', 'passage text here'))\""
```

To see what the store actually holds for a paper (this is what the viewer sends):

```bash
KEY=$APRAG_API_KEY   # required; see §6
curl -s -X POST https://rag-api.devon7y.com/retrieve \
  -H 'Content-Type: application/json' -H "X-API-Key: $KEY" \
  -d '{"question":"main findings","filters":{"papers":["Liu_Etal_2025a.pdf"]},"chunk_top_k":2}'
```

---

## 5. Open work

### 5.1 Recover the 20% — code only, no data changes

When strict sequence alignment fails, fall back to: pick the page with the highest
distinctive-word overlap, then highlight the **longest contiguous run** found on it. The
reader would land on the right page with a partial highlight instead of reporting
nothing.

Where: `aprag_pdf.locate_quote`, after the existing attempts fail. `_align_words` already
returns `matched`; a relaxed second pass (higher miss tolerance, lower floor) plus a
word-overlap page score is most of the work.

Guard rails, learned the hard way:

- **Never paint a scatter.** The user rejected fragmented highlights outright; whatever is
  highlighted must be one contiguous run.
- **Never paint the wrong page.** A weak match on the wrong page is worse than none, which
  is why the quality bar exists. Keep it, just make the fallback tier explicit.
- Add tests to `tests/test_aprag_pdf.py`; they run locally, and a test that never executes
  caught nothing when this was last true (PyMuPDF was missing from the venv and every
  rasterisation test silently skipped).

### 5.2 Reconcile the 1.7% — needs a decision first

Filenames and content disagree for a small set of papers. Options, roughly in order of
invasiveness:

1. **Report only.** Run `--all`, produce the definitive list, and hand it over. Nothing
   changes; the user decides per paper.
2. **Remap the store.** Rewrite the affected `file_path` values in Qdrant/Neo4j to the
   filename that actually holds the text. Keeps citations pointing at real papers without
   touching the PDFs or the manifest.
3. **Rename the files.** Swap the PDFs back to the suffixes the store expects. Simple for
   pure swaps, but the manifest keys on filenames too, so it must move with them.

**Do not choose unilaterally** — this touches the manifest that drives every citation, and
the user has an explicit "no reingest" constraint that rules out the obvious fix. Confirm
the scope with `--all` first: 1.7% of ~10,400 papers is roughly 175 files, but the sample
is small enough that the true rate could differ.

---

## 6. Operational notes (worth knowing before touching anything)

- **The PC is the backend.** `ssh pc`; the server lives at `C:\rag_server`, the PDFs at
  `D:\aprag_papers` (C: has little headroom — never stage the corpus there).
- **Deploying a server change** = `rsync` the file to `C:\rag_server`, then restart the
  task. **A newly-copied file is not live until the process restarts** — check for a
  known-new `/health` field to tell deployed-on-disk from running-in-memory.
- **Restart trap:** `schtasks /End` and `/Run` issued back-to-back fail with
  `Last Result 1` and write nothing to the log, because the dying process still holds the
  log file. Wait a few seconds, then `/Run` again. Startup also hard-fails if Qdrant is
  mid-restart. Confirm with `/health` (`retrieval_ready: true`), not the task's status.
  The current task is `WestburyQueryServerFullDB` — task names drift, so read
  `schtasks /Query` rather than assuming.
- **`APRAG_API_KEY` is required** on every data endpoint. The tunnel host
  `rag-api.devon7y.com` is public, and the gate is armed in all three
  `start_query_server*.bat` launchers. Without the header you get 401 everywhere except
  `/health`. The key is in Vercel's env and in `~/.zshrc` on the Mac.
- **Web deploys**: `cd web && vercel deploy --prod`. Background shells here lack `node`
  and `vercel` on PATH — prefix `PATH="/opt/homebrew/bin:$PATH"`.
- **Typecheck** with `./node_modules/.bin/tsc --noEmit` from `web/`; `tsc` is the only
  reliable gate (the repo's biome/ultracite config is broken).
- **Two parallel citation implementations.** Chat answers are rewritten in
  `web/lib/aprag/citations.ts`; CLI/MCP answers in `apa_citations.py`. A change to
  citation behaviour needs applying in both — they never share code.
- **Another agent works in this repo.** Check `git status` and stage by name; leave
  in-flight files alone (query-speed work lives in `query_server.py` and `scripts/fp16_*`).
