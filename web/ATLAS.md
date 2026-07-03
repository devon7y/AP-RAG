# Atlas of Mind — architecture & conventions (merged into web/)

> **⚠️ Agent build note — keep raw passages out of your context.** The corpus data
> files carry verbatim paper text, some of which pattern-matches dual-use/abuse
> content (jailbreak/self-harm examples from safety papers, social-engineering +
> PII transcripts, sexual chatbot dialogue). This text belongs in the *product*
> (the browser streams it straight from the JSON), but do **not** `Read` the
> passage-bearing files into your own reasoning context. Concretely: never `Read`
> `public/data/atlas.json` (9k chunk snippets), `server-data/chunk_text.json`, or
> scroll raw Qdrant content. Inspect them only programmatically (counts/keys/shapes
> via `jq`/Python) if you must. Write code against the typed loaders in `lib/atlas/`,
> which the browser executes — you never need the prose yourself.
> `public/data/voids.json` is sanitized (ghost papers only) and safe to read.

The Atlas of Mind was a standalone Next.js app (`AP-RAG/atlas/`); it now lives
inside this chatbot app as a route group. Eight experiences over one shared data
core, reachable from the chat sidebar ("Atlas of Mind") at `/atlas`.

## Where things live now (old standalone path → merged path)

| Standalone (`atlas/`) | Merged (`web/`) |
|---|---|
| `app/<route>/page.tsx` | `app/(atlas)/atlas/<route>/page.tsx` |
| `app/page.tsx` (hub) | `app/(atlas)/atlas/page.tsx` |
| `app/api/<name>/route.ts` | `app/(atlas)/api/atlas/<name>/route.ts` (URLs `/api/atlas/*`) |
| `components/<route>/…` | `components/atlas/<route>/…` |
| `components/atlas/…` (voids scene) | `components/atlas/voids/…` |
| `components/{ExperienceShell,HDRCanvas}.tsx` | `components/atlas/{ExperienceShell,HDRCanvas}.tsx` |
| `lib/*` | `lib/atlas/*` |
| `public/data/*` | `public/data/*` (same URLs) |
| `server-data/chunk_text.json` | `server-data/chunk_text.json` |
| `data-pipeline/` | `data-pipeline/` (raw/ + .venv/ gitignored) |

## Merge-specific conventions (differences from the standalone app)

1. **PC access rides the tunnel.** `lib/atlas/pc.ts` no longer talks to the
   Tailscale IP / raw ports. It POSTs to `$APRAG_QUERY_URL` (the Cloudflare
   Tunnel already used by the chat backend) with `X-API-Key: $APRAG_API_KEY`.
   The query server (`AP-RAG/query_server.py` on the PC) grew four atlas-support
   endpoints: `/embed`, `/qsearch`, `/vectors`, `/paper_centroid`.
2. **Auth.** The `(atlas)` layout has the same login wall as the chat, and every
   `/api/atlas/*` route checks the session (they proxy paid/managed backends).
