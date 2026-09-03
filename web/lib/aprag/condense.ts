import "server-only";

import { generateText } from "ai";
import {
  CONCRETE_RETRIEVAL_MODES,
  type ConcreteRetrievalMode,
  openaiOptions,
} from "@/lib/ai/models";
import { getLanguageModel } from "@/lib/ai/providers";
import { getFacetsCached } from "./client";
import type { RagFilters } from "./types";

export type HistoryTurn = { role: "user" | "assistant"; content: string };

// NL extraction scope: author / journal / affiliation / year (NOT subject/keyword — the
// question's topic is left to semantic + graph retrieval).
const EXTRACT_LIST_KEYS = ["authors", "journals", "affiliations"] as const;

const EXTRACT_SYSTEM =
  "You convert a user's message (in the context of the conversation) into a standalone " +
  "academic-paper search query, AND extract any metadata filters the user EXPLICITLY " +
  'stated. Output ONLY a JSON object with key "query" (string: the standalone search ' +
  "query — resolve pronouns from the conversation, preserve specific names, numbers and " +
  'terms) and OPTIONALLY "authors" (array of surnames), "journals" (array of journal/' +
  'venue names), "affiliations" (array of institutions), "years" (array of specific ' +
  'years), "year_from" (int), "year_to" (int). Include a filter ONLY when the user ' +
  'explicitly names it: "Caplan papers" -> authors:["Caplan"]; "in Cognition" -> ' +
  'journals:["Cognition"]; "from Alberta" / "at MIT" -> affiliations:["Alberta"]/["MIT"]; ' +
  '"since 2020" -> year_from:2020; "before 2015" -> year_to:2014; "in 2025 and 2026" -> ' +
  'years:[2025,2026]. A CITATION naming a specific paper is an explicit author-AND-year ' +
  'filter — always extract BOTH parts: "Chen et al. 2014" / "Chen et al. (2014)" / ' +
  '"the Chen 2014 paper" -> authors:["Chen"], years:[2014]; "Smith & Jones (2019)" -> ' +
  'authors:["Smith","Jones"], years:[2019]. NEVER take a citation\'s year without its ' +
  'surname(s): a year on its own cannot reach the paper, and it narrows the search to ' +
  'every OTHER paper of that year. Correct obvious ' +
  'misspellings of journal/affiliation names to the intended name. Do NOT extract topics, ' +
  "subjects, or keywords as filters. Do NOT infer filters from vague wording ('recent', " +
  "'classic'). " +
  // Retrieval-strategy routing (the "auto" mode).
  'ALSO choose the best retrieval "mode" for this question (a knowledge-graph + vector ' +
  'RAG over academic papers): "local" = a specific entity/finding/person/dataset (facts ' +
  'about one thing, e.g. "what % were utilitarian in Yanitski 2026?"); "global" = broad ' +
  'thematic synthesis or relationships across many papers ("how does humor relate to word ' +
  'frequency across the lab?"); "hybrid" = needs both specific facts and broader context ' +
  "(the safe default for most questions); \"naive\" = a simple keyword lookup where the " +
  'graph adds nothing. Prefer "hybrid" when unsure. ' +
  // Retrieval keywords, so LightRAG can skip its OWN keyword-extraction LLM call on
  // the query server (~1.0-1.5s per KG-mode query; measured net saving +1.07s).
  // get_keywords_from_query returns pre-supplied keywords without calling the LLM.
  //
  // The block below is lifted almost verbatim from LightRAG's own
  // PROMPTS["keywords_extraction"] (lightrag/prompt.py) — its Goal definitions and
  // Instructions 4-7 — so this call reproduces its behaviour as closely as possible.
  // Only the JSON-shape rules are dropped, since they are covered above.
  //
  // Why verbatim matters: a loosely-worded version produced ~14 low-level keywords
  // to LightRAG's ~1.4, and since kg_query joins each list with ", " and embeds it as
  // ONE string, that verbosity moved the query vector enough to cut chunk overlap
  // with current behaviour to 37%. Matching the prompt brought it to ~68%.
  //
  // NB: this is a COPY. If LightRAG's keywords_extraction prompt changes on upgrade,
  // re-sync this text or the two paths will drift apart silently.
  "ALSO extract two types of keywords from the standalone query for a retrieval " +
  'system. "high_level_keywords": for overarching concepts or themes, capturing the ' +
  "core intent, the subject area, or the type of question being asked. " +
  '"low_level_keywords": for specific entities or details — the specific entities, ' +
  "proper nouns, technical jargon, or concrete items. Constraints: (a) Source of " +
  "Truth — all keywords must be explicitly derived only from the query; do not infer " +
  "unsupported facts, and do not invent entities, organizations, dates or technical " +
  "terms that are not grounded in it. (b) Concise & Meaningful — keywords should be " +
  "concise words or meaningful phrases; prioritize multi-word phrases when they " +
  "represent a single concept instead of splitting them into isolated words. " +
  "(c) Edge Cases — for a query that is too simple, vague or nonsensical, return " +
  "empty arrays for both. (d) No Duplicates — do not repeat a keyword within a list; " +
  "keep the lists short and high-signal. " +
  "Omit keys you have no value for. Respond with the JSON object only — no " +
  "prose, no code fences.";

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

