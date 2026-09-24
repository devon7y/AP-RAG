"use client";

/** Client helpers for the app's API routes (which proxy the PC stack). */

export interface QSearchHit {
  qid: string;
  chunkId: string;
  file: string;
  score: number;
}

export async function embed(texts: string[], context: "query" | "document" = "query"): Promise<number[][]> {
  const r = await fetch("/api/atlas/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, context }),
  });
  if (!r.ok) throw new Error(`embed failed: ${r.status}`);
  return (await r.json()).embeddings;
}

/** Semantic search over chunk vectors. Provide text OR a raw vector. */
export async function qsearch(
  body: { text?: string; vector?: number[]; limit?: number },
): Promise<QSearchHit[]> {
  const r = await fetch("/api/atlas/qsearch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`qsearch failed: ${r.status}`);
  return (await r.json()).hits;
}

export async function fetchChunkText(id: string): Promise<{
  text: string;
  section: string;
  page: number | null;
  file: string;
}> {
  const r = await fetch(`/api/atlas/chunk?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(`chunk fetch failed: ${r.status}`);
  return r.json();
}

export async function fetchVectors(qids: string[]): Promise<Record<string, number[]>> {
  const r = await fetch("/api/atlas/vectors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ qids }),
  });
  if (!r.ok) throw new Error(`vectors fetch failed: ${r.status}`);
  return (await r.json()).vectors;
}

/** One structured reference from the PC query server (apa_citations.build_ref_model). */
export interface RagReference {
  n?: string;
  filename?: string;
  apa?: string;
  intext?: string;
  drive_url?: string;
  hades_path?: string;
  /** PDF pages the cited passages came from */
  pages?: number[];
  [k: string]: unknown;
}

/** Synthesized answer via the PC query server (gpt-6-luna + APA refs). */
export async function ragQuery(body: {
  question: string;
  mode?: string;
  filters?: Record<string, unknown>;
  user_prompt?: string;
  top_k?: number;
  chunk_top_k?: number;
}): Promise<{ answer: string; references: RagReference[]; mode: string }> {
  const r = await fetch("/api/atlas/rag/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`query failed: ${r.status}`);
  return r.json();
}

/** Raw structured retrieval (entities/relationships/chunks — no LLM). */
export async function ragRetrieve(body: {
  question: string;
  mode?: string;
  top_k?: number;
  chunk_top_k?: number;
  filters?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const r = await fetch("/api/atlas/rag/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`retrieve failed: ${r.status}`);
  return r.json();
}

export function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/** Spherical interpolation between two unit-ish vectors. */
export function slerp(a: number[], b: number[], t: number): number[] {
  const omega = Math.acos(Math.min(1, Math.max(-1, cosine(a, b))));
  if (omega < 1e-5) return a.slice();
  const so = Math.sin(omega);
  const fa = Math.sin((1 - t) * omega) / so;
  const fb = Math.sin(t * omega) / so;
  return a.map((v, i) => fa * v + fb * b[i]);
}

/** Full manifest record for one paper (abstract, affiliations, APA strings). */
export async function fetchPaperDetail(file: string): Promise<{
  abstract?: string;
  apa?: string;
  [k: string]: unknown;
}> {
  const r = await fetch(`/api/atlas/paper?file=${encodeURIComponent(file)}`);
  if (!r.ok) throw new Error(`paper fetch failed: ${r.status}`);
  return r.json();
}
