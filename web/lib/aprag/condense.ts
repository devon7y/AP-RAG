import "server-only";

import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import { getFacetsCached } from "./client";
import { FILTER_LIST_KEYS } from "./filters";
import type { RagFilters } from "./types";

export type HistoryTurn = { role: "user" | "assistant"; content: string };

const EXTRACT_SYSTEM =
  "You convert a user's message (in the context of the conversation) into a standalone " +
  "academic-paper search query, AND extract any metadata filters the user EXPLICITLY " +
  'stated. Output ONLY a JSON object with key "query" (string: the standalone search ' +
  "query — resolve pronouns from the conversation, preserve specific names, numbers and " +
  'terms) and OPTIONALLY "authors" (array of surnames), "journals" (array of journal/' +
  'venue names), "affiliations" (array of institutions), "year" (int), "year_from" (int), ' +
  '"year_to" (int). Include a filter ONLY when the user explicitly names it: "Caplan ' +
  'papers" -> authors:["Caplan"]; "in Cognition" -> journals:["Cognition"]; "from ' +
  'Alberta" / "at MIT" -> affiliations:["Alberta"]/["MIT"]; "since 2020" -> ' +
  'year_from:2020; "before 2015" -> year_to:2014; "in 2026" -> year:2026. Do NOT extract ' +
  "topics, subjects, or keywords as filters — leave the question's topic to semantic " +
  "retrieval. Do NOT infer filters from vague wording (e.g. 'recent', 'classic'). Omit " +
  "keys you have no value for. Respond with the JSON object only — no prose, no code fences.";

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

// One cheap gpt-5.4-mini call: standalone retrieval query + explicit metadata filters.
// Filters are validated against the corpus (see validateInferredFilters). Always returns
// something usable — on any error it falls back to the raw question with no filters.
export async function condenseAndExtract(
  history: HistoryTurn[],
  question: string
): Promise<{ query: string; filters: RagFilters }> {
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

    // NL extraction is limited to author/journal/affiliation/year — topic dimensions
    // (subjects/keywords) are deliberately left to semantic + graph retrieval.
    const raw: RagFilters = {};
    for (const k of ["authors", "journals", "affiliations"] as const) {
      const v = asStrings(obj[k]);
      if (v) {
        raw[k] = v;
      }
    }
    for (const k of ["year", "year_from", "year_to"] as const) {
      const v = asInt(obj[k]);
      if (v != null) {
        raw[k] = v;
      }
    }
    return { query, filters: await validateInferredFilters(raw) };
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
  for (const k of ["year", "year_from", "year_to"] as const) {
    if (f[k] != null) {
      out[k] = f[k];
    }
  }
  const needsFacets = FILTER_LIST_KEYS.some((k) => (f[k]?.length ?? 0) > 0);
  if (!needsFacets) {
    return out;
  }

  const facets = await getFacetsCached();
  const keep = (vals: string[] | undefined, opts: string[] | undefined) => {
    if (!opts) {
      return vals ?? []; // can't validate → apply as-is
    }
    const lc = opts.map((o) => o.toLowerCase());
    return (vals ?? []).filter((v) => {
      const x = v.toLowerCase();
      return lc.some((o) => o.includes(x) || x.includes(o));
    });
  };
  for (const k of FILTER_LIST_KEYS) {
    const kept = keep(f[k], facets?.[k]);
    if (kept.length > 0) {
      out[k] = kept;
    }
  }
  return out;
}
