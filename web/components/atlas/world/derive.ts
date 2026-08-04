"use client";

import * as THREE from "three";
import { WORLD_SIZE } from "@/lib/atlas/data";
import { CATEGORICAL, clusterColor, INK } from "@/lib/atlas/palette";
import type {
  AuthorRec,
  Cluster,
  Constellations,
  CorpusData,
  PaperMeta,
} from "@/lib/atlas/types";
import { makeChunkIndex, type ChunkIndex } from "@/lib/atlas/data";
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

/** A named summit on the landscape. Names are a tiered fallback until the
 *  LLM naming pass ships: dominant paper → best KG entity → cluster terms. */
export interface PeakLabel {
  pos: THREE.Vector3; // summit, ground frame
  label: string;
  kind: "paper" | "entity" | "terms";
  paperIdx: number; // -1 unless kind === "paper"
  entityIdx: number; // -1 unless kind === "entity"
  /** prominence order, 0 = tallest — drives label LOD */
  rank: number;
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
  /** clearance above the surface along its NORMAL, so a beacon on a hillside
   *  stands clear of the slope instead of cutting into it */
  paperLift: Float32Array;
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
  peaks: PeakLabel[];
  // meta
  yearMin: number;
  yearMax: number;
  chunkIdToIdx: ChunkIndex;
  clusterById: Map<number, Cluster>;
  labelClusters: {
    cluster: Cluster;
    /** earliest paper in the region — the time machine hides it until then */
    firstYear: number;
    ground: THREE.Vector3;
    space: THREE.Vector3;
  }[];
  labelPapers: number[];
  /** lowercased title+abstract+keywords+subjects per paper. The keyword lens
   *  runs on every keystroke; at 10k papers rebuilding these strings each time
   *  is what makes typing lag, so they are built once here. */
  paperHaystack: string[];
  labelEntities: number[];
}

const AMBIENT_FIGURES = 24;
const WEB_EDGES = 150;

/* ---------------- age ramp + name filters (from the retired observatory) --- */

/** Age ramp poles (diverging warm↔cool through a warm white, like star temperature). */
export const AGE_OLD = "#e66767";
export const AGE_MID = "#f2e5cf";
export const AGE_NEW = "#9ec5f4";

const OLD_C = new THREE.Color(AGE_OLD);
const MID_C = new THREE.Color(AGE_MID);
const NEW_C = new THREE.Color(AGE_NEW);

/** t=0 oldest → t=1 newest. */
export function ageColor(t: number, out = new THREE.Color()): THREE.Color {
  const x = Math.min(1, Math.max(0, t));
  if (x < 0.5) return out.copy(OLD_C).lerp(MID_C, x * 2);
  return out.copy(MID_C).lerp(NEW_C, (x - 0.5) * 2);
}

/** Paper-furniture entity names (Table 3, Study 1…) — noise as sky labels. */
const GENERIC_ID =
  /^(table|figure|fig|study|experiment|exp|appendix|equation|section|chapter|participants?|stimuli|procedure|methods?|results?|discussion|introduction|abstract|model|step|phase|task|item|block)\.?\s*\d*[a-z]?$/i;

export function isGenericEntityName(id: string): boolean {
  return GENERIC_ID.test(id.trim());
}

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

