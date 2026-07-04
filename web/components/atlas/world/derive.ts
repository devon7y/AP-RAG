"use client";

import * as THREE from "three";
import {
  ageColor,
  isGenericEntityName,
} from "@/components/atlas/observatory/derive";
import { WORLD_SIZE } from "@/lib/atlas/data";
import { CATEGORICAL, clusterColor, INK } from "@/lib/atlas/palette";
import type {
  AuthorRec,
  Cluster,
  Constellations,
  CorpusData,
} from "@/lib/atlas/types";
import { CHUNK_LIFT, GRID, HEIGHT_SCALE } from "./uniforms";

/**
 * Pure, once-per-session derivations for the world: every renderable gets TWO
 * coordinate frames — `ground` (the landscape: UMAP-2D × era-density terrain)
 * and `space` (the embedding cube, same frame as the Observatory) — so a single
 * uMorph uniform can unfold the map into the galaxy.
 *
 * Scale note: everything here is O(n) typed arrays + O(n·K) era splats; at the
 * full ~500k-chunk corpus move buildEraFields into a worker, keep the shapes.
 */

export interface WorldEntity {
  idx: number;
  id: string;
  type: string;
  desc: string;
  deg: number;
  nChunks: number;
  ground: THREE.Vector3;
  space: THREE.Vector3;
  color: string;
  members: number[];
  minYear: number;
  figureGround: Float32Array;
  figureSpace: Float32Array;
  radius: number;
}

export interface EraFields {
  /** knot years, ascending; last = newest */
  years: number[];
  texes: THREE.DataTexture[];
  /** final-era normalized density field (GRID²) for CPU height queries */
  final: Float32Array;
}

export interface WorldData {
  n: number;
  // chunks — attributes (per-instance)
  chunkGround: Float32Array; // xz on the map plane, y=0 (GPU samples height)
  chunkSpace: Float32Array;
  chunkGroundY: Float32Array; // CPU resting height (final era, incl. lift)
  chunkColorGround: Float32Array; // region tint
  chunkColorSpace: Float32Array; // stellar age tint
  chunkSize: Float32Array;
  chunkPhase: Float32Array;
  chunkYear: Float32Array;
  centrality: Float32Array;
  // papers
  nPapers: number;
  paperGround: Float32Array;
  paperSpace: Float32Array;
  paperGroundY: Float32Array;
  paperColorGround: Float32Array;
  paperColorSpace: Float32Array;
  paperSize: Float32Array;
  paperYear: Float32Array;
  paperCluster: Int16Array;
  // sky
  entities: WorldEntity[];
  starEntities: Map<number, number[]>;
  ambientFiguresGround: Float32Array;
  ambientFiguresSpace: Float32Array;
  webGround: Float32Array;
  webSpace: Float32Array;
  // fields
  eras: EraFields;
  colorTex: THREE.DataTexture;
  // meta
  yearMin: number;
  yearMax: number;
  chunkIdToIdx: Map<string, number>;
  clusterById: Map<number, Cluster>;
  labelClusters: { cluster: Cluster; ground: THREE.Vector3; space: THREE.Vector3 }[];
  labelPapers: number[];
  labelEntities: number[];
}

const AMBIENT_FIGURES = 24;
const WEB_EDGES = 150;

/* ---------------- small math helpers ---------------- */

export function toWorldXZ(x01: number, y01: number): [number, number] {
  return [(x01 - 0.5) * WORLD_SIZE, (y01 - 0.5) * WORLD_SIZE];
}

function spaceXYZ(pos3: ArrayLike<number>, i: number): [number, number, number] {
  return [
    (pos3[i * 3] - 0.5) * WORLD_SIZE,
    (pos3[i * 3 + 1] - 0.5) * WORLD_SIZE,
    (pos3[i * 3 + 2] - 0.5) * WORLD_SIZE,
  ];
}

