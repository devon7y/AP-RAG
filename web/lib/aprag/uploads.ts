// Uploaded papers — papers a user brings INTO a chat that are not in the AP-RAG database.
//
// The corpus is built by a batch pipeline on HPC (chunk → contextualize → embed → Qdrant),
// so a PDF dropped into the composer cannot be "ingested" on the spot. Instead an uploaded
// paper lives with its chat: the text is extracted and chunked once at upload time, and on
// every turn the passages that answer the question are picked out here, in-process, and
// merged into the SAME [n]-numbered source list as the database retrieval. From the
// answer's point of view an uploaded passage is just another source — it is cited the same
// way, it appears in the reference list, and its PDF opens in the reader.
//
// Passage selection is lexical (BM25) rather than semantic: the embedding server lives on
// the PC behind the query API and indexes the corpus, not per-chat scratch documents. Over
// one or two papers' worth of chunks BM25 is a reasonable ranker — and when the papers are
// short enough to fit whole (the common case: "summarize this paper"), ranking is skipped
// and the entire text is handed over instead.
//
// This module is pure (no server-only imports) so the composer can share its limits.

import type { RagChunk, RagReference } from "./types";

// ── Limits (shared by the composer and the upload route) ─────────────────────

export const MAX_UPLOADS_PER_CHAT = 6;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_ACCEPT = "application/pdf,.pdf";

// ── Chunking ─────────────────────────────────────────────────────────────────
// A trimmed-down cousin of pipeline/scientific_chunker.py: section-aware, page-aware,
// drops page furniture and the reference list. The corpus chunker is the authority for
// what a good academic chunk is; this one only has to be good enough that a passage reads
// as a coherent excerpt of the paper the user just handed us.

const TARGET_TOKENS = 512;
const MAX_TOKENS = 700;
const MIN_TOKENS = 120;
const OVERLAP_TOKENS = 64;
/** Runaway guard: a 500-page book dropped into the composer is not a paper. */
const MAX_CHUNKS = 600;

/** Rough token estimate (~4 chars/token for English prose) — no tokenizer in the bundle. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type UploadPage = { page: number; text: string };

export type UploadChunk = {
  index: number;
  page: number; // the PDF page the chunk starts on
  section?: string; // nearest preceding section heading, when one was detected
  content: string;
};

// Headings we recognize by name. Everything else is treated as body text, so a stray
// short line can't silently split the paper into fragments.
const SECTION_WORDS = [
  "abstract",
  "introduction",
  "background",
  "related work",
  "literature review",
  "method",
  "methods",
  "methodology",
  "materials and methods",
  "material and methods",
  "participants",
  "subjects",
  "stimuli",
  "materials",
  "procedure",
  "design",
  "apparatus",
  "analysis",
  "data analysis",
  "results",
  "findings",
  "discussion",
  "general discussion",
  "conclusion",
  "conclusions",
  "concluding remarks",
  "limitations",
  "future work",
  "implications",
  "summary",
  "experiment",
  "study",
  "supplementary material",
  "appendix",
  "acknowledgment",
  "acknowledgments",
  "acknowledgement",
  "acknowledgements",
  "references",
  "bibliography",
  "works cited",
  "literature cited",
  "notes",
  "footnotes",
  "funding",
  "conflict of interest",
  "declaration of competing interest",
  "declarations of interest",
  "author contributions",
  "credit authorship contribution statement",
  "data availability",
  "data availability statement",
];

// "3.2 Results", "IV. DISCUSSION", "Experiment 2", "Appendix A" — a number/letter prefix
// or suffix is part of the heading, not evidence against it.
const HEADING_PREFIX = /^(?:[divxlc]+[.)]|\d+(?:\.\d+)*[.)]?)\s+/i;
const HEADING_SUFFIX = /\s+(?:[a-z0-9]|[ivxlc]+)$/i;

/**
 * Sections left out of the retrievable body: the reference list and the end-matter admin.
 * Between them they are a sizeable share of a paper's words and none of its findings, so
 * keeping them mostly buys passages that match on other people's author names.
 */
