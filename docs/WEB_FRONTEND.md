# AP-RAG Web Frontend — deploy notes

The web chatbot lives in [`web/`](../web) (Next.js 16, AI SDK v6, deployed on Vercel at
**aprag.devon7y.com**). It mirrors the `aprag` CLI: multi-turn APA-cited answers, a raw
**chunk** view, reasoning + retrieval-mode controls, metadata filters, Google Drive paper
links, and a live paper count. Architecture, per the approved plan:

```
Browser ──▶ Vercel (Next.js, Auth.js, Neon)        [public: aprag.devon7y.com]
              ├─▶ OpenAI gpt-5-mini (streamed)       [OPENAI_API_KEY]
              └─▶ Cloudflare Tunnel ─▶ PC query_server:8001  [APRAG_QUERY_URL + X-API-Key]
                       /retrieve  /stats
```

gpt-5-mini synthesis runs **on Vercel**; the PC is used only for retrieval. APA *formatting*
still happens on the PC (`_enrich_references`), so the web app only ports the lightweight
`[n]`→APA rewrite ([web/lib/aprag/citations.ts](../web/lib/aprag/citations.ts)).

## Backend changes (already applied to [query_server.py](../query_server.py))

- `GET /stats` → `{ papers }` (doc_status PROCESSED + PREPROCESSED) for the header badge.
- Per-reference **pages** added to `/retrieve` references (`_enrich_references` + `_pages_by_reference`).
- Optional shared-secret gate: when `APRAG_API_KEY` is set, `/query·/retrieve·/search·/stats`
  require header `X-API-Key`. `/health` stays open. The `aprag` CLI/MCP send the key from
  `$APRAG_API_KEY` ([aprag/client.py](../aprag/client.py)).

Redeploy the PC stack after pulling these (`restart_aprag_pc.sh`), and set `APRAG_API_KEY`
in the server's environment.

## 1. Cloudflare Tunnel (on the PC)

Exposes `query_server` (localhost:8001) at a stable HTTPS hostname. Requires the
`devon7y.com` zone on Cloudflare (move nameservers to Cloudflare first — free plan is fine;
this also lets Cloudflare manage the `aprag` → Vercel record).

```powershell
# On the PC (ssh pc):
winget install --id Cloudflare.cloudflared
cloudflared tunnel login                       # browser auth, selects the devon7y.com zone
cloudflared tunnel create aprag-api
cloudflared tunnel route dns aprag-api rag-api.devon7y.com
# config.yml: tunnel <id>; credentials-file <...>; ingress:
#   - hostname: rag-api.devon7y.com
#     service: http://localhost:8001
#   - service: http_status:404
cloudflared service install                    # run as a Windows service (always-on)
```

(These steps can be driven via the Cloudflare API instead — see "Automated setup" below.)

## 2. Vercel

- Import the `devon7y/AP-RAG` repo, **Root Directory = `web`**.
- Add the **Neon Postgres** and **Blob** integrations (sets `POSTGRES_URL`,
  `BLOB_READ_WRITE_TOKEN`).
- Env vars: `OPENAI_API_KEY`, `APRAG_QUERY_URL=https://rag-api.devon7y.com`, `APRAG_API_KEY`,
  `AUTH_SECRET` (`openssl rand -base64 32`), `AUTH_ALLOWED_EMAILS=devon7y@gmail.com`.
- Build runs `pnpm db:migrate && next build` (migrates the chat-history schema).

## 3. Domain

- Vercel → Project → Domains → add `aprag.devon7y.com`.
- DNS (on Cloudflare): `aprag` CNAME → `cname.vercel-dns.com`, **DNS-only (grey cloud)** so
  Vercel terminates TLS.

## Automated setup (Cloudflare API token)

A token scoped to do tunnel + DNS without the dashboard needs:

- **Account → Cloudflare Tunnel → Edit** (create/configure the tunnel)
- **Zone → DNS → Edit** (create the `rag-api` tunnel route + the `aprag` → Vercel CNAME)
- **Zone → Zone → Read** (resolve the zone id)
- Account resource = your account; Zone resource = `devon7y.com` (or All zones).

Prerequisite the token can't satisfy: `devon7y.com` must already be a zone on Cloudflare
(nameserver change at the registrar). The OpenAI key and `AUTH_SECRET` are set in Vercel.

## Verify

```bash
# Backend (through the tunnel):
curl -H "X-API-Key: $APRAG_API_KEY" https://rag-api.devon7y.com/stats          # {"papers": ~1400}
curl -H "X-API-Key: $APRAG_API_KEY" -X POST https://rag-api.devon7y.com/retrieve \
  -H 'content-type: application/json' -d '{"question":"word frequency","mode":"naive"}' | jq '.data.references[0]'
curl -i https://rag-api.devon7y.com/retrieve -X POST -d '{}'                   # 401 without the key

# CLI still works locally (sends the key from $APRAG_API_KEY):
APRAG_API_KEY=… APRAG_QUERY_URL=https://rag-api.devon7y.com aprag health
```

In the app: log in → ask the sample query ("Regarding Yanitski 2026's LLM utilitarianism
study … what percentage were classified as utilitarian?") → ask a follow-up and confirm the
condense step retrieves sensibly → check APA in-text cites, the References list (Drive links +
pages), toggle **Chunks**, change **reasoning**/**mode**, confirm the header paper count, and
reload a saved chat.