/** Bilinear sample of a GRID² field at [0,1]² coords. */
export function sampleField(f: Float32Array, x01: number, y01: number): number {
  const fx = Math.min(Math.max(x01, 0), 0.999999) * (GRID - 1);
  const fy = Math.min(Math.max(y01, 0), 0.999999) * (GRID - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, GRID - 1);
  const y1 = Math.min(y0 + 1, GRID - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  return (
    (f[y0 * GRID + x0] * (1 - tx) + f[y0 * GRID + x1] * tx) * (1 - ty) +
    (f[y1 * GRID + x0] * (1 - tx) + f[y1 * GRID + x1] * tx) * ty
  );
}

function splat(f: Float32Array, x01: number, y01: number, w = 1): void {
  const fx = Math.min(Math.max(x01, 0), 0.999999) * (GRID - 1);
  const fy = Math.min(Math.max(y01, 0), 0.999999) * (GRID - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, GRID - 1);
  const y1 = Math.min(y0 + 1, GRID - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  f[y0 * GRID + x0] += w * (1 - tx) * (1 - ty);
  f[y0 * GRID + x1] += w * tx * (1 - ty);
  f[y1 * GRID + x0] += w * (1 - tx) * ty;
  f[y1 * GRID + x1] += w * tx * ty;
}

/** Separable gaussian blur (new array). */
function blur(src: Float32Array, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(r * 2 + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    ks += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= ks;

  const tmp = new Float32Array(GRID * GRID);
  const out = new Float32Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(GRID - 1, Math.max(0, x + i));
        s += src[y * GRID + xx] * k[i + r];
      }
      tmp[y * GRID + x] = s;
    }
  }
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(GRID - 1, Math.max(0, y + i));
        s += tmp[yy * GRID + x] * k[i + r];
      }
      out[y * GRID + x] = s;
    }
  }
  return out;
}

function densityField(raw: Float32Array): Float32Array {
  const a = blur(raw, 3);
  const b = blur(raw, 1);
  const out = new Float32Array(GRID * GRID);
  for (let i = 0; i < out.length; i++) out[i] = Math.log1p(a[i] + 0.35 * b[i]);
  return out;
}

