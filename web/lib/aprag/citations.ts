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
  "Answer the user's question using ONLY the information in the provided Sources; do " +
  "not rely on outside knowledge and do not invent sources. After each statement, cite " +
  "its supporting source(s) by the bracketed number, e.g. [2] or [1][3]. Use ONLY the " +
  "bracket numbers from the Sources list. IMPORTANT: ignore and NEVER reproduce any " +
  "bracketed numbers that appear inside the source text itself (e.g. a passage's own " +
  "[11] or [12]) — those are the papers' internal citations, not your sources. Do NOT " +
  "output a 'References', 'Sources', or bibliography section, and do NOT restate the " +
  "list of sources anywhere — the application renders the reference list itself. Each " +
  "bracketed [n] is a distinct source PASSAGE; cite the specific passage(s) that support " +
  "each statement (a paper may appear as several passages). If the " +
  "sources do not address the question, say so plainly. Write clear markdown prose. " +
  "Write any mathematical notation as LaTeX delimited by $...$ (inline) or $$...$$ " +
  "(display) — never \\(...\\) or \\[...\\].\n\n" +
  CITATION_STYLE_PROMPT;

// gpt-5.4-mini often emits LaTeX with \(...\) / \[...\] delimiters, which markdown
// renders as literal parentheses/brackets (the math plugin only sees $...$ / $$...$$).
// Convert them so KaTeX renders the math. Leaves existing $/$$ untouched.
export function normalizeMath(text: string): string {
  if (!text) {
    return text;
  }
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `\n$$${body}$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => `$${body}$`);
}

// The [n]-tagged context handed to the synthesis model. Each eligible chunk is numbered
// individually (a per-PASSAGE citeIndex, stamped onto the chunk so the UI can map a
// citation back to the exact passage); multiple passages from one paper get distinct
// numbers. We deliberately omit a separate "Reference Document List" (LLMs echo it). The
// app renders the actual reference list from the metadata.
export function buildContext(
  references: RagReference[],
  chunks: RagChunk[]
): string {
  const valid = new Set(references.map((r) => r.reference_id));
  let n = 0;
  const lines: string[] = [];
  for (const c of chunks) {
    if (!(c.content && c.reference_id && valid.has(c.reference_id))) {
      continue;
    }
    c.citeIndex = ++n;
    lines.push(`[${c.citeIndex}] ${c.content}`);
  }
  const body = lines.join("\n\n") || "(no sources retrieved)";
  return `-----Sources (cite each supporting passage by its bracketed number)-----\n${body}`;
}

const REFS_HEADING_RE =
  /^[ \t]{0,3}(?:#{1,6}[ \t]*|\*{1,2}[ \t]*)?(?:references|sources|bibliography|works cited)[ \t]*:?[ \t]*\*{0,2}[ \t]*$/gim;

/**
 * Drop a trailing "References"/"Sources"/"Bibliography" heading and everything after it,
 * in case the answer LLM writes its own list despite instructions (the app renders the
 * real one). Guarded: never strips so much that the answer becomes trivially short — a
 * stray leading "Sources" line won't nuke the whole answer.
 */
export function stripReferencesSection(text: string): string {
  if (!text) {
    return text;
  }
  let last = -1;
  for (const m of text.matchAll(REFS_HEADING_RE)) {
    last = m.index ?? last;
  }
  if (last < 0) {
    return text;
  }
  const head = text.slice(0, last).replace(/\s+$/, "");
  return head.length > 100 ? head : text;
}

// Citation token grammar (ported from apa_citations.py).
const BRACKET = String.raw`\[[ \t]*\d+(?:[ \t]*[,;][ \t]*\d+)*[ \t]*\]`;
const RUN = `${BRACKET}(?:[ \\t]*[,;]?[ \\t]*${BRACKET})*`;
const CLUSTER = `\\([ \\t]*(${RUN})[ \\t]*\\)|(${RUN})`;

// reference_id + APA in-text label for a cited passage number.
export type CiteRef = { referenceId: string; intext: string };

/** The reference_ids (papers) the answer cites, via the passage numbers it used. */
export function citedReferenceIds(
  text: string,
  byCiteIndex: Map<number, CiteRef>
): Set<string> {
  const out = new Set<string>();
  if (!text) {
    return out;
  }
  for (const m of text.matchAll(new RegExp(BRACKET, "g"))) {
    for (const n of m[0].matchAll(/\d+/g)) {
      const ref = byCiteIndex.get(Number(n[0]));
      if (ref) {
        out.add(ref.referenceId);
      }
    }
  }
  return out;
}

/**
 * Rewrite the answer's numeric passage citations into clickable APA in-text cites whose
 * popovers reveal the exact passage(s). A cluster's passage numbers are grouped by paper,
 * so two passages from one paper still read as one "(Author, Year)"; each rendered cite
 * links to `#cite-<passage indices>` so the UI can show those chunks. **Unknown numbers
 * are dropped** (a passage's own internal "[11]" bleeding through); an all-unknown
 * cluster is removed. Safe on partially-streamed text.
 */
export function rewriteIntext(
  text: string,
  byCiteIndex: Map<number, CiteRef>
): string {
  if (!text || byCiteIndex.size === 0) {
    return text;
  }
  return text.replace(new RegExp(CLUSTER, "g"), (_match, g1, g2) => {
    const body: string = g1 ?? g2;
    const byPaper = new Map<string, { intext: string; indices: Set<number> }>();
    for (const m of body.matchAll(/\d+/g)) {
      const idx = Number(m[0]);
      const ref = byCiteIndex.get(idx);
      if (!ref) {
        continue; // unknown passage number → source-text noise
      }
      let entry = byPaper.get(ref.referenceId);
      if (!entry) {
        entry = { intext: ref.intext, indices: new Set() };
        byPaper.set(ref.referenceId, entry);
      }
      entry.indices.add(idx);
    }
    if (byPaper.size === 0) {
      return ""; // all unknown → strip the stray cluster
    }
    const parts = [...byPaper.values()]
      .sort((a, b) => a.intext.toLowerCase().localeCompare(b.intext.toLowerCase()))
      .map((p) => {
        const enc = [...p.indices].sort((x, y) => x - y).join("_");
        return `[${p.intext}](#cite-${enc})`;
      });
    return `(${parts.join("; ")})`;
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