const EXCLUDED_SECTIONS = new Set([
  "references",
  "bibliography",
  "works cited",
  "literature cited",
  "acknowledgment",
  "acknowledgments",
  "acknowledgement",
  "acknowledgements",
  "funding",
  "conflict of interest",
  "declaration of competing interest",
  "declarations of interest",
  "author contributions",
  "credit authorship contribution statement",
  "data availability",
  "data availability statement",
]);

/** The canonical section name a line names, or null if the line isn't a heading. */
function headingName(line: string): string | null {
  const raw = line.trim();
  if (!raw || raw.length > 80) {
    return null;
  }
  // A heading is a label, not a sentence.
  if (
    /[.;,:]$/.test(raw) &&
    !/^\s*(?:\d+\.)+\s*$/.test(raw) &&
    !raw.endsWith(":")
  ) {
    return null;
  }
  const core = raw
    .replace(/[:.]$/, "")
    .replace(HEADING_PREFIX, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (SECTION_WORDS.includes(core)) {
    return core;
  }
  // "Experiment 2", "Study 1a", "Appendix B".
  const stripped = core
    .replace(HEADING_SUFFIX, "")
    .replace(/\s+\d+[a-z]?$/, "");
  if (stripped !== core && SECTION_WORDS.includes(stripped)) {
    return stripped;
  }
  return null;
}

/** Display form of a canonical heading ("2. RESULTS" → "Results"). */
function headingLabel(canonical: string): string {
  return canonical.replace(/\b\w/g, (c) => c.toUpperCase());
}

const SENTENCE_END = /[.!?]["'”’)\]]?$/;

/**
 * A line that plainly runs on into the next one: it breaks mid-clause, or ends on a word
 * no sentence ends with. Used to tell a short line that is a TITLE from a short line that
 * is simply where the text happened to break.
 */
/** A masthead or a footer line: whatever follows it starts something new. */
const ENDS_WITH_URL = /(?:https?:\/\/|www\.)\S+$/i;

const CONTINUES_ON_NEXT_LINE =
  /(?:[,;:—–-]|\b(?:a|an|the|of|in|on|at|to|for|with|by|from|and|or|but|as|that|which|than|between|during|per|via|into|over|under|is|are|was|were|be|been|we|our|their|its)|\b[A-Z])$/i;

/**
 * A running head carries the page number with it ("PARSING AND MEMORY 441"), so the same
 * furniture is textually different on every page. Comparing without the numbers is what
 * makes it recognizable as furniture at all.
 */
function furnitureKey(line: string): string {
  return line
    .replace(/^\s*\d{1,4}\s+|\s+\d{1,4}\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Lines that repeat across many pages are running heads, journal mastheads and footers,
 * not content — they otherwise land in the middle of chunks and pollute retrieval.
 */
function repeatedLines(pages: UploadPage[]): Set<string> {
  if (pages.length < 4) {
    return new Set();
  }
  const seen = new Map<string, number>();
  for (const p of pages) {
    // Only the top and bottom few lines of a page can be furniture.
    const lines = p.text.split(/\r?\n/).map((l) => l.trim());
    const edges = [...lines.slice(0, 3), ...lines.slice(-3)];
    for (const key of new Set(edges.map(furnitureKey))) {
      if (key.length < 4 || key.length > 120) {
        continue;
      }
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.floor(pages.length * 0.4));
  const out = new Set<string>();
  for (const [key, n] of seen) {
    if (n >= threshold) {
      out.add(key);
    }
  }
  return out;
}

const PAGE_NUMBER_RE = /^[[(]?\d{1,4}[\])]?$/;

type Paragraph = { page: number; text: string; heading: string | null };

/** Re-flow one page's extracted lines into paragraphs and headings. */
function pageParagraphs(page: UploadPage, furniture: Set<string>): Paragraph[] {
  const lines = page.text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t ]+/g, " ").trim());

  const bodyLengths = lines.filter((l) => l.length > 0).map((l) => l.length);
  bodyLengths.sort((a, b) => a - b);
  const median = bodyLengths.length
    ? bodyLengths[Math.floor(bodyLengths.length / 2)]
    : 0;

  const out: Paragraph[] = [];
  let buffer = "";
  // The length of the LAST line folded into the buffer, not of the buffer itself: "is the
  // line above this one short?" is the question, and by the second line the buffer is
  // always long. (A journal masthead runs the width of the page, so measuring the buffer
  // welded every title that followed one onto the text beneath it.)
  let lastLineLength = 0;

  const flush = () => {
    const text = buffer.replace(/\s+/g, " ").trim();
    if (text) {
      out.push({ page: page.page, text, heading: null });
    }
    buffer = "";
    lastLineLength = 0;
  };

  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    if (furniture.has(furnitureKey(line)) || PAGE_NUMBER_RE.test(line)) {
      flush();
      continue;
    }
    const canonical = headingName(line);
    if (canonical) {
      flush();
      out.push({
        page: page.page,
        text: headingLabel(canonical),
        heading: canonical,
      });
      continue;
    }
    if (!buffer) {
      buffer = line;
      lastLineLength = line.length;
      continue;
    }
    // A word broken across a line break: "compre-\nhension".
    if (/[a-z]-$/.test(buffer) && /^[a-z]/.test(line)) {
      buffer = buffer.slice(0, -1) + line;
      lastLineLength = line.length;
      continue;
    }
    const previousLine = buffer.slice(-lastLineLength);
    const startsFresh = /^[A-Z0-9"'(]/.test(line);
    // A line that ends in a URL is the journal's masthead, whatever its length — the
    // paper's title is the next line, not a continuation of nature.com.
    if (ENDS_WITH_URL.test(previousLine) && startsFresh) {
      flush();
      buffer = line;
      lastLineLength = line.length;
      continue;
    }
    // A short line that closes a sentence ends the paragraph — that ragged last line is
    // what a paragraph break looks like once the layout is gone.
    if (
      SENTENCE_END.test(buffer) &&
      median > 0 &&
      lastLineLength < median * 0.75 &&
      startsFresh
    ) {
      flush();
      buffer = line;
      lastLineLength = line.length;
      continue;
    }
    // A line far shorter than the column that does NOT close a sentence is a title, an
    // author line or an unlabelled heading — a paper's own title rarely ends in a full
    // stop. Without this they weld onto the text beneath: "EEG is better left alone
    // Arnaud Delorme Automated preprocessing methods are…", where the first sentence of
    // the abstract is no longer a sentence anyone can quote. The continuation guard keeps
    // genuinely broken-off body text (a line ending in "the", "and", a comma) attached.
    if (
      median > 0 &&
      lastLineLength < median * 0.55 &&
      !CONTINUES_ON_NEXT_LINE.test(previousLine) &&
      startsFresh
    ) {
      flush();
      buffer = line;
      lastLineLength = line.length;
      continue;
    }
    buffer = `${buffer} ${line}`;
    lastLineLength = line.length;
  }
  flush();
  return out;
}

/** Split a long paragraph into sentences (abbreviation- and decimal-safe enough). */
function sentences(text: string): string[] {
  const parts = text.split(
    /(?<![A-Z][a-z]?\.)(?<!\b(?:al|e\.g|i\.e|cf|vs|etc|Fig|Eq|Ref|No|pp|Ch|Dr|Prof|Mr|Mrs|Ms|St|Jr|Sr|approx|ca)\.)(?<!\d\.)(?<=[.!?])["'”’)\]]?\s+(?=[A-Z("'“])/
  );
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * The trailing sentences of a chunk, up to the overlap budget — the run-on into the next
 * chunk that keeps a passage from starting mid-argument.
 *
 * The budget is a hard cap. Text with no sentence punctuation at all (tables, formulae,
 * an OCR run-on) would otherwise hand back the whole chunk as "the last sentence", which
 * the next flush carries forward again, and each chunk comes out bigger than the last.
 */
function overlapTail(text: string): string {
  const budget = OVERLAP_TOKENS * 4; // characters
  const kept: string[] = [];
  let chars = 0;
  const ss = sentences(text);
  for (let i = ss.length - 1; i >= 0; i--) {
    if (chars + ss[i].length > budget) {
      break;
    }
    kept.unshift(ss[i]);
    chars += ss[i].length + 1;
  }
  if (kept.length > 0) {
    return kept.join(" ");
  }
  // No sentence fits: overlap on the tail words instead of repeating the chunk.
  const tail = text.slice(-budget);
  const space = tail.indexOf(" ");
  return space >= 0 ? tail.slice(space + 1) : "";
}

/**
 * Page-by-page extracted text → retrievable chunks. Section headings start a new chunk and
 * label the ones that follow; References/Acknowledgements-style sections are skipped
 * (they are citations and admin, and they crowd out real passages), resuming at the next
 * substantive heading so an appendix after the references is not lost.
 */
export function chunkPages(pages: UploadPage[]): UploadChunk[] {
  const furniture = repeatedLines(pages);
  const paragraphs = pages.flatMap((p) => pageParagraphs(p, furniture));

  const chunks: UploadChunk[] = [];
  let buffer = "";
  let bufferPage = pages[0]?.page ?? 1;
  let section: string | undefined;
  let excluded = false;

  const flush = () => {
    const text = buffer.trim();
    buffer = "";
    if (!text) {
      return;
    }
    // A scrap left over at a section boundary rides on the previous chunk when it fits
    // there — a two-line passage retrieves badly on its own and reads worse.
    const previous = chunks.at(-1);
    if (
      estimateTokens(text) < MIN_TOKENS &&
      previous &&
      previous.section === section &&
      estimateTokens(previous.content) + estimateTokens(text) <= MAX_TOKENS
    ) {
      previous.content = `${previous.content} ${text}`;
      return;
    }
    chunks.push({
      index: chunks.length,
      page: bufferPage,
      section,
      content: text,
    });
  };

  /**
   * `separator` is what holds the paragraph structure together inside a chunk. Joining
   * paragraphs with a space is what let a title, an author line and an abstract arrive as
   * one undifferentiated sentence — asked to quote the first sentence of the abstract, a
   * reader of that text can only guess. A newline (not a blank line: chunk cards read a
   * leading blank-line-delimited段 as a situating blurb) keeps them apart.
   */
  const push = (piece: string, page: number, separator = "\n") => {
    if (chunks.length >= MAX_CHUNKS) {
      return;
    }
    // Text with no sentence structure at all — a table, a formula block, a column of
    // numbers — has to be cut somewhere, or it lands as one enormous chunk. Cut on a word
    // boundary when there is one near the limit, and on the limit itself when there isn't.
    if (estimateTokens(piece) > MAX_TOKENS) {
      const limit = MAX_TOKENS * 4;
      let rest = piece;
      while (estimateTokens(rest) > MAX_TOKENS) {
        const space = rest.lastIndexOf(" ", limit);
        const at = space > limit / 2 ? space : limit;
        push(rest.slice(0, at), page, separator);
        rest = rest.slice(at).trim();
      }
      push(rest, page, separator);
      return;
    }
    if (!buffer) {
      bufferPage = page;
      buffer = piece;
      return;
    }
    const combined = estimateTokens(buffer) + estimateTokens(piece);
    if (combined > MAX_TOKENS) {
      const tail = overlapTail(buffer);
      flush();
      bufferPage = page;
      buffer = tail ? `${tail}${separator}${piece}` : piece;
      return;
    }
    buffer = `${buffer}${separator}${piece}`;
    if (estimateTokens(buffer) >= TARGET_TOKENS) {
      const tail = overlapTail(buffer);
      flush();
      bufferPage = page;
      buffer = tail;
    }
  };

  for (const para of paragraphs) {
    if (chunks.length >= MAX_CHUNKS) {
      break;
    }
    if (para.heading) {
      flush();
      excluded = EXCLUDED_SECTIONS.has(para.heading);
      section = excluded ? undefined : para.text;
      continue;
    }
    if (excluded) {
      continue;
    }
    if (estimateTokens(para.text) > MAX_TOKENS) {
      // Sentences of one paragraph belong on one line; only paragraphs get a break.
      for (const s of sentences(para.text)) {
        push(s, para.page, " ");
      }
      continue;
    }
    push(para.text, para.page);
  }
  flush();

  // A paper whose every heading looked like a reference list (or that has no headings and
  // one giant paragraph) must still be searchable — fall back to the raw text.
  if (chunks.length === 0) {
    const all = pages
      .map((p) => p.text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    if (all) {
      for (const s of sentences(all)) {
        push(s, pages[0]?.page ?? 1);
      }
      flush();
    }
  }
  return chunks;
}

// ── Passage selection ────────────────────────────────────────────────────────

/** The stored shape of an uploaded paper, as the chat route reads it back. */
export type UploadedPaper = {
  id: string;
  filename: string; // the name the user's file had
  title: string;
  intext: string; // "Smith et al., 2019" (or the filename when unknown)
  apa: string; // reference-list entry
  pageCount: number;
  chunks: UploadChunk[];
};

/**
 * How much of the attached papers goes in front of the model each turn. One budget, not a
 * threshold plus a smaller allowance: what the model sees is min(attached, budget), so
 * crossing the line changes WHICH text is chosen, never how much. 30k covers essentially
 * every journal article whole; above it (a book, a chapter, several papers at once) the
 * same 30k is spent on the passages that answer the question.
 */
const UPLOAD_TOKEN_BUDGET = 30_000;
/**
 * When the question shares almost no words with the papers, the ranking has little to go
 * on and stops early. Top up to at least this much from the front of each paper (title
 * block, abstract, introduction) rather than spending the whole budget on a weak match.
 */
const MIN_UPLOAD_TOKENS = 6000;
/** Every uploaded paper is represented, even when another one dominates the ranking. */
const MIN_PASSAGES_PER_PAPER = 2;

const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "more",
  "most",
  "my",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "out",
  "over",
  "own",
  "paper",
  "papers",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "you",
  "your",
  "yours",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t)
  );
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

type Scored = { paperIndex: number; chunk: UploadChunk; score: number };

/**
 * BM25 over the pooled chunks of every uploaded paper. Pooled rather than per-paper so the
 * scores are comparable across papers when the budget has to be shared between them.
 */
function scoreChunks(
  papers: UploadedPaper[],
  query: string
): { scored: Scored[]; anyMatch: boolean } {
  const docs: { paperIndex: number; chunk: UploadChunk; terms: string[] }[] =
    [];
  for (const [paperIndex, paper] of papers.entries()) {
    for (const chunk of paper.chunks) {
      docs.push({ paperIndex, chunk, terms: tokenize(chunk.content) });
    }
  }
  const queryTerms = [...new Set(tokenize(query))];
  if (docs.length === 0 || queryTerms.length === 0) {
    return {
      scored: docs.map((d) => ({
        paperIndex: d.paperIndex,
        chunk: d.chunk,
        score: 0,
      })),
      anyMatch: false,
    };
  }

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) {
      if (queryTerms.includes(term)) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }
  }
  const avgLen =
    docs.reduce((sum, d) => sum + d.terms.length, 0) / Math.max(1, docs.length);

  let anyMatch = false;
  const scored = docs.map((doc) => {
    const counts = new Map<string, number>();
    for (const term of doc.terms) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
    let score = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) {
        continue;
      }
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      const norm =
        (tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.terms.length) / avgLen));
      score += idf * norm;
    }
    if (score > 0) {
      anyMatch = true;
    }
    return { paperIndex: doc.paperIndex, chunk: doc.chunk, score };
  });
  return { scored, anyMatch };
}

