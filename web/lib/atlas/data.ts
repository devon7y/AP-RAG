"use client";

import type {
  AtlasData,
  AuthorRec,
  Constellations,
  CorpusData,
  KnnGraph,
  PaperMeta,
} from "./types";

let corpusPromise: Promise<CorpusData> | null = null;
let knnPromise: Promise<KnnGraph> | null = null;
let constellationsPromise: Promise<Constellations> | null = null;
let authorsPromise: Promise<AuthorRec[]> | null = null;
let paperMetaPromise: Promise<PaperMeta> | null = null;

async function j<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

/** Binary columnar atlas (atlas.bin + sidecars, written by pack_atlas.py).
 *  Typed arrays view the fetched buffer directly — no number[] parse. This is
 *  the path that survives the full ~500k-chunk corpus; atlas.json is fallback. */
async function loadAtlasBinary(): Promise<AtlasData> {
  const meta = await j<{
    n: number;
    sections: { name: string; dtype: string; offset: number; count: number }[];
  }>("/data/atlas.meta.json");
  const [buf, strings] = await Promise.all([
    fetch("/data/atlas.bin").then((r) => {
      if (!r.ok) throw new Error(`atlas.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
    j<{ snippet: string[]; section: string[]; chunkId: string[] }>(
      "/data/atlas_strings.json",
    ),
  ]);
  const view = <T>(
    name: string,
    Ctor: new (b: ArrayBuffer, off: number, len: number) => T,
  ): T => {
    const s = meta.sections.find((x) => x.name === name);
    if (!s) throw new Error(`atlas.bin: missing section ${name}`);
    return new Ctor(buf, s.offset, s.count);
  };
  return {
    n: meta.n,
    pos2: view("pos2", Float32Array),
    pos3: view("pos3", Float32Array),
    cluster: view("cluster", Int16Array),
    paper: view("paper", Int32Array),
    year: view("year", Int16Array),
    snippet: strings.snippet,
    section: strings.section,
    chunkId: strings.chunkId,
  };
}

async function loadAtlasJson(): Promise<AtlasData> {
  const rawAtlas = await j<Record<string, unknown>>("/data/atlas.json");
  return {
    n: rawAtlas.n as number,
    pos2: Float32Array.from(rawAtlas.pos2 as number[]),
    pos3: Float32Array.from(rawAtlas.pos3 as number[]),
    cluster: Int16Array.from(rawAtlas.cluster as number[]),
    paper: Int32Array.from(rawAtlas.paper as number[]),
    year: Int16Array.from(rawAtlas.year as number[]),
    snippet: rawAtlas.snippet as string[],
    section: rawAtlas.section as string[],
    chunkId: rawAtlas.chunkId as string[],
  };
}

/** Core corpus bundle: chunk projections + papers + clusters + voids + heightmap. */
export function loadCorpus(): Promise<CorpusData> {
  corpusPromise ??= (async () => {
    const [atlas, papers, clusters, voids, hm] = await Promise.all([
      loadAtlasBinary().catch(loadAtlasJson),
      j<CorpusData["papers"]>("/data/papers.json"),
      j<CorpusData["clusters"]>("/data/clusters.json"),
      j<CorpusData["voids"]>("/data/voids.json"),
      fetch("/data/heightmap.bin").then((r) => r.arrayBuffer()),
    ]);
    return { atlas, papers, clusters, voids, heightmap: new Float32Array(hm) };
  })();
  return corpusPromise;
}

/** Disambiguated author table (exported from the APA manifest). */
export function loadAuthors(): Promise<AuthorRec[]> {
  authorsPromise ??= j<AuthorRec[]>("/data/authors.json");
  return authorsPromise;
}

/** Per-paper keywords / subjects / affiliations (parallel to papers.json). */
export function loadPaperMeta(): Promise<PaperMeta> {
  paperMetaPromise ??= j<PaperMeta>("/data/papermeta.json");
  return paperMetaPromise;
}

/** kNN graph over chunks (full-vector cosine). */
export function loadKnn(): Promise<KnnGraph> {
  knnPromise ??= (async () => {
    const raw = await j<{ k: number; idx: number[]; sim: number[] }>("/data/knn.json");
    return {
      k: raw.k,
      idx: Int32Array.from(raw.idx),
      sim: Float32Array.from(raw.sim),
    };
  })();
  return knnPromise;
}

export function loadConstellations(): Promise<Constellations> {
  constellationsPromise ??= j<Constellations>("/data/constellations.json");
  return constellationsPromise;
}

/** Neighbors of chunk i from the kNN graph. */
export function neighborsOf(knn: KnnGraph, i: number): { idx: number; sim: number }[] {
  const out: { idx: number; sim: number }[] = [];
  for (let k = 0; k < knn.k; k++) {
    out.push({ idx: knn.idx[i * knn.k + k], sim: knn.sim[i * knn.k + k] });
  }
  return out;
}

/** World-space convention shared by every 3D scene:
 *  map [0,1]² → x,z in [-SIZE/2, SIZE/2]; height (y) is scene-specific. */
export const WORLD_SIZE = 100;

export function toWorld(x01: number, y01: number): [number, number] {
  return [(x01 - 0.5) * WORLD_SIZE, (y01 - 0.5) * WORLD_SIZE];
}

/** Bilinear heightmap sample at map coords [0,1]². */
export function sampleHeight(hm: Float32Array, x01: number, y01: number, grid = 512): number {
  const fx = Math.min(Math.max(x01, 0), 0.999999) * (grid - 1);
  const fy = Math.min(Math.max(y01, 0), 0.999999) * (grid - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, grid - 1);
  const y1 = Math.min(y0 + 1, grid - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const h00 = hm[y0 * grid + x0];
  const h10 = hm[y0 * grid + x1];
  const h01 = hm[y1 * grid + x0];
  const h11 = hm[y1 * grid + x1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}
