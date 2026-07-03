"use client";

import {
  cosine,
  embed,
  fetchChunkText,
  fetchVectors,
  qsearch,
  slerp,
  type QSearchHit,
} from "@/lib/atlas/api";
import type { CorpusData, Paper } from "@/lib/atlas/types";

/**
 * Data engine for the Interpolation Engine — endpoint resolution, geodesic
 * tracing, and embedding arithmetic. Pure logic over lib/api; no rendering.
 *
 * An endpoint can be a paper (its true location: the normalized mean of its
 * real chunk vectors, fetched from Qdrant), an author (mean over all their
 * papers' chunks), or a free phrase (query-context embedding). The geodesic is
 * a slerp between the two endpoint vectors; each waypoint runs a real vector
 * search, so everything shown is an actual passage with an actual citation.
 */

export type Mode = "geodesic" | "arithmetic";

export const STEPS = 11;
const STEP_LIMIT = 12; // raw hits fetched per waypoint (pre paper-dedupe)
const STEP_KEEP = 5;
const ARITH_LIMIT = 32;
const ARITH_KEEP = 8;
const SAMPLE_CHUNKS = 12; // chunk vectors averaged per paper/author endpoint

/** Slot colors: diverging cool↔warm poles (A/B) + the third arithmetic term. */
export const COOL = "#3987e5";
export const WARM = "#e66767";
export const THIRD = "#199e70";
export const RESULT_HOT = "#ffe9c9";

export type Endpoint =
  | { kind: "phrase"; text: string }
  | { kind: "paper"; paperIdx: number }
  | { kind: "author"; name: string };

export interface Hit {
  qid: string;
  chunkId: string;
  file: string;
  score: number;
  /** geodesic waypoint index; -1 for arithmetic results */
  step: number;
  /** index into corpus.atlas arrays; -1 when the chunk is not in the atlas */
  chunkIdx: number;
  paperIdx: number;
}

export interface StepResult {
  t: number;
  hits: Hit[];
  /** similarity-weighted map centroid of this waypoint's hits, [0,1]² */
  centroid2: [number, number];
}

export interface Trace {
  id: number;
  steps: StepResult[];
  anchorA2: [number, number];
  anchorB2: [number, number];
  angleDeg: number;
  aLabel: string;
  bLabel: string;
}

export interface ArithAnchor {
  pos2: [number, number];
  label: string;
  sign: "+" | "−";
  color: string;
}

export interface ArithResult {
  id: number;
  hits: Hit[];
  anchors: ArithAnchor[];
  /** how many raw hits were hidden because they came from the input papers */
  excluded: number;
}

export type ChunkRec = Awaited<ReturnType<typeof fetchChunkText>>;

let runCounter = 0;

/* ---------------- labels & citations ---------------- */

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function endpointLabel(ep: Endpoint, papers: Paper[]): string {
  if (ep.kind === "phrase") return `“${truncate(ep.text, 40)}”`;
  if (ep.kind === "paper") {
    const p = papers[ep.paperIdx];
    return `${p.authors} (${p.year})`;
  }
  return ep.name;
}

export function shortCite(corpus: CorpusData, hit: Hit): string {
  if (hit.paperIdx >= 0) {
    const p = corpus.papers[hit.paperIdx];
    return `${p.authors}, ${p.year}`;
  }
  return truncate(hit.file.replace(/\.pdf$/i, ""), 28);
}

export function apaCite(p: Paper): string {
  const journal = p.journal ? ` ${p.journal}.` : "";
  return `${p.authors} (${p.year}). ${p.title}.${journal}`;
}

export function hitKey(hit: Hit): string {
  return `${hit.step}:${hit.qid}`;
}

/* ---------------- vector helpers ---------------- */

function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) + 1e-9;
  return v.map((x) => x / n);
}

function meanNormalized(vecs: number[][]): number[] {
  const out = new Array<number>(vecs[0].length).fill(0);
  for (const v of vecs) {
    const u = normalize(v);
    for (let i = 0; i < u.length; i++) out[i] += u[i];
  }
  return normalize(out);
}

function spreadSample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * arr.length) / n)]);
  return out;
}

/* ---------------- corpus lookups ---------------- */

const chunkMapCache = new WeakMap<CorpusData, Map<string, number>>();