export type UploadSelection = {
  references: RagReference[];
  chunks: RagChunk[];
  /** "full" = the papers were short enough to include whole; "ranked" = top passages. */
  strategy: "full" | "ranked";
};

/** The synthetic corpus-style filename an uploaded paper is served under. */
export function uploadPdfName(id: string): string {
  return `upload-${id}.pdf`;
}

export function isUploadPdfName(name: string): boolean {
  return /^upload-[0-9a-f-]{36}\.pdf$/i.test(name.trim());
}

export function uploadIdFromPdfName(name: string): string | null {
  const m = /^upload-([0-9a-f-]{36})\.pdf$/i.exec(name.trim());
  return m ? m[1] : null;
}

function toRagChunk(
  paper: UploadedPaper,
  chunk: UploadChunk,
  referenceId: string,
  score: number | null
): RagChunk {
  return {
    content: chunk.content,
    file_path: paper.filename,
    chunk_id: `${paper.id}:${chunk.index}`,
    reference_id: referenceId,
    score,
    page: chunk.page,
  };
}

function toRagReference(
  paper: UploadedPaper,
  referenceId: string,
  pages: number[]
): RagReference {
  return {
    reference_id: referenceId,
    file_path: paper.filename,
    apa: paper.apa || paper.title || paper.filename,
    intext: paper.intext || paper.filename.replace(/\.pdf$/i, ""),
    filename: uploadPdfName(paper.id),
    drive_url: "",
    hades_path: "",
    pages,
    uploaded: true,
    uploadedName: paper.filename,
  };
}

