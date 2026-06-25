// Client-side citation handling — the lightweight half of apa_citations.py. The heavy
// APA7 *formatting* (author parsing, format_apa7/format_intext) is already done by the
// query server and arrives on each reference as `apa` + `intext`; here we only:
//   * build the [n]-tagged synthesis context + the citation-style system prompt,
//   * rewrite the answer's [n] / ([1],[3]) clusters into clickable APA in-text cites,
//   * collect the reference ids the answer actually cites,
//   * format PDF page locators.
// Mirrors rewrite_intext / _collapse_redundant_citations / strip logic in
// apa_citations.py so the web answer matches `aprag ask`.

import type { RagChunk, RagReference } from "./types";

// Same citation-style instruction the server feeds LightRAG, so the answer emits clean
// bracketed [n] markers we can rewrite to (Author, Year).
const CITATION_STYLE_PROMPT =
  'Citation style (APA7): cite each supporting source by placing its bracketed ' +
  'reference number directly after the statement it supports, e.g. "Lexical decision ' +
  'times fall as word frequency rises [2]." Use the bracket only — do NOT add words ' +
  'such as "see", "cf.", "e.g.", or "Supported by" before it, do NOT wrap it in extra ' +
  'parentheses, and do NOT cite the same source more than once in a sentence. When ' +
  'several sources support one statement, group them in adjacent brackets, e.g. "… as ' +
  'widely reported [1][3]."';

export const SYNTH_SYSTEM_PROMPT =
  "You are a research assistant answering questions from a corpus of academic papers. " +
  "Answer the user's question using ONLY the information in the provided Document " +
  "Chunks; do not rely on outside knowledge and do not invent sources. Cite by the " +
  "bracketed reference_id from the Reference Document List. If the chunks do not " +
  "address the question, say so plainly. Do NOT write a 'References' section yourself " +
  "— the application renders the reference list. Keep the answer focused and well " +
  "structured (use markdown).\n\n" +
  CITATION_STYLE_PROMPT;

// The [n]-tagged context block handed to the synthesis model. Mirrors
// aprag_search.build_synthesis_context.
export function buildContext(
  references: RagReference[],
  chunks: RagChunk[]
): string {
  const refLines = references
    .map((r) => `[${r.reference_id}] ${r.filename || r.file_path}`)
    .join("\n");
  const chunkLines = chunks
    .filter((c) => c.content)
    .map((c) => `[${c.reference_id ?? ""}] ${c.content}`)
    .join("\n\n");
  return `-----Reference Document List-----\n${refLines}\n\n-----Document Chunks-----\n${chunkLines}`;
}

// Citation token grammar (ported from apa_citations.py).
const BRACKET = String.raw`\[[ \t]*\d+(?:[ \t]*[,;][ \t]*\d+)*[ \t]*\]`;
const RUN = `${BRACKET}(?:[ \\t]*[,;]?[ \\t]*${BRACKET})*`;
const CLUSTER = `\\([ \\t]*(${RUN})[ \\t]*\\)|(${RUN})`;

/** Reference ids the answer body actually cites (so we list only those, like the CLI). */
export function citedIds(text: string): Set<string> {
  const ids = new Set<string>();
  if (!text) {
    return ids;
  }
  for (const m of text.matchAll(new RegExp(BRACKET, "g"))) {
    for (const n of m[0].matchAll(/\d+/g)) {
      ids.add(n[0]);
    }
  }
  return ids;
}

/**
 * Replace numeric in-text citations with APA7 parentheticals, each a clickable link to
 * the cited paper (Google Drive when available, else an in-page anchor). `[1]` →
 * `([Smith, 2020](url))`; `([1], [3])` → `(A, 2018; B et al., 2020)` de-duplicated and
 * alphabetised. Unknown ids leave the cluster untouched (defensive). Safe to run on a
 * partially-streamed string — an unterminated `[1` simply doesn't match yet.
 */
export function rewriteIntext(
  text: string,
  byId: Map<string, { intext: string; href?: string }>
): string {
  if (!text || byId.size === 0) {
    return text;
  }
  return text.replace(new RegExp(CLUSTER, "g"), (match, g1, g2) => {
    const body: string = g1 ?? g2;
    const seen = new Set<string>();
    const items: { intext: string; href?: string }[] = [];
    for (const m of body.matchAll(/\d+/g)) {
      const cid = m[0];
      if (seen.has(cid)) {
        continue;
      }
      seen.add(cid);
      const ref = byId.get(cid);
      if (!ref) {
        return match; // unknown id → leave cluster as-is
      }
      items.push(ref);
    }
    if (items.length === 0) {
      return match;
    }
    items.sort((a, b) => a.intext.toLowerCase().localeCompare(b.intext.toLowerCase()));
    const labels = items.map((r) =>
      r.href ? `[${r.intext}](${r.href})` : r.intext
    );
    return `(${labels.join("; ")})`;
  });
}

const PAREN_CITE = String.raw`\([^()]*\b\d{4}[a-z]?\b[^()]*\)`;

/** Undo accidental double-parens / "see (…)" wrappers and immediate dupes. */
export function collapseRedundantCitations(text: string): string {
  if (!text) {
    return text;
  }
  const wrap = new RegExp(
    String.raw`\(\s*(?:see|cf\.?|e\.g\.?,?|supported by|sources?:?)?\s*(` +
      PAREN_CITE +
      String.raw`)\s*\)`,
    "gi"
  );
  let prev: string | null = null;
  let out = text;
  while (prev !== out) {
    prev = out;
    out = out.replace(wrap, "$1");
  }
  return out.replace(new RegExp(`(${PAREN_CITE})\\s*\\.?\\s*\\1`, "g"), "$1");
}

/** APA page locator for a list of PDF pages: 'p. 12' / 'pp. 3, 12, 19' (else ''). */
export function formatPages(pages: number[] | undefined): string {
  const nums = [
    ...new Set((pages ?? []).map(Number).filter((n) => Number.isFinite(n))),
  ].sort((a, b) => a - b);
  if (nums.length === 0) {
    return "";
  }
  const body = nums.join(", ");
  return nums.length === 1 ? `p. ${body}` : `pp. ${body}`;
}