3. **Scoped theme.** The atlas is always-dark inside a `.atlas-app` wrapper
   (see the block at the end of `app/globals.css`). All raw CSS vars are
   `--atlas-*`; utilities `text-ink/-2/-3`, `bg-page`, `bg-surface`,
   `border-hairline` are atlas-only additions, and the accent utilities are
   `text-atlas-accent` / `border-atlas-accent` / `bg-atlas-accent` (plain
   `accent` belongs to the chat's shadcn theme).
4. **Motion.** Atlas components import `motion/react` (the `motion` package),
   not `framer-motion` (which the chat pins at v11).
5. **Biome/ultracite excludes** `app/(atlas)`, `components/atlas`, `lib/atlas`,
   and `data-pipeline` — the atlas keeps its original code style.
6. **Serverless data files.** `/api/atlas/chunk` and `/api/atlas/semantle` read
   local JSON at runtime; `next.config.ts` pins them into the function bundle
   via `outputFileTracingIncludes`.

## Unchanged conventions (from the standalone app)

1. **File boundaries.** Each experience owns exactly its page
   (`app/(atlas)/atlas/<route>/page.tsx`, thin: `"use client"`, dynamic-imports
   its scene with `ssr: false`) and its `components/atlas/<route>/` folder.
2. **3D scenes use `components/atlas/HDRCanvas.tsx`** (WebGPU HDR → SDR → WebGL
   negotiation). Read `hdrBoost` from `useAtlasStore` and multiply emissive
   intensities by it.
3. **Design tokens** from `lib/atlas/palette.ts` and the `.atlas-app` CSS vars.
   Chart-like UI follows the dataviz rules: sequential blue ramp for magnitude,
   direct labels, no rainbow, text in ink tokens never in series colors.
4. **Data** via `lib/atlas/useCorpus.tsx` hooks (`useCorpus`, `useKnn`,
   `useConstellations`) — cached module-level. World coords: `toWorld(x01, y01)`
   maps the unit square to ±50 in x/z; heightmap via
   `sampleHeight(corpus.heightmap, x01, y01)`.
5. **Server calls** via `lib/atlas/api.ts` only (`embed`, `qsearch`,
   `fetchChunkText`, `fetchVectors`, `ragQuery`, `ragRetrieve`, plus
   `/api/atlas/semantle`, `/api/atlas/seance`). Never call the PC from the
   client — always through `/api/atlas/*`.
6. **Performance.** 9,009 points is small for GPU but big for React: render
   point clouds as ONE buffer geometry / instanced mesh, never 9k React
   elements. Labels: drei `<Html>` or troika `<Text>` for ≤ ~60 visible labels.
7. **Citations everywhere.** Any surfaced passage shows paper
   authors/year/title (via `corpus.papers[corpus.atlas.paper[i]]`) and section
   when available.

## Data shapes (all under `public/data/`, loaded by `lib/atlas/data.ts`)

- `atlas.json` → `AtlasData`: columnar per-chunk `pos2` (flat [0,1]²), `pos3`,
  `cluster`, `paper` (index into papers), `year`, `snippet[160]`, `section`,
  `chunkId`.
- `papers.json` → `Paper[]`: `file,title,authors,year,journal,doi,abstract,
  centroid,centroid3,nChunks`.
- `clusters.json` → `Cluster[]`: `id,size,nPapers,center,center3,terms,
  sampleTitles,name,flavor` (name/flavor are LLM-authored region names).
- `knn.json` → `KnnGraph` (k=8 cosine neighbors, flat arrays; helper `neighborsOf`).
- `constellations.json` → `{entities: Entity[], edges: KgEdge[]}` (top-500 KG
  entities with map positions + top edges).
- `voids.json` → `VoidSite[]`: low-density sites with `title`/`abstract` ghost
  papers (LLM-authored) + `nearChunks` context.
- `heightmap.bin` → 512×512 float32 row-major (y-major) density heightmap, 0..1.

Regenerate with `data-pipeline/pipeline.py` (writes `../public/data` +
`../server-data` relative to itself, i.e. straight into this app).

## API routes (server-side, proxy the PC query server over the tunnel)

- `POST /api/atlas/embed` `{texts: string[], context?: "query"|"document"}` → `{embeddings}`
- `POST /api/atlas/qsearch` `{text?|vector?, limit?}` → `{hits: [{qid,chunkId,file,score}]}`
- `POST /api/atlas/vectors` `{qids}` → `{vectors: {qid: number[]}}` (4096-dim)
- `GET  /api/atlas/chunk?id=<chunkId>` → `{text, section, page, file, qid}` (local JSON)
- `POST /api/atlas/rag/query|retrieve|search` → PC query server passthrough
- `GET/POST /api/atlas/semantle` — daily game (see route file)
- `POST /api/atlas/seance` `{author, question, history?}` → `{answer, references, mode}`

## Route map

| Route | Experience | Key data |
|---|---|---|
| `/atlas` | hub (links to everything) | — |
| `/atlas/voids` | ghost papers in the empty pockets | voids, atlas, heightmap |
| `/atlas/observatory` | starfield + KG constellations | atlas.pos3, constellations |
| `/atlas/semantle` | daily hidden-paper game | /api/atlas/semantle, atlas (map pings) |
| `/atlas/wormhole` | nearest-neighbor race | knn, atlas, papers |
| `/atlas/interpolate` | slerp between ideas | /api/atlas/{embed,qsearch,vectors} |
| `/atlas/radio` | ambient kNN drift + TTS | knn, atlas, /api/atlas/chunk |
| `/atlas/dungeon` | KG roguelike | constellations, /api/atlas/rag/* |
| `/atlas/seance` | author-grounded chat | papers (author list), /api/atlas/seance |

(The 3D terrain "The Atlas" from the original route map is not built yet; its
hub card shows "coming soon".)