function fieldTexture(data: Float32Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data, GRID, GRID, THREE.RedFormat, THREE.FloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

/* ---------------- era fields (the time machine's terrain) ---------------- */

function buildEraFields(corpus: CorpusData, yearMin: number, yearMax: number): EraFields {
  const { atlas } = corpus;
  const K = 12;
  // knot years at chunk-count quantiles → even *growth* per step, not even years
  const born: number[] = [];
  for (let i = 0; i < atlas.n; i++) if (atlas.year[i] > 0) born.push(atlas.year[i]);
  born.sort((a, b) => a - b);
  const knots: number[] = [];
  for (let q = 0; q < K; q++) {
    const y = born[Math.min(born.length - 1, Math.floor((q / (K - 1)) * (born.length - 1)))];
    if (!knots.length || y > knots[knots.length - 1]) knots.push(y);
  }
  if (knots[0] > yearMin) knots.unshift(yearMin);
  if (knots[knots.length - 1] < yearMax) knots.push(yearMax);

  const raws = knots.map(() => new Float32Array(GRID * GRID));
  for (let i = 0; i < atlas.n; i++) {
    const y = atlas.year[i];
    const x01 = atlas.pos2[i * 2];
    const y01 = atlas.pos2[i * 2 + 1];
    for (let kI = 0; kI < knots.length; kI++) {
      if (y === 0 || y <= knots[kI]) splat(raws[kI], x01, y01);
    }
  }
  const fields = raws.map(densityField);
  const finalField = fields[fields.length - 1];
  let max = 0;
  for (let i = 0; i < finalField.length; i++) max = Math.max(max, finalField[i]);
  const inv = max > 0 ? 1 / max : 1;
  for (const f of fields) for (let i = 0; i < f.length; i++) f[i] *= inv;

  return { years: knots, texes: fields.map(fieldTexture), final: finalField };
}

/* ---------------- terrain tint field ---------------- */

function buildColorTexture(corpus: CorpusData): THREE.DataTexture {
  const { atlas } = corpus;
  const r = new Float32Array(GRID * GRID);
  const g = new Float32Array(GRID * GRID);
  const b = new Float32Array(GRID * GRID);
  const w = new Float32Array(GRID * GRID);
  const c = new THREE.Color();
  for (let i = 0; i < atlas.n; i++) {
    c.set(clusterColor(atlas.cluster[i]));
    const x01 = atlas.pos2[i * 2];
    const y01 = atlas.pos2[i * 2 + 1];
    splat(r, x01, y01, c.r);
    splat(g, x01, y01, c.g);
    splat(b, x01, y01, c.b);
    splat(w, x01, y01, 1);
  }
  const rb = blur(r, 2.2);
  const gb = blur(g, 2.2);
  const bb = blur(b, 2.2);
  const wb = blur(w, 2.2);
  const data = new Float32Array(GRID * GRID * 4);
  const fallback = new THREE.Color(INK.grid);
  for (let i = 0; i < GRID * GRID; i++) {
    const ww = wb[i];
    if (ww > 1e-4) {
      data[i * 4] = rb[i] / ww;
      data[i * 4 + 1] = gb[i] / ww;
      data[i * 4 + 2] = bb[i] / ww;
    } else {
      data[i * 4] = fallback.r;
      data[i * 4 + 1] = fallback.g;
      data[i * 4 + 2] = fallback.b;
    }
    data[i * 4 + 3] = 1;
  }
  const t = new THREE.DataTexture(data, GRID, GRID, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/* ---------------- constellation figures ---------------- */

function buildFigure(
  anchor: THREE.Vector3,
  members: number[],
  posOf: (m: number, out: THREE.Vector3) => void,
): Float32Array {
  if (members.length < 2) return new Float32Array(0);
  const pts = members.map((m) => {
    const v = new THREE.Vector3();
    posOf(m, v);
    return v;
  });
  const visited = new Array(pts.length).fill(false);
  let cur = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i++) {
    const d = pts[i].distanceToSquared(anchor);
    if (d < best) {
      best = d;
      cur = i;
    }
  }
  visited[cur] = true;
  const order = [cur];
  for (let step = 1; step < pts.length; step++) {
    let next = -1;
    let bd = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pts.length; i++) {
      if (visited[i]) continue;
      const d = pts[i].distanceToSquared(pts[cur]);
      if (d < bd) {
        bd = d;
        next = i;
      }
    }
    if (next === -1) break;
    visited[next] = true;
    order.push(next);
    cur = next;
  }
  const seg = new Float32Array((order.length - 1) * 6);
  for (let i = 0; i < order.length - 1; i++) {
    const a = pts[order[i]];
    const b = pts[order[i + 1]];
    seg.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
  }
  return seg;
}

/** Sky altitude band by entity type — abstraction floats higher. */
const TYPE_ALT: Record<string, number> = {
  theory: 9,
  concept: 7,
  author: 6,
  method: 5,
  experiment: 4.5,
  dataset: 3.5,
  publication: 3,
  institution: 2,
};

/* ---------------- the main derivation ---------------- */

export function deriveWorld(
  corpus: CorpusData,
  constellations: Constellations,
): WorldData {
  const { atlas, papers, clusters } = corpus;
  const n = atlas.n;

  // --- year range (0 = unknown) ---
  let yearMin = Number.POSITIVE_INFINITY;
  let yearMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const y = atlas.year[i];
    if (y > 0) {
      if (y < yearMin) yearMin = y;
      if (y > yearMax) yearMax = y;
    }
  }
  if (!Number.isFinite(yearMin)) {
    yearMin = 1950;
    yearMax = 2026;
  }
  const span = Math.max(1, yearMax - yearMin);

  const eras = buildEraFields(corpus, yearMin, yearMax);
  const colorTex = buildColorTexture(corpus);

  // --- KG centrality per chunk (drives brightness in both frames) ---
  const sorted = [...constellations.entities].sort((a, b) => b.deg - a.deg);
  const acc = new Float32Array(n);
  const starEntities = new Map<number, number[]>();
  sorted.forEach((e, idx) => {
    for (const m of new Set(e.chunkIdx)) {
      if (m < 0 || m >= n) continue;
      acc[m] += e.deg;
      const list = starEntities.get(m);
      if (list) list.push(idx);
      else starEntities.set(m, [idx]);
    }
  });
  let maxAcc = 0;
  for (let i = 0; i < n; i++) maxAcc = Math.max(maxAcc, acc[i]);
  const logMax = Math.log1p(maxAcc) || 1;
  const centrality = new Float32Array(n);
  for (let i = 0; i < n; i++) centrality[i] = Math.log1p(acc[i]) / logMax;

  // --- chunk buffers ---
  const chunkGround = new Float32Array(n * 3);
  const chunkSpace = new Float32Array(n * 3);
  const chunkGroundY = new Float32Array(n);
  const chunkColorGround = new Float32Array(n * 3);
  const chunkColorSpace = new Float32Array(n * 3);
  const chunkSize = new Float32Array(n);
  const chunkPhase = new Float32Array(n);
  const chunkYear = new Float32Array(n);
  const c = new THREE.Color();
  const cAge = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const x01 = atlas.pos2[i * 2];
    const y01 = atlas.pos2[i * 2 + 1];
    const [wx, wz] = toWorldXZ(x01, y01);
    chunkGround[i * 3] = wx;
    chunkGround[i * 3 + 1] = 0;
    chunkGround[i * 3 + 2] = wz;
    chunkGroundY[i] = sampleField(eras.final, x01, y01) * HEIGHT_SCALE + CHUNK_LIFT;
    const [sx, sy, sz] = spaceXYZ(atlas.pos3, i);
    chunkSpace[i * 3] = sx;
    chunkSpace[i * 3 + 1] = sy;
    chunkSpace[i * 3 + 2] = sz;

    const lum = 0.3 + 0.7 * Math.pow(centrality[i], 0.8);
    c.set(clusterColor(atlas.cluster[i]));
    chunkColorGround[i * 3] = c.r * lum;
    chunkColorGround[i * 3 + 1] = c.g * lum;
    chunkColorGround[i * 3 + 2] = c.b * lum;
    const y = atlas.year[i];
    if (y > 0) ageColor((y - yearMin) / span, cAge);
    else cAge.set(INK.muted);
    chunkColorSpace[i * 3] = cAge.r * lum;
    chunkColorSpace[i * 3 + 1] = cAge.g * lum;
    chunkColorSpace[i * 3 + 2] = cAge.b * lum;

    chunkSize[i] = 0.5 + 2.0 * Math.pow(centrality[i], 0.75);
    chunkPhase[i] = ((i * 0.6180339887) % 1) * Math.PI * 2;
    chunkYear[i] = y;
  }

  // --- paper buffers ---
  const nPapers = papers.length;
  const paperGround = new Float32Array(nPapers * 3);
  const paperSpace = new Float32Array(nPapers * 3);
  const paperGroundY = new Float32Array(nPapers);
  const paperColorGround = new Float32Array(nPapers * 3);
  const paperColorSpace = new Float32Array(nPapers * 3);
  const paperSize = new Float32Array(nPapers);
  const paperYear = new Float32Array(nPapers);
  const paperCluster = new Int16Array(nPapers);

  // majority cluster per paper
  const counts = new Map<number, Map<number, number>>();
  for (let i = 0; i < n; i++) {
    const p = atlas.paper[i];
    let m = counts.get(p);
    if (!m) {
      m = new Map();
      counts.set(p, m);
    }
    m.set(atlas.cluster[i], (m.get(atlas.cluster[i]) ?? 0) + 1);
  }
  let maxChunks = 1;
  for (const p of papers) maxChunks = Math.max(maxChunks, p.nChunks);

  papers.forEach((p, i) => {
    const [wx, wz] = toWorldXZ(p.centroid[0], p.centroid[1]);
    paperGround[i * 3] = wx;
    paperGround[i * 3 + 1] = 0;
    paperGround[i * 3 + 2] = wz;
    paperGroundY[i] =
      sampleField(eras.final, p.centroid[0], p.centroid[1]) * HEIGHT_SCALE + CHUNK_LIFT;
    paperSpace[i * 3] = (p.centroid3[0] - 0.5) * WORLD_SIZE;
    paperSpace[i * 3 + 1] = (p.centroid3[1] - 0.5) * WORLD_SIZE;
    paperSpace[i * 3 + 2] = (p.centroid3[2] - 0.5) * WORLD_SIZE;

    let bestCl = 0;
    let bestCt = -1;
    for (const [cl, ct] of counts.get(i) ?? []) {
      if (ct > bestCt) {
        bestCt = ct;
        bestCl = cl;
      }
    }
    paperCluster[i] = bestCl;
    const lum = 0.55 + 0.45 * (Math.log1p(p.nChunks) / Math.log1p(maxChunks));
    c.set(clusterColor(bestCl));
    paperColorGround[i * 3] = c.r * lum;
    paperColorGround[i * 3 + 1] = c.g * lum;
    paperColorGround[i * 3 + 2] = c.b * lum;
    if (p.year > 0) ageColor((p.year - yearMin) / span, cAge);
    else cAge.set(INK.muted);
    paperColorSpace[i * 3] = cAge.r * lum;
    paperColorSpace[i * 3 + 1] = cAge.g * lum;
    paperColorSpace[i * 3 + 2] = cAge.b * lum;
    paperSize[i] = 1.15 + 1.35 * (Math.log1p(p.nChunks) / Math.log1p(maxChunks));
    paperYear[i] = p.year;
  });

  // --- entities (the sky) ---
  const maxDeg = sorted.length ? sorted[0].deg : 1;
  const groundOf = (m: number, out: THREE.Vector3) =>
    out.set(chunkGround[m * 3], chunkGroundY[m], chunkGround[m * 3 + 2]);
  const spaceOf = (m: number, out: THREE.Vector3) =>
    out.set(chunkSpace[m * 3], chunkSpace[m * 3 + 1], chunkSpace[m * 3 + 2]);

  const entities: WorldEntity[] = sorted.map((e, idx) => {
    const members = [...new Set(e.chunkIdx)].filter((m) => m >= 0 && m < n);
    const [ax, az] = toWorldXZ(e.pos2[0], e.pos2[1]);
    const degNorm = Math.log1p(e.deg) / Math.log1p(maxDeg);
    const jitter = (((idx * 0.7548776662) % 1) - 0.5) * 3;
    const alt =
      HEIGHT_SCALE +
      4 +
      (TYPE_ALT[e.type.toLowerCase()] ?? 4) +
      9 * degNorm +
      jitter;
    const ground = new THREE.Vector3(ax, alt, az);
    const space = new THREE.Vector3(...spaceXYZ([e.pos3[0], e.pos3[1], e.pos3[2]], 0));

    let minYear = 0;
    for (const m of members) {
      const y = atlas.year[m];
      if (y > 0 && (minYear === 0 || y < minYear)) minYear = y;
    }
    let radius = 0;
    const tmp = new THREE.Vector3();
    for (const m of members) {
      spaceOf(m, tmp);
      radius = Math.max(radius, tmp.distanceTo(space));
    }
    return {
      idx,
      id: e.id,
      type: e.type,
      desc: e.desc,
      deg: e.deg,
      nChunks: e.nChunks,
      ground,
      space,
      color: entityColor(e.type),
      members,
      minYear,
      figureGround: buildFigure(ground, members, groundOf),
      figureSpace: buildFigure(space, members, spaceOf),
      radius,
    };
  });

  // ambient constellation figures: compact ones only
  const figureSources = entities
    .filter((e) => e.members.length >= 3 && e.radius < 16)
    .slice(0, AMBIENT_FIGURES);
  const concat = (key: "figureGround" | "figureSpace") => {
    let len = 0;
    for (const e of figureSources) len += e[key].length;
    const out = new Float32Array(len);
    let off = 0;
    for (const e of figureSources) {
      out.set(e[key], off);
      off += e[key].length;
    }
    return out;
  };
  const ambientFiguresGround = concat("figureGround");
  const ambientFiguresSpace = concat("figureSpace");

  // entity–entity web
  const idxById = new Map(entities.map((e) => [e.id, e.idx]));
  const resolved: { a: number; b: number; w: number }[] = [];
  const seen = new Set<string>();
  for (const edge of constellations.edges) {
    const a = idxById.get(edge.s);
    const b = idxById.get(edge.t);
    if (a === undefined || b === undefined || a === b) continue;
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    resolved.push({ a, b, w: edge.w });
  }
  resolved.sort((x, y) => y.w - x.w);
  const top = resolved.slice(0, WEB_EDGES);
  const webGround = new Float32Array(top.length * 6);
  const webSpace = new Float32Array(top.length * 6);
  top.forEach((e, i) => {
    const ga = entities[e.a].ground;
    const gb = entities[e.b].ground;
    webGround.set([ga.x, ga.y, ga.z, gb.x, gb.y, gb.z], i * 6);
    const sa = entities[e.a].space;
    const sb = entities[e.b].space;
    webSpace.set([sa.x, sa.y, sa.z, sb.x, sb.y, sb.z], i * 6);
  });

  // --- lookups + labels ---
  const chunkIdToIdx = new Map<string, number>();
  for (let i = 0; i < n; i++) chunkIdToIdx.set(atlas.chunkId[i], i);
  const clusterById = new Map(clusters.map((cl) => [cl.id, cl]));

  const labelClusters = clusters
    .filter((cl) => cl.name)
    .map((cl) => ({
      cluster: cl,
      ground: new THREE.Vector3(
        ...(() => {
          const [x, z] = toWorldXZ(cl.center[0], cl.center[1]);
          return [x, sampleField(eras.final, cl.center[0], cl.center[1]) * HEIGHT_SCALE + 3.2, z];
        })(),
      ),
      space: new THREE.Vector3(
        (cl.center3[0] - 0.5) * WORLD_SIZE,
        (cl.center3[1] - 0.5) * WORLD_SIZE,
        (cl.center3[2] - 0.5) * WORLD_SIZE,
      ),
    }));

  const labelPapers = papers
    .map((p, i) => ({ i, s: p.nChunks }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 18)
    .map((x) => x.i);

  const labelEntities = entities
    .filter((e) => !isGenericEntityName(e.id))
    .slice(0, 16)
    .map((e) => e.idx);

  return {
    n,
    chunkGround,
    chunkSpace,
    chunkGroundY,
    chunkColorGround,
    chunkColorSpace,
    chunkSize,
    chunkPhase,
    chunkYear,
    centrality,
    nPapers,
    paperGround,
    paperSpace,
    paperGroundY,
    paperColorGround,
    paperColorSpace,
    paperSize,
    paperYear,
    paperCluster,
    entities,
    starEntities,
    ambientFiguresGround,
    ambientFiguresSpace,
    webGround,
    webSpace,
    eras,
    colorTex,
    yearMin,
    yearMax,
    chunkIdToIdx,
    clusterById,
    labelClusters,
    labelPapers,
    labelEntities,
  };
}

