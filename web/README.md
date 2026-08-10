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
- **Reasoning** (`minimal|low|medium|high`) and **retrieval mode**
  (`hybrid|local|global|mix|naive`) selectors + a metadata **Filters** popover mirror the
  CLI flags.
- Header shows **AP-RAG** + the bolded expansion and a live **paper count** (`/api/stats`).
- Login-gated to an allowlisted account (`AUTH_ALLOWED_EMAILS`); chats persist in Postgres.

## What lives where (the AP-RAG-specific code)

| Path | Purpose |
| --- | --- |
| `lib/aprag/client.ts` | server-side fetch to the query server (`/retrieve`, `/stats`) with `X-API-Key` |
| `lib/aprag/citations.ts` | `[n]`→APA in-text rewrite, cited-id scan, page formatting, synthesis prompt/context |
| `lib/aprag/condense.ts` | follow-up → standalone retrieval query (gpt-5-mini, minimal) |
| `lib/aprag/types.ts` | `RagRetrieval` / reference / chunk shapes |
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