function asStrings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function asInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

function asInts(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) {
    return undefined;
  }
  const out = v.map(asInt).filter((n): n is number => n != null);
  return out.length > 0 ? Array.from(new Set(out)).sort((a, b) => a - b) : undefined;
}

// ── Citation backstop ────────────────────────────────────────────────────────
// "Chen et al. 2014" is the commonest way an academic names one paper, and the router
// LLM is not reliable on it: over 20 runs of one such question it returned the author
// once, and a bare years:[2014] thirteen times. A year without its author is worse than
// no filter at all — it cannot reach the paper, and it concentrates retrieval on every
// OTHER paper of that year, which is how a question about Chen et al. (2014) came back
// answered from a different 2014 paper. So the citation is ALSO read deterministically
// here and unioned into whatever the LLM returned, and validateInferredFilters drops a
// year that is left stranded without its author.

/** A surname inside a citation: capitalised, at least three letters. */
const SURNAME = String.raw`\p{Lu}[\p{L}'’-]{2,}`;

/** "Chen et al. 2014" · "Chen et al., (2014)" · "Smith & Jones 2019" · "Yanitski (2026)" */
const CITATION_RE = new RegExp(
  String.raw`\b(${SURNAME})` + // first surname
    String.raw`(?:\s*,?\s*(?:&|and)\s*(${SURNAME}))?` + // optional second
    String.raw`(?:\s*,?\s*\bet\s+al\b\.?)?` + // optional "et al."
    String.raw`\s*,?\s*\(?\b((?:19|20)\d{2})[a-z]?\)?`, // 2014 · 2014b · (2014)
  "gu"
);

// Capitalised words that routinely sit in front of a year without being anyone's name.
// A false positive is cheap (an author that isn't in the corpus is dropped by
// validateInferredFilters) but these are common enough to be worth excluding outright.
const NOT_A_SURNAME = new Set(
  (
    "since in from before after during between until through by around about circa " +
    "the and or but for with published written released revised updated version " +
    "edition volume vol issue chapter section page figure fig table experiment " +
    "study studies report survey review year years spring summer autumn fall winter " +
    "january february march april may june july august september october november " +
    "december what when why how who which where was were data corpus"
  ).split(" ")
);

/** The author surnames and years named by citations in a message. */
export function citationsIn(text: string): {
  authors: string[];
  years: number[];
} {
  const authors: string[] = [];
  const years: number[] = [];
  for (const m of (text ?? "").matchAll(CITATION_RE)) {
    const names = [m[1], m[2]].filter((n): n is string => Boolean(n));
    if (names.some((n) => NOT_A_SURNAME.has(n.toLowerCase()))) {
      continue;
    }
    const year = Number.parseInt(m[3], 10);
    for (const n of names) {
      if (!authors.includes(n)) {
        authors.push(n);
      }
    }
    if (!years.includes(year)) {
      years.push(year);
    }
  }
  return { authors, years };
}