function chunkIndexMap(corpus: CorpusData): Map<string, number> {
  let m = chunkMapCache.get(corpus);
  if (!m) {
    m = new Map();
    corpus.atlas.chunkId.forEach((id, i) => m!.set(id, i));
    chunkMapCache.set(corpus, m);
  }
  return m;
}

function chunkIdxsOfPapers(corpus: CorpusData, paperIdxs: Set<number>): number[] {
  const out: number[] = [];
  const { paper, n } = corpus.atlas;
  for (let i = 0; i < n; i++) if (paperIdxs.has(paper[i])) out.push(i);
  return out;
}

export function papersOfAuthor(corpus: CorpusData, name: string): number[] {
  const out: number[] = [];
  corpus.papers.forEach((p, i) => {
    if (p.authors === name) out.push(i);
  });
  return out;
}

/* ---------------- endpoint resolution ---------------- */

interface Resolved {
  vec: number[];
  anchor2: [number, number] | null;
}

function signatureText(ep: Endpoint, corpus: CorpusData): string {
  if (ep.kind === "phrase") return ep.text;
  if (ep.kind === "paper") {
    const p = corpus.papers[ep.paperIdx];
    return `${p.title}. ${p.abstract}`.slice(0, 500);
  }
  const titles = papersOfAuthor(corpus, ep.name).map((i) => corpus.papers[i].title);
  return `${ep.name}: ${titles.join("; ")}`.slice(0, 600);
}

async function resolveEndpoint(ep: Endpoint, corpus: CorpusData): Promise<Resolved> {
  if (ep.kind === "phrase") {
    const [v] = await embed([ep.text], "query");
    return { vec: normalize(v), anchor2: null };
  }

  let paperIdxs: Set<number>;
  let anchor2: [number, number];
  if (ep.kind === "paper") {
    paperIdxs = new Set([ep.paperIdx]);
    anchor2 = corpus.papers[ep.paperIdx].centroid;
  } else {
    const ids = papersOfAuthor(corpus, ep.name);
    if (!ids.length) throw new Error(`no papers by "${ep.name}" in the corpus`);
    paperIdxs = new Set(ids);
    anchor2 = [
      ids.reduce((s, i) => s + corpus.papers[i].centroid[0], 0) / ids.length,
      ids.reduce((s, i) => s + corpus.papers[i].centroid[1], 0) / ids.length,
    ];
  }

  // The endpoint's true location: the mean of its real chunk vectors.
  const sample = spreadSample(chunkIdxsOfPapers(corpus, paperIdxs), SAMPLE_CHUNKS);
  const recs = await Promise.all(
    sample.map((i) =>
      fetchChunkText(corpus.atlas.chunkId[i]).then(
        (r) => r as ChunkRec & { qid?: string },
        () => null,
      ),
    ),
  );
  const qids = recs
    .map((r) => r?.qid)
    .filter((q): q is string => typeof q === "string" && q.length > 0);
  if (qids.length) {
    const vecMap = await fetchVectors(qids);
    const vecs = Object.values(vecMap).filter((v) => v && v.length > 0);
    if (vecs.length) return { vec: meanNormalized(vecs), anchor2 };
  }
  // Fallback: embed a textual signature of the paper/author.
  const [v] = await embed([signatureText(ep, corpus)], "query");
  return { vec: normalize(v), anchor2 };
}

/* ---------------- retrieval mapping ---------------- */

function toHits(
  raw: QSearchHit[],
  corpus: CorpusData,
  step: number,
  keep: number,
  excludeFiles?: Set<string>,
): Hit[] {
  const map = chunkIndexMap(corpus);
  const seen = new Set<string>(); // keep only the best passage per paper
  const out: Hit[] = [];
  for (const r of raw) {
    if (excludeFiles?.has(r.file)) continue;
    const chunkIdx = map.get(r.chunkId) ?? -1;
    const paperIdx = chunkIdx >= 0 ? corpus.atlas.paper[chunkIdx] : -1;
    const dedupeKey = paperIdx >= 0 ? `p${paperIdx}` : r.file;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      qid: r.qid,
      chunkId: r.chunkId,
      file: r.file,
      score: r.score,
      step,
      chunkIdx,
      paperIdx,
    });
    if (out.length >= keep) break;
  }
  return out;
}

function weightedCentroid(hits: Hit[], corpus: CorpusData): [number, number] | null {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (const h of hits) {
    if (h.chunkIdx < 0) continue;
    const w = Math.pow(Math.max(h.score, 0.01), 4);
    sx += corpus.atlas.pos2[h.chunkIdx * 2] * w;
    sy += corpus.atlas.pos2[h.chunkIdx * 2 + 1] * w;
    sw += w;
  }
  return sw > 0 ? [sx / sw, sy / sw] : null;
}

