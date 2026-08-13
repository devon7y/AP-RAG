# AP-RAG Web

The web chatbot frontend for **AP-RAG** — a multi-turn UI over the AP-RAG knowledge base
(LightRAG + Qdrant + gpt-5-mini), deployed at **https://aprag.devon7y.com**.

Built on the Vercel `chatbot` template (Next.js 16, AI SDK v6, Auth.js, Neon Postgres),
adapted so that:

- **gpt-5-mini** (your OpenAI key) synthesizes answers on Vercel, streamed token-by-token.
- Retrieval comes from the PC's `query_server.py` (`POST /retrieve`, `GET /stats`) reached
  over a **Cloudflare Tunnel** — server-side only; the tunnel URL/secret never reach the
  browser.
- Each turn: condense follow-up → standalone query → `/retrieve` → synthesize with `[n]`
  citations → render clickable APA in-text cites + an APA **References** list with Google
  **Drive** links and PDF page numbers.
- **Chunk mode** (composer toggle) shows the raw retrieved chunks as cards (the web
  `aprag chunks`).
- **Upload Papers** (composer button, or drop PDFs on the composer) brings papers that are
  *not* in the database into a chat — see below.
- **Reasoning** (`minimal|low|medium|high`) and **retrieval mode**
  (`hybrid|local|global|mix|naive`) selectors + a metadata **Filters** popover mirror the
  CLI flags.
- Header shows **AP-RAG** + the bolded expansion and a live **paper count** (`/api/stats`).
- Login-gated to an allowlisted account (`AUTH_ALLOWED_EMAILS`); chats persist in Postgres.

## Upload Papers (papers that aren't in the database)

A user can attach PDFs to a chat and discuss them alongside the corpus — a paper that has
just come out, a manuscript under review, a colleague's preprint. **PDFs only**: the
chunker, the citation plumbing and the reader are all built around a paper with pages.

The corpus itself is built by the HPC ingest pipeline (chunk → contextualize → embed →
Qdrant), so an uploaded paper is deliberately **not** ingested. It lives with its chat:

1. **Upload** (`POST /api/uploads`) stores the PDF in Vercel Blob, extracts its text with
   pdf.js **page by page**, chunks it (`lib/aprag/uploads.ts` — a trimmed cousin of
   `pipeline/scientific_chunker.py`: section-aware, strips running heads, drops the
   reference list), and reads the front matter with gpt-5-mini for an APA citation. The
   composer shows "Reading…" while this runs; when it returns, the paper is answerable.
