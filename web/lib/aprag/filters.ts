import type { RagFilters } from "./types";

// Pure filter helpers shared by the server (chat route) and the client (chip UI).

export const FILTER_LIST_KEYS = [
  "authors",
  "journals",
  "subjects",
  "keywords",
  "affiliations",
] as const;

export type FilterListKey = (typeof FILTER_LIST_KEYS)[number];

// Union of two filter sets: list dimensions are de-duplicated unions; year scalars take
// b's value when present, else a's. Returns null when nothing is set.
export function mergeFilters(
  a: RagFilters | null | undefined,
  b: RagFilters | null | undefined
): RagFilters | null {
  const out: RagFilters = {};
  for (const k of FILTER_LIST_KEYS) {
    const merged = Array.from(
      new Set([...(a?.[k] ?? []), ...(b?.[k] ?? [])].map((s) => s.trim()).filter(Boolean))
    );
    if (merged.length > 0) {
      out[k] = merged;
    }
  }
  for (const k of ["year", "year_from", "year_to"] as const) {
    const v = b?.[k] ?? a?.[k];
    if (v != null) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function hasAnyFilter(f: RagFilters | null | undefined): boolean {
  return mergeFilters(f, null) !== null;
}