/* ---------------- the two instruments ---------------- */

export async function traceGeodesic(
  a: Endpoint,
  b: Endpoint,
  corpus: CorpusData,
  onPhase?: (msg: string) => void,
): Promise<Trace> {
  onPhase?.("locating both ideas in embedding space…");
  const [ra, rb] = await Promise.all([
    resolveEndpoint(a, corpus),
    resolveEndpoint(b, corpus),
  ]);
  const angleDeg =
    (Math.acos(Math.min(1, Math.max(-1, cosine(ra.vec, rb.vec)))) * 180) / Math.PI;

  onPhase?.(`walking the geodesic — ${STEPS} retrievals…`);
  const rawSteps = await Promise.all(
    Array.from({ length: STEPS }, async (_, i) => {
      const t = i / (STEPS - 1);
      const raw = await qsearch({ vector: slerp(ra.vec, rb.vec, t), limit: STEP_LIMIT });
      const hits = toHits(raw, corpus, i, STEP_KEEP);
      return { t, hits, centroid2: weightedCentroid(hits, corpus) };
    }),
  );

  const anchorA2: [number, number] =
    ra.anchor2 ?? rawSteps[0].centroid2 ?? [0.5, 0.5];
  const anchorB2: [number, number] =
    rb.anchor2 ?? rawSteps[rawSteps.length - 1].centroid2 ?? [0.5, 0.5];
  const steps: StepResult[] = rawSteps.map((s) => ({
    t: s.t,
    hits: s.hits,
    centroid2: s.centroid2 ?? [
      anchorA2[0] + (anchorB2[0] - anchorA2[0]) * s.t,
      anchorA2[1] + (anchorB2[1] - anchorA2[1]) * s.t,
    ],
  }));

  return {
    id: ++runCounter,
    steps,
    anchorA2,
    anchorB2,
    angleDeg,
    aLabel: endpointLabel(a, corpus.papers),
    bLabel: endpointLabel(b, corpus.papers),
  };
}

function filesOfEndpoint(ep: Endpoint, corpus: CorpusData): string[] {
  if (ep.kind === "paper") return [corpus.papers[ep.paperIdx].file];
  if (ep.kind === "author")
    return papersOfAuthor(corpus, ep.name).map((i) => corpus.papers[i].file);
  return [];
}

export async function solveArithmetic(
  a: Endpoint,
  b: Endpoint,
  c: Endpoint,
  corpus: CorpusData,
  onPhase?: (msg: string) => void,
): Promise<ArithResult> {
  onPhase?.("locating the three ideas…");
  const inputs = [
    { ep: a, sign: "+" as const, color: COOL },
    { ep: b, sign: "−" as const, color: WARM },
    { ep: c, sign: "+" as const, color: THIRD },
  ];
  const resolved = await Promise.all(inputs.map((i) => resolveEndpoint(i.ep, corpus)));
  const v = normalize(
    resolved[0].vec.map((x, i) => x - resolved[1].vec[i] + resolved[2].vec[i]),
  );

  onPhase?.("searching near A − B + C…");
  const excludeFiles = new Set(inputs.flatMap((i) => filesOfEndpoint(i.ep, corpus)));
  const [raw, ...anchorRaw] = await Promise.all([
    qsearch({ vector: v, limit: ARITH_LIMIT }),
    ...resolved.map((r) =>
      r.anchor2 ? Promise.resolve<QSearchHit[]>([]) : qsearch({ vector: r.vec, limit: 5 }),
    ),
  ]);

  const hits = toHits(raw, corpus, -1, ARITH_KEEP, excludeFiles);
  const excluded = raw.filter((r) => excludeFiles.has(r.file)).length;

  const anchors: ArithAnchor[] = inputs.map((inp, i) => {
    const pos2: [number, number] =
      resolved[i].anchor2 ??
      weightedCentroid(toHits(anchorRaw[i], corpus, -1, 5), corpus) ?? [0.5, 0.5];
    return {
      pos2,
      label: endpointLabel(inp.ep, corpus.papers),
      sign: inp.sign,
      color: inp.color,
    };
  });

  return { id: ++runCounter, hits, anchors, excluded };
}
