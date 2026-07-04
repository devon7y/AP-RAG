"use client";

import type { QSearchHit } from "@/lib/atlas/api";
import { neighborsOf } from "@/lib/atlas/data";
import type { AtlasData, KnnGraph } from "@/lib/atlas/types";

/**
 * Pure walk logic for the radio rover: a slow, temperature-sampled random walk
 * over the chunk kNN graph, optionally biased toward/away from a tuned station.
 * (Moved from the retired standalone radio experience.)
 */

/** A tuned topic the drift can lean toward. */
export interface Station {
  query: string;
  /** score-weighted centroid of the topic's top hits, map coords [0,1]² */
  centroid: [number, number];
  /** atlas index → normalized hit score (0.3..1) for the topic's top chunks */
  hits: Map<number, number>;
  /** strongest matching atlas index (walk start when tuned before power-on) */
  topIdx: number | null;
}

/** Gaussian falloff radius (map units) for station signal strength. */
const SIGNAL_SIGMA = 0.16;

function dist2d(atlas: AtlasData, i: number, cx: number, cy: number): number {
  return Math.hypot(atlas.pos2[i * 2] - cx, atlas.pos2[i * 2 + 1] - cy);
}

/**
 * Sample the next chunk among the current node's kNN neighbors.
 * Score = semantic coherence (edge cosine) − backtrack/revisit penalties
 *       ± dial bias (directional progress toward the station + hit bonus),
 * then softmax-sampled so the drift stays wandering, never greedy.
 */
export function chooseNext(
  knn: KnnGraph,
  atlas: AtlasData,
  current: number,
  prev: number | null,
  trail: number[],
  station: Station | null,
  bias: number,
): number {
  const cands = neighborsOf(knn, current);
  const recent = new Map<number, number>();
  for (let i = 0; i < trail.length; i++) recent.set(trail[i], trail.length - 1 - i);

  const tuned = station !== null && bias !== 0;
  const cx = station?.centroid[0] ?? 0;
  const cy = station?.centroid[1] ?? 0;
  const dNow = tuned ? dist2d(atlas, current, cx, cy) : 0;

  const deltas: number[] = [];
  let maxAbs = 1e-6;
  const base = cands.map(({ idx, sim }) => {
    let s = 2.4 * sim;
    if (idx === current) s -= 4;
    if (prev !== null && idx === prev) s -= 1.7;
    const age = recent.get(idx);
    if (age !== undefined) s -= 1.25 * Math.exp(-age / 14);
    if (tuned) {
      const del = dNow - dist2d(atlas, idx, cx, cy); // >0 means progress toward
      deltas.push(del);
      maxAbs = Math.max(maxAbs, Math.abs(del));
    } else {
      deltas.push(0);
    }
    return s;
  });

  const T = 0.5; // sampling temperature: lower = more decisive drift
  const scored = base.map((s, i) => {
    let v = s;
    if (tuned) {
      v += bias * 2.7 * (deltas[i] / maxAbs);
      const hit = station.hits.get(cands[i].idx);
      if (hit !== undefined) v += bias * 1.6 * hit;
    }
    return v / T;
  });

  const m = Math.max(...scored);
  const exps = scored.map((v) => Math.exp(v - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < cands.length; i++) {
    r -= exps[i];
    if (r <= 0) return cands[i].idx;
  }
  return cands[cands.length - 1].idx;
}

/** Resolve qsearch hits against the atlas into a Station (null if too few land). */
export function buildStation(
  query: string,
  hits: QSearchHit[],
  chunkIndex: Map<string, number>,
  atlas: AtlasData,
): Station | null {
  const matched: { idx: number; score: number }[] = [];
  for (const h of hits) {
    const idx = chunkIndex.get(h.chunkId);
    if (idx !== undefined) matched.push({ idx, score: h.score });
  }
  if (matched.length < 3) return null;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const m of matched) {
    min = Math.min(min, m.score);
    max = Math.max(max, m.score);
  }
  const span = max - min || 1;

  const hitMap = new Map<number, number>();
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  let topIdx: number | null = null;
  let topScore = Number.NEGATIVE_INFINITY;
  for (const m of matched) {
    const norm = 0.3 + 0.7 * ((m.score - min) / span);
    hitMap.set(m.idx, Math.max(hitMap.get(m.idx) ?? 0, norm));
    const w = norm * norm;
    wx += atlas.pos2[m.idx * 2] * w;
    wy += atlas.pos2[m.idx * 2 + 1] * w;
    wsum += w;
    if (m.score > topScore) {
      topScore = m.score;
      topIdx = m.idx;
    }
  }
  return {
    query,
    centroid: [wx / wsum, wy / wsum],
    hits: hitMap,
    topIdx,
  };
}

/** Station affinity at a chunk: spatial falloff to the centroid + direct hit score. */
export function computeSignal(
  atlas: AtlasData,
  idx: number,
  station: Station | null,
): number {
  if (!station) return 0;
  const d = dist2d(atlas, idx, station.centroid[0], station.centroid[1]);
  const g = Math.exp(-((d / SIGNAL_SIGMA) ** 2));
  const h = station.hits.get(idx) ?? 0;
  return Math.min(1, 0.62 * g + 0.5 * h);
}

const ABBREV =
  /(?:\b(?:e\.g|i\.e|et al|cf|vs|viz|Fig|Figs|Eq|Eqs|No|Nos|approx|ca|pp|p|Dr|Mr|Mrs|Ms|Prof|St|Jr|Sr|Vol|Ch|sec|Sect)\.|\b[A-Z]\.)$/;

/**
 * Split chunk text into speakable "lyric lines". Handles PDF hyphenation and
 * whitespace, merges abbreviation fragments, hard-splits anything too long
 * for reliable TTS.
 */
export function splitSentences(raw: string): string[] {
  const text = raw
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, " ")
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];

  const pieces = text.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)/g) ?? [text];
  const merged: string[] = [];
  for (const p of pieces) {
    const t = p.trim();
    if (!t) continue;
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      (ABBREV.test(last) || t.length < 35 || /^[a-z0-9)]/.test(t))
    ) {
      merged[merged.length - 1] = `${last} ${t}`;
    } else {
      merged.push(t);
    }
  }

  const out: string[] = [];
  for (const s of merged) {
    let rest = s;
    while (rest.length > 320) {
      const window = rest.slice(180, 320);
      const cut = window.lastIndexOf(" ");
      const at = cut === -1 ? 320 : 180 + cut;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** Silent-mode dwell per sentence: roughly human reading pace. */
export function readMs(sentence: string): number {
  const words = sentence.split(/\s+/).length;
  return Math.min(15000, Math.max(2400, 950 + words * 345));
}
