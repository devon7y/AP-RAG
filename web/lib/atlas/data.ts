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

/** Binary columnar atlas (atlas.bin + doc_hashes.json, written by pack_full.py).
 *  Typed arrays view the fetched buffer directly — no number[] parse. At the full
 *  ~445k-chunk corpus the old string sidecar was ~118 MB, so chunk ids ride along
 *  as (docIdx, chunkNum) columns instead and passage prose is fetched per click. */
async function loadAtlasBinary(): Promise<AtlasData> {
  const meta = await j<{
    n: number;
    sections: { name: string; dtype: string; offset: number; count: number }[];
  }>("/data/atlas.meta.json");
  const [buf, docHashes] = await Promise.all([
    fetch("/data/atlas.bin").then((r) => {
      if (!r.ok) throw new Error(`atlas.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
    j<string[]>("/data/doc_hashes.json"),
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
    docIdx: view("docIdx", Int32Array),
    chunkNum: view("chunkNum", Int32Array),
    docHashes,
  };
}

/** Rebuild a chunk's id (the form the query server indexes by). */
export function chunkIdOf(atlas: AtlasData, i: number): string {
  const d = atlas.docIdx[i];
  if (d < 0) return "";
  return `doc-${atlas.docHashes[d]}-chunk-${String(atlas.chunkNum[i]).padStart(3, "0")}`;
}

const CHUNK_ID_RE = /^doc-([0-9a-f]{32})-chunk-(\d+)$/;
/** Chunk-id lookups go through a numeric key rather than 445k interned strings:
 *  (docIdx, chunkNum) packs into one integer, which keeps the map ~10x smaller
 *  and avoids building the string table at all. */
export interface ChunkIndex {
  get(chunkId: string): number | undefined;
}

export function makeChunkIndex(atlas: AtlasData): ChunkIndex {
  const docOf = new Map<string, number>();
  atlas.docHashes.forEach((h, i) => docOf.set(h, i));
  const byKey = new Map<number, number>();
  for (let i = 0; i < atlas.n; i++) {
    const d = atlas.docIdx[i];
    if (d >= 0) byKey.set(d * 1_048_576 + atlas.chunkNum[i], i);
  }
  return {
    get(chunkId: string) {
      const m = CHUNK_ID_RE.exec(chunkId);
      if (!m) return undefined;
      const d = docOf.get(m[1]);
      if (d === undefined) return undefined;
      return byKey.get(d * 1_048_576 + Number(m[2]));
    },
  };
}

/** Core corpus bundle: chunk projections + papers + clusters + voids + heightmap. */
export function loadCorpus(): Promise<CorpusData> {
  corpusPromise ??= (async () => {
    const [atlas, papers, clusters, voids, hm] = await Promise.all([
      loadAtlasBinary(),
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

/** kNN graph over chunks, computed on GPU at the full 4096 dimensions.
 *  ~28 MB, so it is a separate binary the radio pulls only when switched on. */
export function loadKnn(): Promise<KnnGraph> {
  knnPromise ??= (async () => {
    const meta = await j<{
      n: number;
      k: number;
      sections: { name: string; offset: number; count: number }[];
    }>("/data/knn.meta.json");
    const buf = await fetch("/data/knn.bin").then((r) => {
      if (!r.ok) throw new Error(`knn.bin: ${r.status}`);
      return r.arrayBuffer();
    });
    const sec = (name: string) => {
      const x = meta.sections.find((y) => y.name === name);
      if (!x) throw new Error(`knn.bin: missing ${name}`);
      return x;
    };
    const i = sec("idx");
    const m = sec("sim");
    return {
      k: meta.k,
      idx: new Int32Array(buf, i.offset, i.count),
      sim: new Float32Array(buf, m.offset, m.count),
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