/**
 * The uploaded-paper passages to put in front of the answer model this turn.
 *
 * Papers that fit the budget go in WHOLE — the usual request ("summarize this", "what did
 * they find?") is about the paper as a whole, and a ranked excerpt answers it worse than
 * the paper does. Only what does not fit is ranked, and then the same budget is spent on
 * the best-matching passages, with a floor per paper so a second uploaded paper is never
 * squeezed out entirely and a fall back to each paper's opening pages when the question
 * shares no words with any of them (which is exactly what "summarize the attached paper"
 * looks like to a lexical ranker).
 */
export function selectUploadPassages(
  papers: UploadedPaper[],
  query: string
): UploadSelection {
  const usable = papers.filter((p) => p.chunks.length > 0);
  if (usable.length === 0) {
    return { references: [], chunks: [], strategy: "ranked" };
  }

  const totalTokens = usable.reduce(
    (sum, p) =>
      sum + p.chunks.reduce((s, c) => s + estimateTokens(c.content), 0),
    0
  );

  const picked = new Map<number, UploadChunk[]>();
  let strategy: UploadSelection["strategy"] = "ranked";

  if (totalTokens <= UPLOAD_TOKEN_BUDGET) {
    strategy = "full";
    for (const [i, paper] of usable.entries()) {
      picked.set(i, [...paper.chunks]);
    }
  } else {
    const { scored, anyMatch } = scoreChunks(usable, query);
    const byPaper = new Map<number, Scored[]>();
    for (const s of scored) {
      const list = byPaper.get(s.paperIndex);
      if (list) {
        list.push(s);
      } else {
        byPaper.set(s.paperIndex, [s]);
      }
    }
    // No lexical overlap at all: lead with the front of each paper (title block, abstract,
    // introduction) rather than an arbitrary tie-break.
    const rank = (list: Scored[]) =>
      anyMatch
        ? [...list].sort(
            (a, b) => b.score - a.score || a.chunk.index - b.chunk.index
          )
        : [...list].sort((a, b) => a.chunk.index - b.chunk.index);

    const taken = new Set<string>();
    const key = (s: Scored) => `${s.paperIndex}:${s.chunk.index}`;
    const perPaperRanked = new Map<number, Scored[]>();
    for (const [i, list] of byPaper) {
      perPaperRanked.set(i, rank(list));
    }

    // The budget is spent in tokens, not passages, so a paper of long passages and one of
    // short passages get the same amount of the model's attention.
    let spent = 0;
    const add = (s: Scored) => {
      if (taken.has(key(s))) {
        return false;
      }
      taken.add(key(s));
      spent += estimateTokens(s.chunk.content);
      const list = picked.get(s.paperIndex);
      if (list) {
        list.push(s.chunk);
      } else {
        picked.set(s.paperIndex, [s.chunk]);
      }
      return true;
    };

    // Floor first, then fill the rest from the pooled ranking.
    for (const list of perPaperRanked.values()) {
      for (const s of list.slice(0, MIN_PASSAGES_PER_PAPER)) {
        if (spent >= UPLOAD_TOKEN_BUDGET) {
          break;
        }
        add(s);
      }
    }
    const pooled = rank(scored);
    for (const s of pooled) {
      if (spent >= UPLOAD_TOKEN_BUDGET) {
        break;
      }
      if (anyMatch && s.score <= 0) {
        break;
      }
      add(s);
    }

    // Barely any lexical overlap (a handful of matching passages for a whole question):
    // top up from the front of each paper, where the abstract and introduction are, so a
    // loosely-worded question still gets the paper's own account of itself.
    if (spent < MIN_UPLOAD_TOKENS) {
      for (const list of perPaperRanked.values()) {
        const inOrder = [...list].sort((a, b) => a.chunk.index - b.chunk.index);
        for (const s of inOrder) {
          if (spent >= MIN_UPLOAD_TOKENS) {
            break;
          }
          add(s);
        }
      }
    }
  }

  // Emit grouped by paper, in document order within each paper, so the context reads like
  // an excerpt of the paper rather than a shuffled list.
  const references: RagReference[] = [];
  const chunks: RagChunk[] = [];
  let n = 0;
  for (const [i, paper] of usable.entries()) {
    const selected = (picked.get(i) ?? []).sort((a, b) => a.index - b.index);
    if (selected.length === 0) {
      continue;
    }
    const referenceId = `u${++n}`;
    const pages = [...new Set(selected.map((c) => c.page))].sort(
      (a, b) => a - b
    );
    references.push(toRagReference(paper, referenceId, pages));
    for (const chunk of selected) {
      chunks.push(toRagChunk(paper, chunk, referenceId, null));
    }
  }
  return { references, chunks, strategy };
}

