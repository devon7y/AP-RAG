# Atlas of Mind — architecture & conventions

> **⚠️ Fable build note — keep raw passages out of your context.** The corpus data
> files carry verbatim paper text, some of which pattern-matches dual-use/abuse
> content (jailbreak/self-harm examples from safety papers, social-engineering +
> PII transcripts, sexual chatbot dialogue). This text belongs in the *product*
> (the browser streams it straight from the JSON), but do **not** `Read` the
> passage-bearing files into your own reasoning context — that is what trips the
> flag. Concretely: never `Read` `public/data/atlas.json` (9k chunk snippets),
> `server-data/chunk_text.json`, or scroll raw Qdrant content. Inspect them only
> programmatically (counts/keys/shapes via `jq`/Python) if you must. Write your
> code against the typed loaders in `lib/`, which the browser executes — you never
> need the prose yourself. `public/data/voids.json` has already been sanitized
> (ghost papers only, raw prose stripped) and is safe to read.


One Next.js 16 app (`atlas/` inside AP-RAG), eight routes over one shared data
core. Every experience is a client page that renders a full-viewport scene (or
panel UI) inside `ExperienceShell`.

## Non-negotiable conventions

1. **Read before writing.** This is Next 16 (async `params`, Turbopack). React 19,
   three ^0.185, @react-three/fiber ^9, drei ^10, zustand ^5, Tailwind v4
   (config-less, `@theme` in `app/globals.css`).
2. **File boundaries.** Each experience owns exactly:
   - `app/<route>/page.tsx` (thin: `"use client"`, dynamic-imports its scene with `ssr: false`)
   - `components/<route>/…` (all of its components)
   Never edit `lib/*`, `components/HDRCanvas.tsx`, `components/ExperienceShell.tsx`,
   other experiences' folders, `app/globals.css`, or `app/page.tsx`. If a shared
   file seems to need a change, report it in your final message instead of editing.
3. **3D scenes use `components/HDRCanvas.tsx`** (WebGPU HDR → SDR → WebGL
   negotiation). Read `hdrBoost` from `useAtlasStore` — multiply emissive
   intensities by it so HDR canvases overshoot 1.0 and SDR canvases don't clip.
   Postprocessing: `@react-three/postprocessing` Bloom is allowed (it works on the
   WebGPU renderer in three 0.185; if it errors on the WebGL fallback, gate it).
4. **Design tokens** from `lib/palette.ts` (dark-surface dataviz palette) and the
   CSS vars in `globals.css` (`hud-panel`, ink classes `text-ink/-2/-3`). Chart-like
   UI (meters, histograms, similarity bars) follows the dataviz rules: sequential
   blue ramp for magnitude, direct labels, no rainbow, text in ink tokens never in
   series colors.
5. **Data** via `lib/useCorpus.tsx` hooks (`useCorpus`, `useKnn`,
   `useConstellations`) — cached module-level, cheap to call in any page. World
   coords: `toWorld(x01, y01)` maps the unit square to ±50 in x/z; heightmap via
   `sampleHeight(corpus.heightmap, x01, y01)` (0..1, scale to taste per scene).
6. **Server calls** via `lib/api.ts` only (`embed`, `qsearch`, `fetchChunkText`,
   `fetchVectors`, `ragQuery`, `ragRetrieve`, plus `/api/semantle`, `/api/seance`).
   Never call the PC (100.98.84.84) from the client — always through `/api/*`.
7. **Performance.** 9,009 points is small for GPU but big for React: render point
   clouds as ONE buffer geometry / instanced mesh, never 9k React elements. Labels:
   drei `<Html>` or troika `<Text>` for ≤ ~60 visible labels, culled by camera.
8. **Citations everywhere.** Any surfaced passage shows paper authors/year/title
   (via `corpus.papers[corpus.atlas.paper[i]]`) and section when available.

## Data shapes (all under `public/data/`, loaded by `lib/data.ts`)

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

## API routes (server-side, proxy the PC over Tailscale)

- `POST /api/embed` `{texts: string[], context?: "query"|"document"}` → `{embeddings}`
- `POST /api/qsearch` `{text?|vector?, limit?}` → `{hits: [{qid,chunkId,file,score}]}`
- `POST /api/vectors` `{qids}` → `{vectors: {qid: number[]}}` (4096-dim)
- `GET  /api/chunk?id=<chunkId>` → `{text, section, page, file, qid}`
- `POST /api/rag/query|retrieve|search` → PC query server passthrough
  (`question`, `mode`, `filters`, `user_prompt`, `top_k`, `chunk_top_k`)
- `GET/POST /api/semantle` — daily game (see route file)
- `POST /api/seance` `{author, question, history?}` → `{answer, references, mode}`

## Route map

| Route | Experience | Key data |
|---|---|---|
| `/atlas` | 3D terrain + regions + time machine + ghost voids | atlas, clusters, heightmap, voids |
| `/observatory` | starfield + KG constellations | atlas.pos3, constellations |
| `/semantle` | daily hidden-paper game | /api/semantle, atlas (map pings) |
| `/wormhole` | nearest-neighbor race | knn, atlas, papers |
| `/interpolate` | slerp between ideas | /api/embed, /api/qsearch, /api/vectors |
| `/radio` | ambient kNN drift + TTS | knn, atlas, /api/chunk |
| `/dungeon` | KG roguelike | constellations, /api/rag/retrieve, /api/rag/query |
| `/seance` | author-grounded chat | papers (author list), /api/seance |
