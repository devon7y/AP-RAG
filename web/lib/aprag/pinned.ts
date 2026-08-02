// Pinned-paper retrieval — when the user pins ≥2 specific papers (the composer's Papers
// filter), each paper is retrieved INDEPENDENTLY so every pinned paper is represented in
// the context (one shared top_k would let one paper crowd out the rest — the point of
// pinning several papers is to weigh or compare exactly these). Mirrors the digest's
// bucket-merge: per-retrieval reference_ids are re-keyed into one global sequence so the
// [n]/citation plumbing works unchanged.

import { CITATION_STYLE_PROMPT } from "./citations";
import type { RetrieveResult } from "./client";
import type { RagChunk, RagReference } from "./types";

export type PinnedRetrieval = { filename: string; result: RetrieveResult };

export type MergedPinned = {
  references: RagReference[]; // globally re-keyed, one per pinned paper with passages
  chunks: RagChunk[]; // reference_id re-keyed, grouped in pinned order
  emptyPapers: string[]; // pinned papers that returned no passages for this question
};

export function mergePinnedRetrievals(items: PinnedRetrieval[]): MergedPinned {
  const references: RagReference[] = [];
  const chunks: RagChunk[] = [];
  const emptyPapers: string[] = [];
  const seenChunkIds = new Set<string>();
  let nextRef = 0;

  for (const { filename, result } of items) {
    const valid = new Set(
      result.references.map((r) => r.reference_id).filter(Boolean)
    );
    const usable = result.chunks.filter(
      (c) => c.content && c.reference_id && valid.has(c.reference_id)
    );
    if (usable.length === 0) {
      emptyPapers.push(filename);
      continue;
    }
    // A single-paper retrieval normally yields exactly one reference, but re-key via a
    // map so an unexpected multi-reference payload still merges coherently.
    const idMap = new Map<string, string>();
    for (const c of usable) {
      const oldId = c.reference_id as string;
      let gid = idMap.get(oldId);
      if (!gid) {
        gid = String(++nextRef);
        idMap.set(oldId, gid);
        const ref = result.references.find((r) => r.reference_id === oldId);
        if (ref) {
          references.push({ ...ref, reference_id: gid });
        }
      }
      const cid = c.chunk_id || `${c.file_path}:${c.content.slice(0, 48)}`;
      if (seenChunkIds.has(cid)) {
        continue;
      }
      seenChunkIds.add(cid);
      chunks.push({ ...c, reference_id: gid });
    }
  }

  return { references, chunks, emptyPapers };
}

/**
 * The [n]-tagged, paper-grouped context for pinned-paper synthesis. Stamps a global
 * `citeIndex` on each chunk (same contract as buildContext — the UI maps citations back
 * to exact passages) but groups the passages under their paper, so the model can weigh
 * and compare the pinned papers directly.
 */
export function buildPinnedContext(merged: MergedPinned): string {
  let n = 0;
  const sections: string[] = [];
  for (const ref of merged.references) {
    const cs = merged.chunks.filter((c) => c.reference_id === ref.reference_id);
    const lines: string[] = [];
    for (const c of cs) {
      c.citeIndex = ++n;
      lines.push(`[${c.citeIndex}] ${c.content}`);
    }
    const label = ref.intext || ref.filename || `paper ${ref.reference_id}`;
    sections.push(`=== Pinned paper: ${label} ===\n${lines.join("\n\n")}`);
  }
  const missing =
    merged.emptyPapers.length > 0
      ? `\n\nPinned papers with no retrievable passages for this question: ${merged.emptyPapers
          .map((f) => f.replace(/\.pdf$/i, ""))
          .join(", ")}.`
      : "";
  const body = sections.join("\n\n") || "(no sources retrieved)";
  return `-----Sources, grouped by pinned paper (cite each supporting passage by its bracketed number)-----\n${body}${missing}`;
}

export function buildPinnedSystemPrompt(nPapers: number): string {
  return (
    "You are a research assistant answering from a SPECIFIC SET of papers the user " +
    `has pinned (${nPapers} papers; the Sources are grouped by paper). Answer the ` +
    "user's question using ONLY the provided Sources; do not rely on outside knowledge " +
    "and do not invent sources. Draw on EVERY pinned paper that has relevant passages — " +
    "do not let one paper dominate. When the user asks to compare, contrast, or relate " +
    "the papers (or the question is naturally comparative), organize the answer around " +
    "the comparison: what each paper asks, how their methods differ, where their " +
    "findings agree or disagree, and what the differences mean. If a pinned paper " +
    "offers nothing on the question, say so briefly rather than padding. After each " +
    "statement, cite its supporting passage(s) by the bracketed number, e.g. [2] or " +
    "[1][3]. Use ONLY the bracket numbers from the Sources. IMPORTANT: ignore and " +
    "NEVER reproduce bracketed numbers that appear inside the passage text itself — " +
    "those are the papers' own citations. Do NOT output a 'References', 'Sources', or " +
    "bibliography section — the application renders the reference list itself. Write " +
    "clear markdown prose. Write any mathematical notation as LaTeX delimited by $...$ " +
    "(inline) or $$...$$ (display).\n\n" +
    CITATION_STYLE_PROMPT
  );
}