// One cheap gpt-5.4-mini call: standalone retrieval query + a second-pass extraction of
// explicit metadata filters (validated against the corpus). Always returns something
// usable — on any error it falls back to the raw question with no filters.
export async function condenseAndExtract(
  history: HistoryTurn[],
  question: string
): Promise<{
  query: string;
  filters: RagFilters;
  mode?: ConcreteRetrievalMode;
  hlKeywords?: string[];
  llKeywords?: string[];
}> {
  const convo = history
    .filter((t) => t.content.trim().length > 0)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n");

  try {
    const { text } = await generateText({
      model: getLanguageModel(),
      system: EXTRACT_SYSTEM,
      prompt: `${convo ? `Conversation so far:\n${convo}\n\n` : ""}Latest user message: ${question}\n\nJSON:`,
      // Mechanical JSON extraction — reasoning would only add latency in front of
      // retrieval, which the user is already waiting on.
      providerOptions: openaiOptions("none"),
      abortSignal: AbortSignal.timeout(20_000),
    });
    const obj = safeParse(text);
    const query =
      typeof obj.query === "string" && obj.query.trim().length > 0
        ? obj.query.trim()
        : question;

    const raw: RagFilters = {};
    for (const k of EXTRACT_LIST_KEYS) {
      const v = asStrings(obj[k]);
      if (v) {
        raw[k] = v;
      }
    }
    const years = asInts(obj.years);
    if (years) {
      raw.years = years;
    }
    for (const k of ["year", "year_from", "year_to"] as const) {
      const v = asInt(obj[k]);
      if (v != null) {
        raw[k] = v;
      }
    }
    // Union in the citation the message names outright, so an author the router missed
    // is still applied and one it found is never lost.
    const cited = citationsIn(question);
    if (cited.authors.length > 0) {
      raw.authors = Array.from(new Set([...(raw.authors ?? []), ...cited.authors]));
      raw.years = Array.from(
        new Set([...(raw.years ?? []), ...cited.years])
      ).sort((a, b) => a - b);
    }

    const mode = CONCRETE_RETRIEVAL_MODES.find((m) => m === obj.mode);
    return {
      query,
      filters: await validateInferredFilters(raw, cited.years),
      mode,
      hlKeywords: asStrings(obj.high_level_keywords),
      llKeywords: asStrings(obj.low_level_keywords),
    };
  } catch {
    // On any failure the keywords are simply absent and LightRAG extracts its own,
    // so a bad router response costs latency but never correctness.
    return { query: question, filters: {} };
  }
}

// Keep only inferred name-filters that actually exist in the corpus, so a near-miss or
// hallucination broadens to semantic search instead of returning nothing. Years pass
// through, EXCEPT a year that came from a citation and lost its author to that check —
// see the stranded-year rule at the bottom. Best-effort: if facets are unavailable, the
// filters are applied as-is.
export async function validateInferredFilters(
  f: RagFilters,
  citationYears: number[] = []
): Promise<RagFilters> {
  const out: RagFilters = {};
  if (f.years?.length) {
    out.years = f.years;
  }
  for (const k of ["year", "year_from", "year_to"] as const) {
    if (f[k] != null) {
      out[k] = f[k];
    }
  }
  const needsFacets = EXTRACT_LIST_KEYS.some((k) => (f[k]?.length ?? 0) > 0);
  if (!needsFacets) {
    return out;
  }

  const facets = await getFacetsCached();
  const keep = (vals: string[] | undefined, opts: string[] | undefined) => {
    if (!opts) {
      return vals ?? [];
    }
    const lc = opts.map((o) => o.toLowerCase());
    return (vals ?? []).filter((v) => {
      const x = v.toLowerCase();
      return lc.some((o) => o.includes(x) || x.includes(o));
    });
  };
  for (const k of EXTRACT_LIST_KEYS) {
    const kept = keep(f[k], facets?.[k]);
    if (kept.length > 0) {
      out[k] = kept;
    }
  }
  return dropStrandedCitationYear(out, citationYears);
}

/**
 * Drop a year filter that came from a citation but has no surviving name filter beside
 * it — the surname was never extracted, or it was and the corpus doesn't have it.
 *
 * Such a filter is strictly harmful: it cannot reach the paper the citation names, and
 * it restricts retrieval to every OTHER paper of that year, which for a methods question
 * is precisely the pool most likely to answer it convincingly and wrongly. Searching the
 * whole corpus instead at least ranks the named author's own work highly.
 *
 * Only a citation's own year is dropped. A standalone date restriction ("papers from
 * 2014", "since 2020") never reaches here, and an explicit range is left alone.
 */
function dropStrandedCitationYear(
  out: RagFilters,
  citationYears: number[]
): RagFilters {
  const hasYear = (out.years?.length ?? 0) > 0 || out.year != null;
  const hasName = EXTRACT_LIST_KEYS.some((k) => (out[k]?.length ?? 0) > 0);
  const fromCitation =
    citationYears.length > 0 &&
    (out.years ?? []).every((y) => citationYears.includes(y)) &&
    (out.year == null || citationYears.includes(out.year));
  if (
    hasYear &&
    !hasName &&
    fromCitation &&
    out.year_from == null &&
    out.year_to == null
  ) {
    const { year: _year, years: _years, ...rest } = out;
    return rest;
  }
  return out;
}
