"use client";

import * as THREE from "three";
import { WORLD_SIZE } from "@/lib/data";
import { CATEGORICAL, INK } from "@/lib/palette";
import type { Cluster, Constellations, CorpusData, Entity, Paper } from "@/lib/types";

/**
 * Pure derivations that turn the corpus + KG constellations into render-ready
 * typed arrays for the night sky. Computed once per session (memoized by the
 * scene), never per frame.
 *
 * Sky conventions:
 * - atlas.pos3 [0,1]³ → world cube ±WORLD_SIZE/2 on all three axes
 * - star brightness = knowledge-graph centrality (sum of `deg` over the
 *   entities a chunk belongs to, log-compressed)
 * - star colour = publication age on a stellar-temperature ramp
 *   (old → ember, new → ice blue)
 */

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

/** Fixed categorical assignment for KG entity types (legend shows the big ones). */
export const TYPE_COLORS: Record<string, string> = {
  concept: CATEGORICAL[0], // blue
  method: CATEGORICAL[1], // aqua
  dataset: CATEGORICAL[2], // yellow
  experiment: CATEGORICAL[3], // green
  publication: CATEGORICAL[4], // violet
  author: CATEGORICAL[6], // magenta
  theory: CATEGORICAL[5], // red
  institution: CATEGORICAL[7], // orange
};
export const TYPE_FALLBACK = INK.muted;

export function typeColor(type: string): string {
  return TYPE_COLORS[type.toLowerCase()] ?? TYPE_FALLBACK;
}

export interface EntityView {
  /** index into ObservatoryData.entities (stable handle used by the store) */
  idx: number;
  id: string;
  type: string;
  desc: string;
  deg: number;
  nChunks: number;
  pos: THREE.Vector3;
  color: string;
  /** member star indices (chunk indices, deduped, in-range) */
  members: number[];
  /** constellation figure: line-segment pairs threading the member stars (world xyz) */
  figure: Float32Array;
  /** spread of members around the anchor — used to frame warps */
  radius: number;
  /** rank by degree, 0 = most connected */
  rank: number;
}

export interface EntityEdgeView {
  other: number; // entity idx
  w: number;
  desc: string;
  kw: string;
}

export interface ObservatoryData {
  n: number;
  /** star world positions, flat xyz */
  positions: Float32Array;
  /** star base colours (age ramp × centrality luminance), flat rgb */
  colors: Float32Array;
  /** star sprite sizes (world units) */
  sizes: Float32Array;
  /** per-star twinkle phase (radians) */
  phases: Float32Array;
  /** KG centrality per star, 0..1 */
  centrality: Float32Array;
  yearMin: number;
  yearMax: number;
  chunkIdToIdx: Map<string, number>;
  /** star idx → entity idxs it belongs to */
  starEntities: Map<number, number[]>;
  entities: EntityView[];
  /** entity idx → its KG edges (sorted by weight desc) */
  edgesByEntity: Map<number, EntityEdgeView[]>;
  /** ambient constellation figures (top entities), one concatenated segment buffer */
  ambientFigures: Float32Array;
  /** faint entity–entity web (top edges), segment buffer */
  webSegments: Float32Array;
  clusterById: Map<number, Cluster>;
}

function entityWorld(e: Entity): THREE.Vector3 {
  return new THREE.Vector3(
    (e.pos3[0] - 0.5) * WORLD_SIZE,
    (e.pos3[1] - 0.5) * WORLD_SIZE,
    (e.pos3[2] - 0.5) * WORLD_SIZE,
  );
}