/* ---------------- shared cosmetics ---------------- */

const ENTITY_TYPE_COLORS: Record<string, string> = {
  concept: CATEGORICAL[0],
  method: CATEGORICAL[1],
  dataset: CATEGORICAL[2],
  experiment: CATEGORICAL[3],
  publication: CATEGORICAL[4],
  theory: CATEGORICAL[5],
  author: CATEGORICAL[6],
  institution: CATEGORICAL[7],
};

export function entityColor(type: string): string {
  return ENTITY_TYPE_COLORS[type.toLowerCase()] ?? INK.muted;
}

/** "Balota et al. (2007)"-style short cite. */
export function shortCite(p: { authors: string; year: number } | undefined): string {
  if (!p) return "Unknown paper";
  const first = p.authors.split(/[;,&]/)[0]?.trim() || "Unknown";
  const etAl = /[;,&]| et al/.test(p.authors) ? " et al." : "";
  return `${first}${etAl}${p.year ? ` (${p.year})` : ""}`;
}

/** Soft radial glow sprite texture (module-cached, browser only). */
let glowTex: THREE.CanvasTexture | null = null;
export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.25, "rgba(255,255,255,0.34)");
  g.addColorStop(0.6, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTex = new THREE.CanvasTexture(canvas);
  return glowTex;
}

let ringTex: THREE.CanvasTexture | null = null;
export function ringTexture(): THREE.CanvasTexture {
  if (ringTex) return ringTex;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  ctx.stroke();
  ringTex = new THREE.CanvasTexture(canvas);
  return ringTex;
}

/** Author oeuvre anchor in both frames (mean of paper anchors). */
export function authorAnchors(
  a: AuthorRec,
  data: WorldData,
): { ground: THREE.Vector3; space: THREE.Vector3 } {
  const ground = new THREE.Vector3();
  const space = new THREE.Vector3();
  for (const p of a.papers) {
    ground.x += data.paperGround[p * 3];
    ground.y += data.paperGroundY[p];
    ground.z += data.paperGround[p * 3 + 2];
    space.x += data.paperSpace[p * 3];
    space.y += data.paperSpace[p * 3 + 1];
    space.z += data.paperSpace[p * 3 + 2];
  }
  ground.divideScalar(a.papers.length || 1);
  space.divideScalar(a.papers.length || 1);
  return { ground, space };
}