// ── Synthesis context ────────────────────────────────────────────────────────

/** The highest passage number already handed to the model (0 when there are none). */
export function maxCiteIndex(chunks: RagChunk[]): number {
  let max = 0;
  for (const c of chunks) {
    if (c.citeIndex != null && c.citeIndex > max) {
      max = c.citeIndex;
    }
  }
  return max;
}

/**
 * The uploaded papers' passages as a second Sources block, numbered on from where the
 * database sources stopped (`startIndex`) and grouped under each paper. Stamps `citeIndex`
 * on every chunk, exactly like buildContext — that is what maps a citation in the answer
 * back to the passage the reader sees.
 */
export function buildUploadContext(
  references: RagReference[],
  chunks: RagChunk[],
  startIndex: number
): string {
  let n = startIndex;
  const sections: string[] = [];
  for (const ref of references) {
    const own = chunks.filter((c) => c.reference_id === ref.reference_id);
    if (own.length === 0) {
      continue;
    }
    const lines = own.map((c) => {
      c.citeIndex = ++n;
      return `[${c.citeIndex}] ${c.content}`;
    });
    const label = ref.intext || ref.uploadedName || ref.filename;
    sections.push(`=== Uploaded paper: ${label} ===\n${lines.join("\n\n")}`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `-----Sources from papers the user uploaded to this conversation (cite each supporting passage by its bracketed number)-----\n${sections.join(
    "\n\n"
  )}`;
}

/**
 * A one-line roll-call of the attached papers, carried in the USER turn next to the
 * question rather than in the system prompt.
 *
 * "How does this paper relate?" is ambiguous in a conversation that has been discussing
 * database papers for ten turns — and the attachment is the newest thing in the chat, but
 * nothing in the context says so. Naming the papers where the question is asked is what
 * makes "this paper" resolve to them.
 */
export function describeUploads(references: RagReference[]): string {
  if (references.length === 0) {
    return "";
  }
  const list = references
    .map((r) => {
      const cite = r.intext || r.uploadedName || r.filename;
      const title = r.uploadedName?.replace(/\.pdf$/i, "");
      return title && title !== cite ? `${cite} — "${title}"` : cite;
    })
    .join("; ");
  const noun = references.length === 1 ? "paper" : "papers";
  return (
    `[The user has attached ${references.length} ${noun} to this conversation, and their ` +
    `passages are included in the Sources below: ${list}. Unless the user clearly means ` +
    `something else, "this paper", "the attached paper" and "the PDF" refer to ${
      references.length === 1 ? "it" : "them"
    }, and a question about how it relates should be answered by reading ${
      references.length === 1 ? "it" : "them"
    } against the database sources.]`
  );
}

/** Appended to the synthesis system prompt whenever uploaded passages are in the context. */
export const UPLOAD_SOURCE_NOTE =
  "\n\nSOME SOURCES ARE UPLOADED PAPERS. The user has attached one or more papers to this " +
  'conversation; their passages appear in a separate "Uploaded paper" Sources block and ' +
  "are NOT part of the AP-RAG database. Treat them as first-class sources — read them, use " +
  "them, and cite them by their bracketed number exactly like the database sources. When " +
  'the user says "this paper", "the attached paper", "the PDF" or "the paper I uploaded", ' +
  "they mean those papers. If the question is about an uploaded paper alone, answer from " +
  "its passages and do not pad the answer with database sources; when the question invites " +
  "comparison, say explicitly which claims come from the uploaded paper and which from the " +
  "database. Never claim an uploaded paper is in the database.";