/** Greedy nearest-neighbour path through member stars → a constellation figure. */
function buildFigure(anchor: THREE.Vector3, members: number[], positions: Float32Array): Float32Array {
  if (members.length < 2) return new Float32Array(0);
  const pts = members.map((m) => new THREE.Vector3(positions[m * 3], positions[m * 3 + 1], positions[m * 3 + 2]));
  const visited = new Array(pts.length).fill(false);
  // start at the member closest to the entity anchor
  let cur = 0;
  let best = Infinity;
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
    let bd = Infinity;
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

/** Paper-furniture entity names (Table 3, Study 1, Experiment 4…) — real KG
 *  nodes, but noise as constellation names on the sky chart. */
const GENERIC_ID =
  /^(table|figure|fig|study|experiment|exp|appendix|equation|section|chapter|participants?|stimuli|procedure|methods?|results?|discussion|introduction|abstract|model|step|phase|task|item|block)\.?\s*\d*[a-z]?$/i;

export function isGenericEntityName(id: string): boolean {
  return GENERIC_ID.test(id.trim());
}

/** How many ambient figures / web edges the resting sky shows. */
export const AMBIENT_FIGURES = 28;
export const WEB_EDGES = 170;
export const LABELED_ENTITIES = 26;
export const NEBULA_COUNT = 44;

export function deriveObservatory(corpus: CorpusData, constellations: Constellations): ObservatoryData {
  const { atlas, clusters } = corpus;
  const n = atlas.n;

  // --- star positions ---
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = (atlas.pos3[i * 3] - 0.5) * WORLD_SIZE;
    positions[i * 3 + 1] = (atlas.pos3[i * 3 + 1] - 0.5) * WORLD_SIZE;
    positions[i * 3 + 2] = (atlas.pos3[i * 3 + 2] - 0.5) * WORLD_SIZE;
  }

  // --- entity views (sorted by degree so rank == array order) ---
  const sorted = [...constellations.entities].sort((a, b) => b.deg - a.deg);
  const entities: EntityView[] = sorted.map((e, idx) => {
    const pos = entityWorld(e);
    const members = [...new Set(e.chunkIdx)].filter((c) => c >= 0 && c < n);
    const figure = buildFigure(pos, members, positions);
    let radius = 0;
    for (const m of members) {
      const dx = positions[m * 3] - pos.x;
      const dy = positions[m * 3 + 1] - pos.y;
      const dz = positions[m * 3 + 2] - pos.z;
      radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    return {
      idx,
      id: e.id,
      type: e.type,
      desc: e.desc,
      deg: e.deg,
      nChunks: e.nChunks,
      pos,
      color: typeColor(e.type),
      members,
      figure,
      radius,
      rank: idx,
    };
  });
  const entityIdxById = new Map<string, number>(entities.map((e) => [e.id, e.idx]));

  // --- KG centrality per star ---
  const acc = new Float32Array(n);
  const starEntities = new Map<number, number[]>();
  for (const e of entities) {
    for (const m of e.members) {
      acc[m] += e.deg;
      const list = starEntities.get(m);
      if (list) list.push(e.idx);
      else starEntities.set(m, [e.idx]);
    }
  }
  let maxAcc = 0;
  for (let i = 0; i < n; i++) maxAcc = Math.max(maxAcc, acc[i]);
  const logMax = Math.log1p(maxAcc) || 1;
  const centrality = new Float32Array(n);
  for (let i = 0; i < n; i++) centrality[i] = Math.log1p(acc[i]) / logMax;

  // --- year range (guard year<=0 as unknown) ---
  let yearMin = Infinity;
  let yearMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = atlas.year[i];
    if (y > 0) {
      if (y < yearMin) yearMin = y;
      if (y > yearMax) yearMax = y;
    }
  }
  if (!isFinite(yearMin)) {
    yearMin = 0;
    yearMax = 1;
  }
  const span = Math.max(1, yearMax - yearMin);

  // --- star colours & sizes ---
  const colors = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  const phases = new Float32Array(n);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const y = atlas.year[i];
    if (y > 0) ageColor((y - yearMin) / span, c);
    else c.set(INK.muted);
    const lum = 0.26 + 0.74 * Math.pow(centrality[i], 0.8);
    colors[i * 3] = c.r * lum;
    colors[i * 3 + 1] = c.g * lum;
    colors[i * 3 + 2] = c.b * lum;
    sizes[i] = 0.5 + 2.2 * Math.pow(centrality[i], 0.75);
    // deterministic golden-ratio phase hash — stable twinkle without RNG
    phases[i] = ((i * 0.6180339887) % 1) * Math.PI * 2;
  }

  // --- chunkId lookup for warp-drive search hits ---
  const chunkIdToIdx = new Map<string, number>();
  for (let i = 0; i < n; i++) chunkIdToIdx.set(atlas.chunkId[i], i);

  // --- entity–entity edges ---
  const edgesByEntity = new Map<number, EntityEdgeView[]>();
  const pushEdge = (a: number, b: number, w: number, desc: string, kw: string) => {
    const list = edgesByEntity.get(a);
    const view = { other: b, w, desc, kw };
    if (list) list.push(view);
    else edgesByEntity.set(a, [view]);
  };
  const resolved: { a: number; b: number; w: number }[] = [];
  for (const edge of constellations.edges) {
    const a = entityIdxById.get(edge.s);
    const b = entityIdxById.get(edge.t);
    if (a === undefined || b === undefined || a === b) continue;
    resolved.push({ a, b, w: edge.w });
    pushEdge(a, b, edge.w, edge.desc, edge.kw);
    pushEdge(b, a, edge.w, edge.desc, edge.kw);
  }
  for (const list of edgesByEntity.values()) list.sort((x, y) => y.w - x.w);

  // --- ambient constellation figures ---
  // Only compact entities read as asterisms; sprawling ones (members scattered
  // across the whole embedding) would smear lines over the entire sky. Those
  // still get their figure drawn on focus.
  const figureSources = entities
    .filter((e) => e.members.length >= 3 && e.radius < 16)
    .slice(0, AMBIENT_FIGURES);
  let figLen = 0;
  for (const e of figureSources) figLen += e.figure.length;
  const ambientFigures = new Float32Array(figLen);
  let off = 0;
  for (const e of figureSources) {
    ambientFigures.set(e.figure, off);
    off += e.figure.length;
  }

  // --- faint web between entity anchors (top edges by weight) ---
  const topEdges = [...resolved].sort((x, y) => y.w - x.w).slice(0, WEB_EDGES);
  const webSegments = new Float32Array(topEdges.length * 6);
  topEdges.forEach((e, i) => {
    const pa = entities[e.a].pos;
    const pb = entities[e.b].pos;
    webSegments.set([pa.x, pa.y, pa.z, pb.x, pb.y, pb.z], i * 6);
  });

  const clusterById = new Map<number, Cluster>(clusters.map((cl) => [cl.id, cl]));

  return {
    n,
    positions,
    colors,
    sizes,
    phases,
    centrality,
    yearMin,
    yearMax,
    chunkIdToIdx,
    starEntities,
    entities,
    edgesByEntity,
    ambientFigures,
    webSegments,
    clusterById,
  };
}

/** "Balota, D. A., et al. (2007)"-ish short cite from the papers table. */
export function shortCite(paper: Paper | undefined): string {
  if (!paper) return "Unknown paper";
  const first = paper.authors.split(/[;,]/)[0]?.trim() || "Unknown";
  const etAl = /[;,]/.test(paper.authors) ? " et al." : "";
  return `${first}${etAl}${paper.year ? ` (${paper.year})` : ""}`;
}

/** Soft radial glow texture shared by nebulae / rings (built once, browser only). */
let glowTex: THREE.CanvasTexture | null = null;
export function glowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.25, "rgba(255,255,255,0.35)");
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
