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
export const CITATION_STYLE_PROMPT =
  'Citation style (APA7): cite each supporting source by placing its bracketed ' +
  'reference number directly after the statement it supports and INSIDE the sentence — ' +
  'before the closing period, never after it, e.g. "Lexical decision times fall as word ' +
  'frequency rises [2]." not "…rises. [2]". Use the bracket only — do NOT add words ' +
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
  // KaTeX treats "%" as a line comment, so a bare "%" inside math (e.g. $71.3%$) swallows
  // the rest of the expression. Escape it to "\%" — but only WITHIN math spans, never in
  // prose (where "\%" would render literally).
  const escPct = (s: string) => s.replace(/(?<!\\)%/g, "\\%");
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, body) => `\n$$${body}$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body) => `$${body}$`)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_m, body) => `$$${escPct(body)}$$`)
    .replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (_m, body) => `$${escPct(body)}$`);
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

// A bracketed citation run: "[2]", "[2][3]", "[1, 4]".
const CITATION_RUN = String.raw`(?:\[[ \t]*\d+(?:[ \t]*[,;][ \t]*\d+)*[ \t]*\])+`;
// Sentence-final punctuation followed by a citation run that belongs inside the sentence.
const TRAILING_CITATION_RE = new RegExp(
  String.raw`([.!?])([)"'”’\]]*)[ \t]*(${CITATION_RUN})`,
  "g"
);
// Periods that end an abbreviation rather than a sentence — moving a citation across
// one of these would produce "et al [2]." instead of "et al. [2]".
const ABBREVIATION_RE =
  /(?:^|[\s(])(?:al|e\.g|i\.e|cf|vs|etc|Fig|Eq|Ref|No|pp?|Ch|Dr|Prof|Mr|Mrs|Ms|St|Jr|Sr|approx|ca)\.$/i;

/**
 * Move a citation that trails a sentence back inside it: "…are local. [2][3] Its main…"
 * becomes "…are local [2][3]. Its main…", which is where APA puts it.
 *
 * The models mostly follow the instruction to cite before the period, but not reliably,
 * and a citation stranded after the full stop reads as though it belongs to the *next*
 * sentence. Runs on the raw bracket markers, before they are rewritten into APA form.
 */
export function citationsInsideSentence(text: string): string {
  if (!text) {
    return text;
  }
  return text.replace(
    TRAILING_CITATION_RE,
    (match, punctuation: string, closers: string, cites: string, offset: number) => {
      if (punctuation === "." && ABBREVIATION_RE.test(text.slice(0, offset + 1))) {
        return match;
      }
      // A closing quote or bracket means the sentence ends something quoted; moving the
      // citation inside it would attribute the quotation itself, so leave it be.
      if (closers) {
        return match;
      }
      // Keep a single space before the citation unless one is already there.
      const spacer = /\s/.test(text[offset - 1] ?? "") ? "" : " ";
      return `${spacer}${cites}${punctuation}${closers}`;
    }
  );
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

// ── Year letters (2014a / 2014b) ─────────────────────────────────────────────
// Every same-author-same-year PDF in the corpus carries a letter in its filename so the
// files sort unambiguously, and the server stamps it onto the citation. But the letter
// means nothing to a reader unless the answer in front of them cites two works that
// would otherwise look identical, so it is decided per answer — and only the browser
// knows which papers the answer ended up citing.

/** "Chen et al., 2014b" → the citation without its letter, plus the letter. */
const INTEXT_YEAR_LETTER = /^(.*\b\d{4})([a-z])$/;
/** The year in a formatted APA entry: "… (2014b). Title …". */
const APA_YEAR_LETTER = /\((\d{4})([a-z])?\)/;

export function splitYearLetter(intext: string): {
  base: string;
  letter: string;
} {
  const m = INTEXT_YEAR_LETTER.exec((intext ?? "").trim());
  return m
    ? { base: m[1], letter: m[2] }
    : { base: (intext ?? "").trim(), letter: "" };
}

export function setIntextLetter(intext: string, letter: string): string {
  return `${splitYearLetter(intext).base}${letter}`;
}

export function setApaLetter(apa: string, letter: string): string {
  return (apa ?? "").replace(APA_YEAR_LETTER, `($1${letter})`);
}

type DisambigRef = { reference_id: string; intext: string; filename?: string };

/**
 * reference_id → the year letter it should show, decided across the papers an answer
 * actually cites. Works that stand alone lose their letter; genuine collisions keep the
 * stored letters when those already tell them apart (so the citation still matches the
 * filename in the reader), and otherwise get a, b, c… in citation order.
 */
export function disambiguationLetters(refs: DisambigRef[]): Map<string, string> {
  const groups = new Map<string, DisambigRef[]>();
  for (const ref of refs) {
    const key = splitYearLetter(ref.intext).base.toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.push(ref);
    } else {
      groups.set(key, [ref]);
    }
  }

  const out = new Map<string, string>();
  for (const group of groups.values()) {
    // Two references to the SAME paper are not a collision.
    const papers = new Set(group.map((r) => r.filename || r.reference_id));
    if (papers.size < 2) {
      for (const ref of group) {
        out.set(ref.reference_id, "");
      }
      continue;
    }
    const stored = group.map((r) => splitYearLetter(r.intext).letter);
    const distinct = new Set(stored);
    if (stored.every(Boolean) && distinct.size === stored.length) {
      group.forEach((ref, i) => out.set(ref.reference_id, stored[i]));
      continue;
    }
    group.forEach((ref, i) =>
      out.set(ref.reference_id, i < 26 ? String.fromCharCode(97 + i) : "")
    );
  }
  return out;
}

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
    const papers = [...byPaper.values()].sort((a, b) =>
      a.intext.toLowerCase().localeCompare(b.intext.toLowerCase())
    );
    // Put the parentheses INSIDE the link text (opening on the first citation, closing on
    // the last) so the "(" / ")" travel with the adjacent citation and never wrap onto
    // their own line. The anchor renders with white-space: nowrap.
    const parts = papers.map((p, i) => {
      const enc = [...p.indices].sort((x, y) => x - y).join("_");
      let label = p.intext;
      if (i === 0) {
        label = `(${label}`;
      }
      if (i === papers.length - 1) {
        label = `${label})`;
      }
      return `[${label}](#cite-${enc})`;
    });
    return parts.join("; ");
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
