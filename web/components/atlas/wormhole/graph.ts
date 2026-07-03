"use client";

/**
 * Wormhole race graph utilities.
 *
 * The playable graph is the SYMMETRIZED kNN graph: you can hop i→j whenever
 * j is a nearest neighbor of i OR i is a nearest neighbor of j. Symmetrizing
 * guarantees you can always retreat the way you came (no one-way doors), and
 * BFS over this exact graph gives an honest "par" — the minimum number of
 * hops the UI actually allows.
 */

import type { CorpusData, KnnGraph } from "@/lib/atlas/types";

export interface HopEdge {
  /** neighbor chunk index */
  j: number;
  /** cosine similarity along this edge */
  sim: number;
}

export interface WormholeGraph {
  n: number;
  /** per-chunk edges, sorted by similarity descending */
  adj: HopEdge[][];
}

const graphCache = new WeakMap<KnnGraph, WormholeGraph>();

export function buildGraph(knn: KnnGraph): WormholeGraph {
  const hit = graphCache.get(knn);
  if (hit) return hit;

  const n = Math.floor(knn.idx.length / knn.k);
  const maps: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < knn.k; s++) {
      const j = knn.idx[i * knn.k + s];
      const sim = knn.sim[i * knn.k + s];
      if (j === i || j < 0 || j >= n) continue;
      const a = maps[i].get(j);
      if (a === undefined || sim > a) maps[i].set(j, sim);
      const b = maps[j].get(i);
      if (b === undefined || sim > b) maps[j].set(i, sim);
    }
  }
  const adj = maps.map((m) => {
    const edges: HopEdge[] = [];
    m.forEach((sim, j) => edges.push({ j, sim }));
    edges.sort((a, b) => b.sim - a.sim);
    return edges;
  });

  const graph: WormholeGraph = { n, adj };
  graphCache.set(knn, graph);
  return graph;
}

/** BFS hop distances from `start`; -1 = unreachable. */
export function bfsDistances(graph: WormholeGraph, start: number): Int32Array {
  const dist = new Int32Array(graph.n).fill(-1);
  const queue = new Int32Array(graph.n);
  let head = 0;
  let tail = 0;
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const u = queue[head++];
    for (const e of graph.adj[u]) {
      if (dist[e.j] === -1) {
        dist[e.j] = dist[u] + 1;
        queue[tail++] = e.j;
      }
    }
  }
  return dist;
}

const byPaperCache = new WeakMap<CorpusData, number[][]>();

/** Chunk indices grouped by paper index. */
export function chunksByPaper(corpus: CorpusData): number[][] {
  const hit = byPaperCache.get(corpus);
  if (hit) return hit;
  const groups: number[][] = corpus.papers.map(() => []);
  const { atlas } = corpus;
  for (let i = 0; i < atlas.n; i++) {
    const p = atlas.paper[i];
    if (p >= 0 && p < groups.length) groups[p].push(i);
  }
  byPaperCache.set(corpus, groups);
  return groups;
}

export interface WormholePair {
  startChunk: number;
  startPaper: number;
  targetPaper: number;
  /** minimum achievable hops (BFS over the playable graph) */
  par: number;
  /** map-space distance between the two paper centroids, in [0,1]² units */
  mapDist: number;
}

function tryPick(
  corpus: CorpusData,
  graph: WormholeGraph,
  attempts: number,
  parMin: number,
  parMax: number,
  minMap: number,
): WormholePair | null {
  const { atlas, papers } = corpus;
  const byPaper = chunksByPaper(corpus);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const a = Math.floor(Math.random() * papers.length);
    const chunksA = byPaper[a];
    if (!chunksA || chunksA.length === 0) continue;

    // Start from paper A's most central chunk (closest to its centroid).
    const [cx, cy] = papers[a].centroid;
    let startChunk = chunksA[0];
    let bestD = Infinity;
    for (const c of chunksA) {
      const dx = atlas.pos2[c * 2] - cx;
      const dy = atlas.pos2[c * 2 + 1] - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        startChunk = c;
      }
    }

    const dist = bfsDistances(graph, startChunk);
    const candidates: WormholePair[] = [];
    for (let p = 0; p < papers.length; p++) {
      if (p === a) continue;
      const chunksP = byPaper[p];
      if (!chunksP || chunksP.length === 0) continue;
      let minD = Infinity;
      for (const c of chunksP) {
        const d = dist[c];
        if (d >= 0 && d < minD) minD = d;
      }
      if (minD < parMin || minD > parMax) continue;
      const dx = papers[p].centroid[0] - cx;
      const dy = papers[p].centroid[1] - cy;
      const mapDist = Math.hypot(dx, dy);
      if (mapDist < minMap) continue;
      candidates.push({ startChunk, startPaper: a, targetPaper: p, par: minD, mapDist });
    }
    if (candidates.length > 0) {
      // Favor genuinely opposite ends: draw from the farthest quartile.
      candidates.sort((x, y) => y.mapDist - x.mapDist);
      const top = candidates.slice(0, Math.max(1, Math.ceil(candidates.length / 4)));
      return top[Math.floor(Math.random() * top.length)];
    }
  }
  return null;
}

/** Draw a racing pair: far apart on the map, reachable in a playable number of hops. */
export function pickPair(corpus: CorpusData, graph: WormholeGraph): WormholePair | null {
  return (
    tryPick(corpus, graph, 24, 5, 11, 0.45) ??
    tryPick(corpus, graph, 16, 4, 14, 0.3) ??
    tryPick(corpus, graph, 8, 3, 40, 0)
  );
}

/** Ordered, deduplicated region (cluster) names a path travels through. */
export function routeClusterNames(path: number[], corpus: CorpusData): string[] {
  const names: string[] = [];
  let lastCluster = -2;
  for (const c of path) {
    const cl = corpus.atlas.cluster[c];
    if (cl === lastCluster) continue;
    lastCluster = cl;
    const name = cl >= 0 ? corpus.clusters[cl]?.name : undefined;
    if (name && names[names.length - 1] !== name) names.push(name);
  }
  return names;
}

/** Total semantic drift of a run: Σ (1 − sim) over traversed edges. */
export function pathCost(sims: number[]): number {
  let total = 0;
  for (const s of sims) total += 1 - s;
  return total;
}

/** "Surname et al. (year)" style short label for a paper. */
export function shortPaperLabel(corpus: CorpusData, paperIdx: number): string {
  const p = corpus.papers[paperIdx];
  if (!p) return "unknown paper";
  const first = p.authors.split(/[,;&]/)[0]?.trim() || p.title;
  const etAl = /[,;&]/.test(p.authors) ? " et al." : "";
  return `${first}${etAl}${p.year ? ` (${p.year})` : ""}`;
}
