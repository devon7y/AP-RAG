# Papers Atlas — architecture & conventions

> **⚠️ Agent build note — keep raw passages out of your context.** The corpus data
> files carry verbatim paper text, some of which pattern-matches dual-use/abuse
> content (jailbreak/self-harm examples from safety papers, social-engineering +
> PII transcripts, sexual chatbot dialogue). This text belongs in the *product*
> (the browser streams it straight from the JSON), but do **not** `Read` the
> passage-bearing files into your own reasoning context. Concretely: never `Read`
> `public/data/atlas_strings.json` / `atlas.json` (chunk snippets),
> `server-data/chunk_text.json`, or scroll raw Qdrant content. Inspect them only
> programmatically (counts/keys/shapes via `jq`/Python). Write code against the
> typed loaders in `lib/atlas/`, which the browser executes — you never need the
> prose yourself.

The Papers Atlas is ONE unified 3D world at `/atlas` (the chat sidebar's
"Papers Atlas" button lands here). The former standalone experiences
(observatory, voids, semantle, wormhole, dungeon, radio, interpolate, séance
page, and the card hub) were removed 2026-07-04 as dead code — their surviving
logic lives inside `components/atlas/world/` (`walk.ts`, `tts.ts`,
`temperature.ts`, `engineBridge.ts`, the age ramp in `derive.ts`).

## Layout

- `app/(atlas)/atlas/page.tsx` — the world (dynamic import, ssr:false)
- `components/atlas/world/` — every layer + panel; `components/atlas/HDRCanvas.tsx`
  is the WebGPU-HDR → SDR → WebGL canvas
- `lib/atlas/` — loaders (`data.ts`, binary-first `loadCorpus`), api client,
  palette, `store.ts` (canvas mode + hdrBoost), `pc.ts` (server-side PC bridge),
  `chunkText.ts` (server-side passage table)
- API routes under `app/(atlas)/api/atlas/`: `chunk`, `embed`, `qsearch`,
  `vectors`, `rag/[op]`, `ghost` (gap-paper writer), `semantle-author`
  (daily passage → first-author game)

## Conventions that must not regress

1. Three r185 WebGPU: custom shading is TSL node materials only (no GLSL
   ShaderMaterial, no drei Line2/troika Text on the HDR canvas). Sized points =
   one THREE.Sprite with `count = n` + PointsNodeMaterial (see ChunkCloud).
2. Read `hdrBoost` from `useAtlasStore`; multiply emissive overshoot by it.
3. One buffer per point layer — never n React elements; DOM labels ≤ ~60 via
   drei `Html`.
4. Every surfaced passage shows its citation (papers table via
   `corpus.papers[corpus.atlas.paper[i]]`).
5. Server calls go through `/api/atlas/*` (auth-gated) — never the PC directly.
6. All metadata derives from the canonical database `data/papers_metadata.json`
   (+ `data/drive_links.json`) at the repo root — never a copy. Full corpus
   rebuild: `hpc_layout.py` (HPC) → `pack_full.py` → `name_clusters.py` →
   `export_metadata.py` → `build_cluster_trends.py`. Metadata-only refresh
   after the database changes (no re-layout): `refresh_paper_table.py` →
   `export_metadata.py` → `build_cluster_trends.py`, or just run
   `scripts/propagate_papers.sh` from the repo root (see
   `docs/SINGLE_DATABASE.md`).