2. **Every following turn** puts the attached papers in front of the answer model, merged
   into the *same* `[n]`-numbered Sources the database retrieval produced. One budget
   governs this — **30k tokens** — and what the model sees is `min(attached, budget)`:
   anything that fits goes in **whole** (essentially every journal article; "summarize this
   paper" wants the paper, not an excerpt), and only what does not fit is BM25-ranked
   against the condensed query, spending the same 30k on the best-matching passages with a
   floor per paper so a second attachment is never squeezed out. Crossing the budget
   changes *which* text is chosen, never how much. There is no embedding server for
   per-chat scratch documents, which is why the ranking is lexical.
3. **The answer cites them like any other source**: `(Adams & Delaney, 2023)`, an entry in
   the References list (marked *Uploaded*), and the PDF opens in the in-app reader at the
   cited page — it is served through `/api/pdf/upload-<id>.pdf`, so the reader, the
   prefetcher and "open in a new tab" need to know nothing about uploads.

Papers belong to the **chat**, not to a message: everyone in a shared chat sees them and
can ask about them, the owner or the uploader can remove one, and deleting the chat
deletes them. Limits: 6 papers per chat, 25 MB each, 250 pages. A scan with no text layer
is refused with an explanation rather than stored.

Author-persona chats and a Research Digest's first (bucketed) turn deliberately ignore
attachments — the first answers from one author's published work, the second is a dated
sweep of the corpus.

## What lives where (the AP-RAG-specific code)

| Path | Purpose |
| --- | --- |
| `lib/aprag/client.ts` | server-side fetch to the query server (`/retrieve`, `/stats`) with `X-API-Key` |
| `lib/aprag/citations.ts` | `[n]`→APA in-text rewrite, cited-id scan, page formatting, synthesis prompt/context |
| `lib/aprag/condense.ts` | follow-up → standalone retrieval query (gpt-5-mini, minimal) |
| `lib/aprag/types.ts` | `RagRetrieval` / reference / chunk shapes |
| `lib/aprag/uploads.ts` | uploaded papers: chunking, BM25 passage selection, `[n]` context (pure) |
| `lib/aprag/upload-pdf.ts` | PDF → per-page text (pdf.js in Node) + front-matter identification |
| `lib/aprag/upload-identity.ts` | a bibliographic record → APA7 entry + in-text cite (pure) |
| `app/(chat)/api/uploads/` | attach / list / remove a chat's uploaded papers |
| `components/chat/upload-papers.tsx` | the composer's upload button, chips and drop zone |
| `app/(chat)/api/chat/route.ts` | the RAG turn: condense → retrieve → emit `data-retrieval` → stream synthesis |
| `app/(chat)/api/stats/route.ts` | paper-count proxy |
| `components/chat/rag-controls.tsx` | reasoning / mode / chunk toggle / filters |
| `components/chat/rag-references.tsx`, `rag-chunks.tsx` | references list + chunk cards |
| `components/chat/app-title.tsx` | bolded header title + live paper count |
| `lib/ai/models.ts`, `lib/ai/providers.ts` | collapsed to gpt-5-mini via `@ai-sdk/openai` |

## Environment

Copy `.env.example` → `.env.local` and fill in. Required:

- `OPENAI_API_KEY` — gpt-5-mini (answers + titles + condense).
- `APRAG_QUERY_URL` — the Cloudflare Tunnel URL of `query_server.py` (e.g.
  `https://rag-api.devon7y.com`).
- `APRAG_API_KEY` — shared secret matching `APRAG_API_KEY` on the PC (blank if unset there).
- `AUTH_ALLOWED_EMAILS` — comma-separated allowlist (locks registration/login).
- `AUTH_SECRET` — `openssl rand -base64 32`.
- `POSTGRES_URL` — Neon/Vercel Postgres (chat history).
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob (attachments).
- `REDIS_URL` (or `KV_URL`) — optional. Without it the chat still works, but loses
  resumable streams — so in a shared chat the other participants wait for the whole
  answer instead of watching it stream in — and IP rate limiting. Either name works,
  since Vercel's marketplace providers disagree about it: the official Redis integration
  sets `REDIS_URL`, Upstash's KV product sets `KV_URL`.

## Develop

```bash
pnpm install
pnpm db:migrate      # provision the Postgres schema
pnpm dev             # http://localhost:3000
```

Register once with an allowlisted email, then chat. Point `APRAG_QUERY_URL` at the live
tunnel (or an SSH-forwarded `localhost:8001`) to talk to the real corpus.

## Deploy (Vercel)

1. Import this repo into Vercel with **Root Directory = `web`**.
2. Add the Vercel **Neon Postgres** + **Blob** integrations (sets `POSTGRES_URL`,
   `BLOB_READ_WRITE_TOKEN`).
3. Set the env vars above (`OPENAI_API_KEY`, `APRAG_QUERY_URL`, `APRAG_API_KEY`,
   `AUTH_SECRET`, `AUTH_ALLOWED_EMAILS`).
4. Add the domain **aprag.devon7y.com** (Vercel → Domains) and the matching DNS record.

The backend tunnel + DNS setup lives in the repo-root deploy notes
([../docs/WEB_FRONTEND.md](../docs/WEB_FRONTEND.md)).
