// "Research Digest" — summarize recent research on a topic with DATE as the primary axis.
// A digest chat's FIRST message runs a special multi-bucket path: the requested date range
// is split into time buckets (months or years), each bucket is retrieved independently with
// a date-window filter, and the passages are stitched into one chronological context whose
// [n] passage-citations run globally across buckets. The synthesis writes dated ### sections
// oldest → newest. Follow-up turns fall back to the normal chat flow (with the range applied
// as a sticky filter) — see the route. Mirrors persona.ts; the [n] citation contract is
// identical, so all citation UI works unchanged.

import { CITATION_STYLE_PROMPT } from "./citations";
import type { RetrieveResult } from "./client";
import type { RagChunk, RagReference } from "./types";

export type DigestBucketUnit = "month" | "year";

// Persisted on the Chat row (jsonb) and echoed on the first message. `from`/`to` are
// concrete "YYYY-MM" (or full dates); `bucket` is resolved from the span. An
// `openEnded` digest's window tracks "now": each run (first or a later refresh)
// regenerates over [from, current month] and advances the stored `to`;
// `refreshedAt`/`papersAtRefresh` record the run for the /digest library's
// "+N papers since last update" badge.
export type DigestConfig = {
  topic: string;
  from: string; // inclusive start, "YYYY-MM" | "YYYY-MM-DD"
  to: string; // inclusive end (last refresh's "now" when openEnded)
  bucket: DigestBucketUnit;
  openEnded?: boolean;
  refreshedAt?: string; // ISO timestamp of the last generation run
  papersAtRefresh?: number; // corpus size at that run
};

