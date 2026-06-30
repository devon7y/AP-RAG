import "server-only";

import { generateText } from "ai";
import {
  CONCRETE_RETRIEVAL_MODES,
  type ConcreteRetrievalMode,
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
  'years:[2025,2026]. Correct obvious ' +
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
      providerOptions: { openai: { reasoningEffort: "none" } },
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
    const mode = CONCRETE_RETRIEVAL_MODES.find((m) => m === obj.mode);
    return { query, filters: await validateInferredFilters(raw), mode };
  } catch {
    return { query: question, filters: {} };
  }
}

// Keep only inferred name-filters that actually exist in the corpus, so a near-miss or
// hallucination broadens to semantic search instead of returning nothing. Years pass
// through. Best-effort: if facets are unavailable, the filters are applied as-is.
export async function validateInferredFilters(
  f: RagFilters
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
  return out;
}
