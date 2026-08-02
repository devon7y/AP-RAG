import type { Facets } from "./client";
import type { RagFilters } from "./types";

// Fast, client-side heuristic detection of metadata filters from the composer text, so
// they can be previewed (and cancelled) before sending. Scope matches the agreed set:
// Paper / Author / Journal / Affiliation / Year — never Subject/Keyword (left to
// retrieval). It's a heuristic (cancellable in the UI), tuned to avoid false positives.

// One row of the corpus paper index (GET /api/papers/index), used to recognize
// paper mentions — "Westbury (2019)", a quoted title, or a bare filename stem.
export type PaperIndexEntry = {
  filename: string;
  title: string;
  firstAuthor: string; // first-author family name ("" when unknown)
  year: number; // 0 when unknown
};

// Common English words that are also surnames — excluded from author detection.
const COMMON_SURNAME_WORDS = new Set([
  "page", "brown", "white", "black", "green", "gray", "grey", "bell", "cook",
  "long", "short", "best", "will", "may", "day", "park", "hall", "wood",
  "field", "lake", "stone", "rose", "young", "rich", "board", "church", "case",
  "love", "hope", "moore", "more", "less", "good", "low", "high", "small",
  "back", "post", "press", "house", "fox", "bird", "wolf", "lamb", "marsh",
  "ford", "king", "knight", "pope", "cross", "rice", "berry", "burns", "frost",
]);

// Capitalized calendar words that pattern-match "Surname (Year)" but never mean a paper.
const MONTH_WORDS = new Set([
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
]);

let _idxFacets: Facets | null = null;
let _surnames: Map<string, string> | null = null;
let _journals: string[] | null = null;
let _affiliations: string[] | null = null;

let _idxPapers: PaperIndexEntry[] | null = null;
let _byAuthorYear: Map<string, PaperIndexEntry[]> | null = null;
let _byStem: Map<string, PaperIndexEntry> | null = null;
let _titles: { norm: string; entry: PaperIndexEntry }[] | null = null;

const normTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function buildPaperIndexes(papers: PaperIndexEntry[]) {
  if (_idxPapers === papers && _byAuthorYear && _byStem && _titles) {
    return;
  }
  _byAuthorYear = new Map();
  _byStem = new Map();
  _titles = [];
  for (const p of papers) {
    if (p.firstAuthor && p.year > 0) {
      const key = `${p.firstAuthor.toLowerCase()}|${p.year}`;
      const arr = _byAuthorYear.get(key);
      if (arr) {
        arr.push(p);
      } else {
        _byAuthorYear.set(key, [p]);
      }
    }
    _byStem.set(p.filename.toLowerCase().replace(/\.pdf$/, ""), p);
    const t = normTitle(p.title);
    if (t.length >= 12) {
      _titles.push({ norm: t, entry: p });
    }
  }
  _idxPapers = papers;
}

const MAX_DETECTED_PAPERS = 8;

// "Surname … (Year)" citation-ish spans: one or more capitalized tokens (co-authors,
// "et al.") immediately followed by a year, optionally parenthesized.
const CITE_RE =
  /\b([A-Z][A-Za-z'’-]{2,})(?:\s*(?:,|&|and)\s*[A-Z][A-Za-z'’-]{2,}){0,3}(?:,?\s+et al\.?,?)?[\s,]{0,3}\(?\s*((?:19|20)\d{2})[a-z]?\s*\)?/g;

// Bare filename stems: "Westbury_2005", "Westbury_Hollis_2019.pdf".
const STEM_RE =
  /\b([A-Za-z][A-Za-z'’-]*(?:_[A-Za-z0-9'’-]+)*_(?:19|20)\d{2}[a-z]?)(?:\.pdf)?\b/g;

type PaperDetection = {
  filenames: string[];
  consumedSurnames: Set<string>; // surnames spent on a matched citation (skip as authors)
  consumedYears: Set<number>; // years spent on a matched citation (skip as year chips)
};

