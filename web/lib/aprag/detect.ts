import type { Facets } from "./client";
import type { RagFilters } from "./types";

// Fast, client-side heuristic detection of metadata filters from the composer text, so
// they can be previewed (and cancelled) before sending. Scope matches the agreed set:
// Author / Journal / Affiliation / Year — never Subject/Keyword (left to retrieval).
// It's a heuristic (cancellable in the UI), tuned to avoid common false positives.

// Common English words that are also surnames — excluded from author detection.
const COMMON_SURNAME_WORDS = new Set([
  "page", "brown", "white", "black", "green", "gray", "grey", "bell", "cook",
  "long", "short", "best", "will", "may", "day", "park", "hall", "wood",
  "field", "lake", "stone", "rose", "young", "rich", "board", "church", "case",
  "love", "hope", "moore", "more", "less", "good", "low", "high", "small",
  "back", "post", "press", "house", "fox", "bird", "wolf", "lamb", "marsh",
  "ford", "king", "knight", "pope", "cross", "rice", "berry", "burns", "frost",
]);

let _idxFacets: Facets | null = null;
let _surnames: Map<string, string> | null = null;
let _journals: string[] | null = null;
let _affiliations: string[] | null = null;

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

function detectYears(lower: string): Partial<RagFilters> {
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
  const years: number[] = [];
  for (const m of work.matchAll(new RegExp(`\\b${Y}\\b`, "g"))) {
    const y = Number(m[1]);
    if (!years.includes(y)) {
      years.push(y);
    }
  }
  if (years.length > 0) {
    out.years = years.sort((a, b) => a - b);
  }
  return out;
}

export function detectFilters(text: string, facets: Facets): RagFilters {
  const out: RagFilters = {};
  if (!text.trim()) {
    return out;
  }
  buildIndexes(facets);
  const lower = text.toLowerCase();

  Object.assign(out, detectYears(lower));

  // Authors: a Capitalized token (proper noun) that exactly matches a known surname and
  // isn't a common English word.
  const authors: string[] = [];
  for (const tok of text.split(/[^A-Za-z'’-]+/)) {
    if (tok.length < 4 || !/^[A-Z]/.test(tok)) {
      continue;
    }
    const lc = tok.toLowerCase();
    if (COMMON_SURNAME_WORDS.has(lc)) {
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