function buildEraFields(
  posX: Float32Array,
  posY: Float32Array,
  date: Float32Array,
  yearMin: number,
  yearMax: number,
): EraFields {
  const count = date.length;
  const K = 14;
  // knot dates at chunk-count quantiles → even *growth* per step, not even
  // years (fractional dates give month-level knots where the corpus is dense)
  const born: number[] = [];
  for (let i = 0; i < count; i++) if (date[i] > 0) born.push(date[i]);
  born.sort((a, b) => a - b);
  const knots: number[] = [];
  for (let q = 0; q < K; q++) {
    const y = born[Math.min(born.length - 1, Math.floor((q / (K - 1)) * (born.length - 1)))];
    if (!knots.length || y > knots[knots.length - 1] + 1e-4) knots.push(y);
  }
  if (knots[0] > yearMin) knots.unshift(yearMin);
  if (knots[knots.length - 1] < yearMax + 1) knots.push(yearMax + 1);

  const raws = knots.map(() => new Float32Array(GRID * GRID));
  for (let i = 0; i < count; i++) {
    const y = date[i];
    const x01 = posX[i];
    const y01 = posY[i];
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

/** Terrain tint = PUBLICATION DATE of the papers on that ground.
 *
 *  It used to be cluster identity, but there are 75 clusters and no categorical
 *  palette has 75 distinguishable hues — so colours repeated and two unrelated
 *  regions on opposite sides of the map read as kin. Date is continuous, needs
 *  no legend to interpret, and is the SAME encoding the galaxy view uses, so
 *  morphing between the two no longer recolours the world for no visible reason.
 *
 *  Dates go through the same rank transform as the stars: the corpus spans
 *  1904-2026 and a linear ramp would spend most of its range on a handful of
 *  very old outliers.
 */
function buildColorTexture(
  posX: Float32Array,
  posY: Float32Array,
  ageRank: Float32Array,
): THREE.DataTexture {
  const acc = new Float32Array(GRID * GRID);
  const w = new Float32Array(GRID * GRID);
  for (let i = 0; i < posX.length; i++) {
    if (ageRank[i] < 0) continue; // undated papers tint nothing
    splat(acc, posX[i], posY[i], ageRank[i]);
    splat(w, posX[i], posY[i], 1);
  }
  const ab = blur(acc, 2.6);
  const wb = blur(w, 2.6);
  const data = new Float32Array(GRID * GRID * 4);
  const fallback = new THREE.Color(INK.grid);
  const c = new THREE.Color();
  for (let i = 0; i < GRID * GRID; i++) {
    if (wb[i] > 1e-4) {
      ageColor(ab[i] / wb[i], c);
      data[i * 4] = c.r;
      data[i * 4 + 1] = c.g;
      data[i * 4 + 2] = c.b;
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

/* ---------------- peak naming (fallback until the LLM naming pass) -------- */

/** Local maxima of the density field, tallest-first with non-max suppression
 *  (a cheap prominence proxy). Radius in [0,1]² map units. */
function detectPeaks(
  field: Float32Array,
  minH = 0.12,
  // spacing is in map units: at full corpus the old 0.055 packed dozens of
  // summits close enough that their labels overlapped into noise
  radius01 = 0.105,
  cap = 22,
): { x01: number; y01: number; h: number }[] {
  const raw: { x01: number; y01: number; h: number }[] = [];
  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const h = field[y * GRID + x];
      if (h < minH) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (field[(y + dy) * GRID + x + dx] > h) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) raw.push({ x01: x / (GRID - 1), y01: y / (GRID - 1), h });
    }
  }
  raw.sort((a, b) => b.h - a.h);
  const acc: typeof raw = [];
  for (const p of raw) {
    if (acc.every((q) => Math.hypot(q.x01 - p.x01, q.y01 - p.y01) > radius01)) {
      acc.push(p);
      if (acc.length >= cap) break;
    }
  }
  return acc;
}

const NUMERIC_TERM = /^[\d\s.,%()\-–—:]|^\d/;

/** Tiered peak naming: dominant paper → most-concentrated KG entity →
 *  nearest cluster's terms. Each paper/entity names at most one peak. */
function buildPeakLabels(
  corpus: CorpusData,
  entities: WorldEntity[],
  finalField: Float32Array,
): PeakLabel[] {
  const { atlas, papers, clusters } = corpus;
  const sites = detectPeaks(finalField);
  const R = 0.055;
  const usedPapers = new Set<number>();
  const usedEntities = new Set<number>();
  const out: PeakLabel[] = [];

  for (const site of sites) {
    // chunks under this peak
    const byPaper = new Map<number, number>();
    let nUnder = 0;
    for (let i = 0; i < atlas.n; i++) {
      const dx = atlas.pos2[i * 2] - site.x01;
      const dy = atlas.pos2[i * 2 + 1] - site.y01;
      if (dx * dx + dy * dy > R * R) continue;
      nUnder++;
      const p = atlas.paper[i];
      byPaper.set(p, (byPaper.get(p) ?? 0) + 1);
    }
    if (nUnder < 4) continue;

    let label: string | null = null;
    let kind: PeakLabel["kind"] = "terms";
    let paperIdx = -1;
    let entityIdx = -1;

    // 1. one paper owns the summit
    let topPaper = -1;
    let topCount = 0;
    for (const [p, c] of byPaper) {
      if (c > topCount) {
        topCount = c;
        topPaper = p;
      }
    }
    if (topPaper >= 0 && topCount / nUnder >= 0.6 && !usedPapers.has(topPaper)) {
      const t = papers[topPaper].title;
      label = t.length > 38 ? `${t.slice(0, 37)}…` : t;
      kind = "paper";
      paperIdx = topPaper;
      usedPapers.add(topPaper);
    }

    // 2. the knowledge-graph entity most concentrated here
    if (!label) {
      let best = -1;
      let bestScore = 0;
      for (const e of entities) {
        if (usedEntities.has(e.idx) || isGenericEntityName(e.id)) continue;
        if (e.members.length < 3) continue;
        let within = 0;
        for (const m of e.members) {
          const dx = atlas.pos2[m * 2] - site.x01;
          const dy = atlas.pos2[m * 2 + 1] - site.y01;
          if (dx * dx + dy * dy <= R * R) within++;
        }
        const conc = within / e.members.length;
        if (within < 3 || conc < 0.34) continue;
        const score = conc * Math.log1p(e.deg);
        if (score > bestScore) {
          bestScore = score;
          best = e.idx;
        }
      }
      if (best >= 0) {
        const id = entities[best].id;
        label = id.length > 34 ? `${id.slice(0, 33)}…` : id;
        kind = "entity";
        entityIdx = best;
        usedEntities.add(best);
      }
    }

    // 3. nearest cluster's distinctive terms
    if (!label) {
      let bestCl: Cluster | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const cl of clusters) {
        const d = Math.hypot(cl.center[0] - site.x01, cl.center[1] - site.y01);
        if (d < bestD) {
          bestD = d;
          bestCl = cl;
        }
      }
      const terms = (bestCl?.terms ?? [])
        .filter((t) => t.length >= 3 && !NUMERIC_TERM.test(t))
        .slice(0, 2);
      if (terms.length) label = terms.join(" · ");
    }

    if (!label) continue;
    const [wx, wz] = toWorldXZ(site.x01, site.y01);
    out.push({
      pos: new THREE.Vector3(wx, site.h * HEIGHT_SCALE + 1.6, wz),
      label,
      kind,
      paperIdx,
      entityIdx,
      rank: out.length,
    });
  }
  return out;
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
  paperMeta: PaperMeta | null,
): WorldData {
  const { atlas, papers, clusters } = corpus;
  const n = atlas.n;

  // --- per-chunk fractional publication dates (mid-month/mid-year), falling
  // back to the atlas's integer years when the manifest has nothing finer ---
  const chunkDate = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const frac = paperMeta?.frac[atlas.paper[i]] ?? 0;
    chunkDate[i] = frac > 0 ? frac : atlas.year[i] > 0 ? atlas.year[i] + 0.5 : 0;
  }

  // --- date range (0 = unknown); UI bounds snap to whole years ---
  let dMin = Number.POSITIVE_INFINITY;
  let dMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const d = chunkDate[i];
    if (d > 0) {
      if (d < dMin) dMin = d;
      if (d > dMax) dMax = d;
    }
  }
  if (!Number.isFinite(dMin)) {
    dMin = 1950;
    dMax = 2026;
  }
  const yearMin = Math.floor(dMin);
  const yearMax = Math.ceil(dMax) - (Number.isInteger(dMax) ? 0 : 1);
  const span = Math.max(0.5, dMax - dMin);

  // Age colour by RANK, not by raw year. The corpus runs 1904-2026, so a
  // handful of very old outliers stretch a linear ramp until almost everything
  // modern lands on the same blue. Mapping each date to its percentile spends
  // the whole ramp on the years that actually hold papers.
  const sortedDates = Float32Array.from(
    Array.from(chunkDate).filter((d) => d > 0),
  ).sort();
  const ageT = (d: number): number => {
    if (d <= 0 || sortedDates.length === 0) return 0;
    let lo = 0;
    let hi = sortedDates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedDates[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    return lo / sortedDates.length;
  };

  // Terrain height is PAPER density. Splatting passages let one long document
  // pile up terrain wherever its passages scattered — raising ground with no
  // beacon under it, and letting a single book out-rank a region holding dozens
  // of papers. Papers put the landscape and the beacons on the same footing.
  const paperX = new Float32Array(papers.length);
  const paperY = new Float32Array(papers.length);
  const paperDate = new Float32Array(papers.length);
  papers.forEach((p, i) => {
    paperX[i] = p.centroid[0];
    paperY[i] = p.centroid[1];
    paperDate[i] = paperMeta?.frac[i] || (p.year > 0 ? p.year + 0.5 : 0);
  });
  const eras = buildEraFields(paperX, paperY, paperDate, yearMin, yearMax);
  const paperAgeRank = new Float32Array(papers.length);
  for (let i = 0; i < papers.length; i++) {
    paperAgeRank[i] = paperDate[i] > 0 ? ageT(paperDate[i]) : -1;
  }
  const colorTex = buildColorTexture(paperX, paperY, paperAgeRank);

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

  // Marks are sized in WORLD units, so they must shrink as the corpus grows or
  // 10k beacons merge into one sheet. (Enlarging WORLD_SIZE does NOT help: the
  // camera and sizeAttenuation scale with it, so it is just a zoom.) Scaled by
  // 1/sqrt(count) — the density of marks per unit area — with a floor so a big
  // corpus stays visible rather than dissolving.
  const beaconScale = Math.min(1, Math.max(0.34, Math.sqrt(1500 / Math.max(papers.length, 1))));
  const pointScale = Math.min(1, Math.max(0.55, Math.sqrt(60000 / Math.max(n, 1))));

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
    // size first: the resting height stands the orb off by its own radius, and
    // must match the shader's aSize.mul(0.35) or picking drifts from the visuals
    chunkSize[i] = (0.5 + 2.0 * Math.pow(centrality[i], 0.75)) * pointScale;
    chunkGroundY[i] =
      sampleField(eras.final, x01, y01) * HEIGHT_SCALE + chunkSize[i] * 0.35;
    const [sx, sy, sz] = spaceXYZ(atlas.pos3, i);
    chunkSpace[i * 3] = sx;
    chunkSpace[i * 3 + 1] = sy;
    chunkSpace[i * 3 + 2] = sz;

    const lum = 0.3 + 0.7 * Math.pow(centrality[i], 0.8);
    c.set(clusterColor(atlas.cluster[i]));
    chunkColorGround[i * 3] = c.r * lum;
    chunkColorGround[i * 3 + 1] = c.g * lum;
    chunkColorGround[i * 3 + 2] = c.b * lum;
    const d = chunkDate[i];
    if (d > 0) ageColor(ageT(d), cAge);
    else cAge.set(INK.muted);
    chunkColorSpace[i * 3] = cAge.r * lum;
    chunkColorSpace[i * 3 + 1] = cAge.g * lum;
    chunkColorSpace[i * 3 + 2] = cAge.b * lum;

    chunkPhase[i] = ((i * 0.6180339887) % 1) * Math.PI * 2;
    chunkYear[i] = d;
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
  const paperLift = new Float32Array(nPapers);

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
    paperGroundY[i] = sampleField(eras.final, p.centroid[0], p.centroid[1]) * HEIGHT_SCALE;
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
    const pd = paperMeta?.frac[i] || (p.year > 0 ? p.year + 0.5 : 0);
    if (pd > 0) ageColor(ageT(pd), cAge);
    else cAge.set(INK.muted);
    paperColorSpace[i * 3] = cAge.r * lum;
    paperColorSpace[i * 3 + 1] = cAge.g * lum;
    paperColorSpace[i * 3 + 2] = cAge.b * lum;
    paperSize[i] =
      (1.15 + 1.35 * (Math.log1p(p.nChunks) / Math.log1p(maxChunks))) * beaconScale;
    // Offset along the surface normal, not straight up: on a slope a purely
    // vertical lift still leaves the sprite buried in the hillside. The normal's
    // vertical component is 1/sqrt(1+|grad|^2), so dividing the radius by it
    // gives the vertical distance that clears the surface by one radius.
    const d = 0.004;
    const hx =
      (sampleField(eras.final, p.centroid[0] + d, p.centroid[1]) -
        sampleField(eras.final, p.centroid[0] - d, p.centroid[1])) *
      HEIGHT_SCALE;
    const hz =
      (sampleField(eras.final, p.centroid[0], p.centroid[1] + d) -
        sampleField(eras.final, p.centroid[0], p.centroid[1] - d)) *
      HEIGHT_SCALE;
    const run = 2 * d * WORLD_SIZE;
    const grad = Math.hypot(hx / run, hz / run);
    // clearance is the sprite's RADIUS (half its world size), not its width —
    // enough to sit on the surface rather than float over it
    paperLift[i] = paperSize[i] * 0.3 * Math.min(2.5, Math.sqrt(1 + grad * grad));
    paperYear[i] = pd;
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
      const y = chunkDate[m];
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
  const chunkIdToIdx = makeChunkIndex(atlas);
  const clusterById = new Map(clusters.map((cl) => [cl.id, cl]));

  // Where a region's name sits, and which names win space.
  //
  // The label used to sit at the cluster's MEAN position. UMAP regions are
  // rarely convex — a crescent or a split cluster has a mean that lands in the
  // middle of somebody else's territory, which is why the papers under a label
  // often had nothing to do with it. Placing it at the cluster's DENSEST cell
  // instead puts the name over ground that region actually occupies.
  const LG = 64; // coarse grid for locating each cluster's densest patch
  const clusterGrids = new Map<number, Float32Array>();
  for (let i = 0; i < n; i++) {
    const c = atlas.cluster[i];
    let g = clusterGrids.get(c);
    if (!g) {
      g = new Float32Array(LG * LG);
      clusterGrids.set(c, g);
    }
    const gx = Math.min(LG - 1, Math.max(0, Math.floor(atlas.pos2[i * 2] * LG)));
    const gy = Math.min(LG - 1, Math.max(0, Math.floor(atlas.pos2[i * 2 + 1] * LG)));
    g[gy * LG + gx] += 1;
  }
  // a handful of papers is not a "region" — labelling 2-paper clusters as
  // peers of 1,600-paper ones is what made the map's naming look arbitrary
  const MIN_REGION_PAPERS = 15;
  // earliest paper in each cluster, so the time machine can withhold a region's
  // name until the literature it names actually exists
  const clusterFirstYear = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const d = chunkDate[i];
    if (d <= 0) continue;
    const c = atlas.cluster[i];
    const prev = clusterFirstYear.get(c);
    if (prev === undefined || d < prev) clusterFirstYear.set(c, d);
  }
  const labelClusters = clusters
    .filter((cl) => cl.name && cl.nPapers >= MIN_REGION_PAPERS)
    // biggest regions reserve screen space first — a 20-paper cluster should
    // never crowd out one holding hundreds
    .sort((a, b) => b.nPapers - a.nPapers)
    .map((cl) => {
      const g = clusterGrids.get(cl.id);
      let cx = cl.center[0];
      let cy = cl.center[1];
      if (g) {
        let best = -1;
        let bi = -1;
        for (let i = 0; i < g.length; i++) {
          if (g[i] > best) {
            best = g[i];
            bi = i;
          }
        }
        if (bi >= 0) {
          cx = ((bi % LG) + 0.5) / LG;
          cy = (Math.floor(bi / LG) + 0.5) / LG;
        }
      }
      const [wx, wz] = toWorldXZ(cx, cy);
      return {
        cluster: cl,
        firstYear: clusterFirstYear.get(cl.id) ?? 0,
        ground: new THREE.Vector3(
          wx,
          sampleField(eras.final, cx, cy) * HEIGHT_SCALE + 3.2,
          wz,
        ),
        space: new THREE.Vector3(
          (cl.center3[0] - 0.5) * WORLD_SIZE,
          (cl.center3[1] - 0.5) * WORLD_SIZE,
          (cl.center3[2] - 0.5) * WORLD_SIZE,
        ),
      };
    });

  const labelPapers = papers
    .map((p, i) => ({ i, s: p.nChunks }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 18)
    .map((x) => x.i);

  const labelEntities = entities
    .filter((e) => !isGenericEntityName(e.id))
    .slice(0, 16)
    .map((e) => e.idx);

  const paperHaystack = papers.map((p, i) =>
    [p.title, p.abstract, ...(paperMeta?.keywords[i] ?? []), ...(paperMeta?.subjects[i] ?? [])]
      .join(" | ")
      .toLowerCase(),
  );

  const peaks = buildPeakLabels(corpus, entities, eras.final);

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
    paperLift,
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
    peaks,
    yearMin,
    yearMax,
    chunkIdToIdx,
    clusterById,
    labelClusters,
    labelPapers,
    paperHaystack,
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
