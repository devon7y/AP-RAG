import type { Cluster, Paper } from "@/lib/atlas/types";
import { clusterColor } from "@/lib/atlas/palette";

/**
 * Pure data helpers for the Séance: aggregate the corpus into summonable author
 * "spirits" (papers.json's `authors` field is the first-author family name — the
 * same family-name key the PC query server's `filters.authors` matches on), and
 * resolve each answer's references back onto the map.
 */

export interface AuthorSpirit {
  /** family name — sent verbatim as the retrieval filter */
  name: string;
  /** indices into corpus.papers */
  paperIdx: number[];
  nPapers: number;
  nChunks: number;
  yearMin: number;
  yearMax: number;
  /** chunk-weighted mean of the author's paper centroids, [0,1]² */
  centroid: [number, number];
  centroid3: [number, number, number];
}

/** Below this many indexed chunks a spirit is "too faint to reach" (retrieval
 *  scoped that narrowly grounds too little to hold a conversation). */
export const SUMMON_MIN_CHUNKS = 25;

export function buildSpirits(papers: Paper[]): AuthorSpirit[] {
  const byName = new Map<
    string,
    AuthorSpirit & { wSum: number; acc2: [number, number]; acc3: [number, number, number] }
  >();
  papers.forEach((p, i) => {
    const name = (p.authors || "").trim();
    if (!name) return;
    let s = byName.get(name);
    if (!s) {
      s = {
        name,
        paperIdx: [],
        nPapers: 0,
        nChunks: 0,
        yearMin: Infinity,
        yearMax: -Infinity,
        centroid: [0.5, 0.5],
        centroid3: [0.5, 0.5, 0.5],
        wSum: 0,
        acc2: [0, 0],
        acc3: [0, 0, 0],
      };
      byName.set(name, s);
    }
    s.paperIdx.push(i);
    s.nPapers += 1;
    s.nChunks += p.nChunks;
    if (p.year > 0) {
      s.yearMin = Math.min(s.yearMin, p.year);
      s.yearMax = Math.max(s.yearMax, p.year);
    }
    const w = Math.max(p.nChunks, 1);
    s.wSum += w;
    s.acc2[0] += p.centroid[0] * w;
    s.acc2[1] += p.centroid[1] * w;
    s.acc3[0] += p.centroid3[0] * w;
    s.acc3[1] += p.centroid3[1] * w;
    s.acc3[2] += p.centroid3[2] * w;
  });

  const out: AuthorSpirit[] = [];
  for (const s of byName.values()) {
    const { wSum, acc2, acc3, ...spirit } = s;
    spirit.centroid = [acc2[0] / wSum, acc2[1] / wSum];
    spirit.centroid3 = [acc3[0] / wSum, acc3[1] / wSum, acc3[2] / wSum];
    if (!Number.isFinite(spirit.yearMin)) {
      spirit.yearMin = 0;
      spirit.yearMax = 0;
    }
    out.push(spirit);
  }
  out.sort((a, b) => b.nChunks - a.nChunks || a.name.localeCompare(b.name));
  return out;
}

/** First human-readable topic term of a cluster (this build has no LLM names). */
export function regionLabel(cluster: Cluster): string {
  for (const t of cluster.terms || []) {
    const s = t.trim();
    if (s.length >= 3 && /[a-z]/i.test(s) && !/^\d/.test(s)) return s;
  }
  return `region ${cluster.id}`;
}

export function nearestCluster(
  clusters: Cluster[],
  x01: number,
  y01: number,
): Cluster | null {
  let best: Cluster | null = null;
  let bestD = Infinity;
  for (const c of clusters) {
    const dx = c.center[0] - x01;
    const dy = c.center[1] - y01;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Normalized reference as returned by /api/seance (PC query server shape:
 *  n/filename/apa/intext/drive_url/hades_path/pages — tolerated loosely). */
export interface SeanceRef {
  n: string;
  filename: string;
  apa: string;
  intext: string;
  pages: number[];
  link: string;
}

export function normalizeRefs(raw: unknown): SeanceRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SeanceRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const filename = String(rec.filename ?? rec.file ?? "").trim();
    const apa = String(rec.apa ?? "").trim();
    if (!filename && !apa) continue;
    const rawPages = rec.pages;
    const pages = Array.isArray(rawPages)
      ? rawPages.map((p) => Number(p)).filter((p) => Number.isFinite(p))
      : String(rawPages ?? "")
          .split(/[,\s]+/)
          .map((p) => Number(p))
          .filter((p) => Number.isFinite(p) && p > 0);
    out.push({
      n: String(rec.n ?? ""),
      filename,
      apa,
      intext: String(rec.intext ?? "").trim(),
      pages,
      link: String(rec.drive_url || rec.link || rec.hades_path || "").trim(),
    });
  }
  return out;
}

/** A cited paper resolved onto the map: where this part of the answer came from. */
export interface CitedSite {
  paperIdx: number;
  filename: string;
  apa: string;
  intext: string;
  /** paper centroid, [0,1]² */
  pos: [number, number];
  clusterId: number;
  region: string;
  color: string;
}

function fileKey(f: string): string {
  const base = f.split(/[\\/]/).pop() || f;
  return base.toLowerCase();
}

export function resolveCitations(
  refs: SeanceRef[],
  papers: Paper[],
  clusters: Cluster[],
): CitedSite[] {
  const byFile = new Map<string, number>();
  papers.forEach((p, i) => byFile.set(fileKey(p.file), i));
  const seen = new Set<number>();
  const out: CitedSite[] = [];
  for (const r of refs) {
    if (!r.filename) continue;
    const idx = byFile.get(fileKey(r.filename));
    if (idx === undefined || seen.has(idx)) continue;
    seen.add(idx);
    const paper = papers[idx];
    const cluster = nearestCluster(clusters, paper.centroid[0], paper.centroid[1]);
    out.push({
      paperIdx: idx,
      filename: r.filename,
      apa: r.apa,
      intext: r.intext || `${paper.authors} (${paper.year})`,
      pos: paper.centroid,
      clusterId: cluster?.id ?? -1,
      region: cluster ? regionLabel(cluster) : "uncharted",
      color: cluster ? clusterColor(cluster.id) : "#898781",
    });
  }
  return out;
}

/** Drop a trailing "### References" block — the structured references array is
 *  rendered separately, so the in-answer list would duplicate it. */
export function stripReferencesSection(text: string): string {
  const m = text.search(/^\s{0,3}(?:#{1,6}\s*|\*\*)?references\*{0,2}\s*:?\s*$/im);
  return (m === -1 ? text : text.slice(0, m)).trim();
}