/** The current month as "YYYY-MM" (UTC) — the running end of an open-ended digest. */
export function ymNow(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type DigestBucket = {
  from: string; // "YYYY-MM-DD" inclusive
  to: string; // "YYYY-MM-DD" inclusive
  label: string; // "March 2026" (month) or "2024" (year)
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MAX_BUCKETS = 24;

function ym(s: string): { y: number; m: number } {
  const [y, m] = String(s).split("-");
  return { y: Number(y), m: m ? Number(m) : 1 };
}

function monthIndex(s: string): number {
  const { y, m } = ym(s);
  return y * 12 + (m - 1);
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // m 1-based → day 0 of next month
}

/** Choose month vs year buckets from the span (months when ≤ 18 months, else years). */
export function chooseBucketUnit(from: string, to: string): DigestBucketUnit {
  return monthIndex(to) - monthIndex(from) <= 17 ? "month" : "year";
}

/**
 * Split [from, to] into chronological buckets (oldest → newest). Month buckets when the
 * span is short, else year buckets; if that would exceed MAX_BUCKETS, coarsen to years and
 * keep the most-recent MAX_BUCKETS (the digest's focus is recency).
 */
export function bucketize(from: string, to: string): DigestBucket[] {
  let unit = chooseBucketUnit(from, to);
  const buckets: DigestBucket[] = [];

  if (unit === "month") {
    const start = monthIndex(from);
    const end = monthIndex(to);
    if (end - start + 1 > MAX_BUCKETS) {
      unit = "year"; // too many months → fall through to year buckets
    } else {
      for (let i = start; i <= end; i++) {
        const y = Math.floor(i / 12);
        const m = (i % 12) + 1;
        buckets.push({
          from: `${y}-${String(m).padStart(2, "0")}-01`,
          to: `${y}-${String(m).padStart(2, "0")}-${String(lastDayOfMonth(y, m)).padStart(2, "0")}`,
          label: `${MONTHS[m - 1]} ${y}`,
        });
      }
      return buckets;
    }
  }

  // year buckets
  const fy = ym(from).y;
  const ty = ym(to).y;
  const startYear = Math.max(fy, ty - MAX_BUCKETS + 1);
  for (let y = startYear; y <= ty; y++) {
    buckets.push({ from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}` });
  }
  return buckets;
}

/** Per-bucket `top_k`, scaled down as bucket count grows to keep total context bounded. */
export function bucketTopK(bucketCount: number): number {
  if (bucketCount <= 6) {
    return 10;
  }
  if (bucketCount <= 12) {
    return 8;
  }
  return 6;
}

/** Run `fn` over items with at most `limit` in flight; preserves input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export type BucketRetrieval = { bucket: DigestBucket; result: RetrieveResult };

export type MergedDigest = {
  references: RagReference[]; // globally re-keyed reference_ids
  chunks: RagChunk[]; // reference_id re-keyed, bucketLabel attached, in bucket order
  filledBuckets: string[]; // labels of buckets that returned passages (oldest → newest)
  emptyBuckets: string[]; // labels of buckets with no results (reported as quiet periods)
};

/**
 * Stitch per-bucket retrievals into one payload. Two things to reconcile:
 *  1. Each bucket's /retrieve assigns reference_ids 1..k independently, so they COLLIDE
 *     across buckets — we re-key to one global sequence so the [n]/citation plumbing
 *     (message.tsx byCiteIndex → reference_id → reference) stays coherent.
 *  2. A paper can be returned in SEVERAL buckets: a date-imprecise paper (year-only, or
 *     month-only when bucketing by finer periods) overlaps every bucket inside its interval,
 *     so the date filter matches it in each. We must place each paper in exactly ONE bucket,
 *     else it appears as duplicate references and in multiple sections. We assign it to the
 *     bucket where its best chunk scored highest (the retrieval that "wanted" it most), which
 *     for a precise-dated paper is simply its only bucket.
 */
export function mergeBucketRetrievals(items: BucketRetrieval[]): MergedDigest {
  // Pass 1: for each paper (by file_path), find the bucket index of its highest-scoring chunk.
  const bestBucket = new Map<string, { idx: number; score: number }>();
  items.forEach(({ result }, idx) => {
    const valid = new Set(result.references.map((r) => r.reference_id).filter(Boolean));
    for (const c of result.chunks) {
      if (!(c.content && c.reference_id && valid.has(c.reference_id) && c.file_path)) {
        continue;
      }
      const score = c.score ?? 0;
      const cur = bestBucket.get(c.file_path);
      if (!cur || score > cur.score) {
        bestBucket.set(c.file_path, { idx, score });
      }
    }
  });

  // Pass 2: emit each paper's chunks only in its assigned bucket, deduped, globally re-keyed.
  const references: RagReference[] = [];
  const chunks: RagChunk[] = [];
  const filledBuckets: string[] = [];
  const emptyBuckets: string[] = [];
  const refIdByFile = new Map<string, string>(); // file_path → global reference_id
  const seenChunkIds = new Set<string>();
  let nextRef = 0;

  items.forEach(({ bucket, result }, idx) => {
    const valid = new Set(result.references.map((r) => r.reference_id).filter(Boolean));
    let emitted = 0;
    for (const c of result.chunks) {
      if (!(c.content && c.reference_id && valid.has(c.reference_id) && c.file_path)) {
        continue;
      }
      if (bestBucket.get(c.file_path)?.idx !== idx) {
        continue; // this paper belongs to a different (better) bucket
      }
      const cid = c.chunk_id || `${c.file_path}:${c.content.slice(0, 48)}`;
      if (seenChunkIds.has(cid)) {
        continue;
      }
      seenChunkIds.add(cid);

      let gid = refIdByFile.get(c.file_path);
      if (!gid) {
        gid = String(++nextRef);
        refIdByFile.set(c.file_path, gid);
        const ref = result.references.find((r) => r.reference_id === c.reference_id);
        if (ref) {
          references.push({ ...ref, reference_id: gid });
        }
      }
      chunks.push({ ...c, reference_id: gid, bucketLabel: bucket.label });
      emitted += 1;
    }
    if (emitted > 0) {
      filledBuckets.push(bucket.label);
    } else {
      emptyBuckets.push(bucket.label);
    }
  });

  return { references, chunks, filledBuckets, emptyBuckets };
}

/**
 * The [n]-tagged, bucket-grouped context for the digest synthesis. Stamps a global
 * `citeIndex` on each chunk (like buildContext) but groups the passages under their time
 * bucket, so the model can write dated chronological sections. Each passage line is prefixed
 * with its paper's stored date (at whatever precision we have).
 */
export function buildDigestContext(
  merged: MergedDigest,
  refDate: Map<string, { date?: string; precision?: string }>
): string {
  const byBucket = new Map<string, RagChunk[]>();
  for (const c of merged.chunks) {
    const key = c.bucketLabel ?? "";
    const arr = byBucket.get(key);
    if (arr) {
      arr.push(c);
    } else {
      byBucket.set(key, [c]);
    }
  }

  let n = 0;
  const sections: string[] = [];
  for (const label of merged.filledBuckets) {
    const cs = byBucket.get(label) ?? [];
    const lines: string[] = [];
    for (const c of cs) {
      c.citeIndex = ++n;
      const meta = refDate.get(c.reference_id as string);
      const stamp = meta?.date ? ` (${meta.date})` : "";
      lines.push(`[${c.citeIndex}]${stamp} ${c.content}`);
    }
    sections.push(`=== ${label} ===\n${lines.join("\n\n")}`);
  }

  const quiet =
    merged.emptyBuckets.length > 0
      ? `\n\nQuiet periods (no papers retrieved): ${merged.emptyBuckets.join(", ")}.`
      : "";
  const body = sections.join("\n\n") || "(no sources retrieved in this window)";
  return (
    "-----Sources, grouped by time period (oldest → newest). Cite each supporting " +
    "passage by its bracketed number; the parenthetical is that paper's publication " +
    `date-----\n${body}${quiet}`
  );
}

export function buildDigestSystemPrompt(config: DigestConfig): string {
  const unit = config.bucket === "month" ? "month" : "year";
  return (
    `You are writing a RESEARCH DIGEST: a chronological synthesis of what the corpus says ` +
    `about "${config.topic}" from ${config.from} to ${config.to}, with DATE as the ` +
    "primary axis.\n\n" +
    "Ground EVERY statement ONLY in the provided Sources (passages retrieved from the " +
    "papers, grouped by time period). Do not use outside knowledge and never invent " +
    "findings, dates, or papers.\n\n" +
    "Structure:\n" +
    `• Open with one short orienting sentence naming the topic and window.\n` +
    `• Then write one \`###\` section PER TIME PERIOD that has papers, in order OLDEST → ` +
    `NEWEST (one per ${unit}). Head each section with its period exactly as labelled in the ` +
    "Sources (e.g. `### March 2026`). Summarize what that period's papers contribute — " +
    "methods, findings, debates, new directions.\n" +
    "• Across sections, explicitly connect the story over time: name emerging threads, " +
    "shifts, turning points, and what superseded or built on what. This trajectory is the " +
    "point of the digest — not isolated per-period blurbs.\n" +
    "• Close with a brief `### Trajectory` paragraph on where the topic is heading.\n\n" +
    "Dates & precision: state dates explicitly when they matter. A passage's date is the " +
    "parenthetical after its number. Some papers are known only to the month or year — if " +
    "asked or when ordering closely-dated work, say so plainly (e.g. \"both appeared in " +
    "March 2026; exact days unknown\") rather than inventing a day or a false ordering.\n\n" +
    "If a period is quiet (few or no papers), say so briefly rather than padding.\n\n" +
    "After each statement, cite its supporting passage(s) by the bracketed number, e.g. " +
    "[2] or [1][3]. Use ONLY the bracket numbers from the Sources. IMPORTANT: ignore and " +
    "NEVER reproduce bracketed numbers that appear inside the passage text — those are the " +
    "papers' own citations. Do NOT output a 'References' or 'Sources' section — the app " +
    "renders it. Write clear markdown prose. Write math as LaTeX in $...$ or $$...$$.\n\n" +
    CITATION_STYLE_PROMPT
  );
}