function detectPapers(
  text: string,
  papers: PaperIndexEntry[]
): PaperDetection {
  const out: PaperDetection = {
    filenames: [],
    consumedSurnames: new Set(),
    consumedYears: new Set(),
  };
  if (papers.length === 0) {
    return out;
  }
  buildPaperIndexes(papers);
  const add = (entry: PaperIndexEntry) => {
    if (
      out.filenames.length < MAX_DETECTED_PAPERS &&
      !out.filenames.includes(entry.filename)
    ) {
      out.filenames.push(entry.filename);
    }
  };

  // 1. Author–year citations ("Westbury (2019)", "Westbury and Hollis, 2019"). A hit
  //    requires the surname to be a real first author WITH that exact year — precise
  //    enough that citation-form spans skip the common-word guard.
  for (const m of text.matchAll(CITE_RE)) {
    const span = m[0];
    const year = Number(span.match(/(?:19|20)\d{2}/)?.[0]);
    const citationForm = span.includes("(");
    const toks = span.match(/[A-Z][A-Za-z'’-]{2,}/g) ?? [];
    for (const tok of toks) {
      const lc = tok.toLowerCase();
      if (MONTH_WORDS.has(lc)) {
        continue;
      }
      if (!citationForm && COMMON_SURNAME_WORDS.has(lc)) {
        continue;
      }
      const hits = _byAuthorYear?.get(`${lc}|${year}`);
      if (hits?.length) {
        for (const h of hits) {
          add(h); // 2005a/2005b variants all match — each becomes a chip
        }
        for (const t of toks) {
          out.consumedSurnames.add(t.toLowerCase());
        }
        out.consumedYears.add(year);
        break;
      }
    }
  }

  // 2. Quoted title fragments (≥ 3 words) matched against corpus titles.
  for (const m of text.matchAll(/["“”']([^"“”']{12,240})["“”']/g)) {
    const q = normTitle(m[1]);
    if (q.length < 12 || q.split(" ").length < 3) {
      continue;
    }
    let added = 0;
    for (const t of _titles ?? []) {
      if (t.norm.includes(q)) {
        add(t.entry);
        if (++added >= 3) {
          break; // ambiguous fragment — cap the fan-out
        }
      }
    }
  }

  // 3. Direct filename stems.
  for (const m of text.matchAll(STEM_RE)) {
    const hit = _byStem?.get(m[1].toLowerCase());
    if (hit) {
      add(hit);
    }
  }

  return out;
}

function buildIndexes(facets: Facets) {
  if (_idxFacets === facets && _surnames && _journals && _affiliations) {
    return;
  }
  _surnames = new Map();
  for (const a of facets.authors) {
    _surnames.set(a.toLowerCase(), a);
  }
  // Only multi-word venue/affiliation names are reliable as substring matches; single
  // words like "Cognition" or "Science" appear incidentally and would false-positive.
  const multiWord = (s: string) => s.includes(" ") && s.length >= 6;
  _journals = facets.journals.filter(multiWord);
  _affiliations = facets.affiliations.filter(multiWord);
  _idxFacets = facets;
}

function detectYears(
  lower: string,
  consumedYears: Set<number> = new Set()
): Partial<RagFilters> {
  const out: Partial<RagFilters> = {};
  const Y = "((?:19|20)\\d{2})";
  // Consume range/since/before/until patterns first; whatever years remain are discrete.
  let work = lower;
  const range = work.match(new RegExp(`\\b${Y}\\s*(?:-|–|—|to)\\s*${Y}\\b`));
  if (range) {
    out.year_from = Number(range[1]);
    out.year_to = Number(range[2]);
    work = work.replace(range[0], " ");
  }
  const from = work.match(new RegExp(`\\b(?:since|after|from)\\s+${Y}\\b`));
  if (from) {
    out.year_from = Number(from[1]);
    work = work.replace(from[0], " ");
  }
  const before = work.match(new RegExp(`\\b(?:before|prior to)\\s+${Y}\\b`));
  if (before) {
    out.year_to = Number(before[1]) - 1;
    work = work.replace(before[0], " ");
  }
  const until = work.match(new RegExp(`\\b(?:until|up to|through|by)\\s+${Y}\\b`));
  if (until) {
    out.year_to = Number(until[1]);
    work = work.replace(until[0], " ");
  }
  // Remaining standalone years (e.g. "in 2025 and 2026") → discrete, match-any.
  // Years already "spent" on a detected paper citation are skipped — "Westbury (2019)"
  // pins the paper; it isn't also a year filter.
  const years: number[] = [];
  for (const m of work.matchAll(new RegExp(`\\b${Y}\\b`, "g"))) {
    const y = Number(m[1]);
    if (!(years.includes(y) || consumedYears.has(y))) {
      years.push(y);
    }
  }
  if (years.length > 0) {
    out.years = years.sort((a, b) => a - b);
  }
  return out;
}

export function detectFilters(
  text: string,
  facets: Facets,
  papersIndex?: PaperIndexEntry[]
): RagFilters {
  const out: RagFilters = {};
  if (!text.trim()) {
    return out;
  }
  buildIndexes(facets);
  const lower = text.toLowerCase();

  // Papers first: a matched "Surname (Year)" consumes its surname + year so the same
  // mention doesn't ALSO become an author chip and a year chip.
  const paperHits = detectPapers(text, papersIndex ?? []);
  if (paperHits.filenames.length > 0) {
    out.papers = paperHits.filenames;
  }

  Object.assign(out, detectYears(lower, paperHits.consumedYears));

  // Authors: a Capitalized token (proper noun) that exactly matches a known surname and
  // isn't a common English word.
  const authors: string[] = [];
  for (const tok of text.split(/[^A-Za-z'’-]+/)) {
    if (tok.length < 4 || !/^[A-Z]/.test(tok)) {
      continue;
    }
    // Strip a trailing possessive ("Caplan's" / "Caplan’s" -> "caplan") before matching.
    const lc = tok.toLowerCase().replace(/(?:'|’)s$/, "");
    if (lc.length < 3 || COMMON_SURNAME_WORDS.has(lc)) {
      continue;
    }
    if (paperHits.consumedSurnames.has(lc)) {
      continue;
    }
    const canon = _surnames?.get(lc);
    if (canon && !authors.includes(canon)) {
      authors.push(canon);
    }
  }
  if (authors.length > 0) {
    out.authors = authors;
  }

  const phraseHits = (entries: string[]) => {
    const hits: string[] = [];
    for (const e of entries) {
      if (lower.includes(e.toLowerCase()) && !hits.includes(e)) {
        hits.push(e);
        if (hits.length >= 3) {
          break;
        }
      }
    }
    return hits;
  };
  const journals = phraseHits(_journals ?? []);
  if (journals.length > 0) {
    out.journals = journals;
  }
  const affiliations = phraseHits(_affiliations ?? []);
  if (affiliations.length > 0) {
    out.affiliations = affiliations;
  }

  return out;
}
