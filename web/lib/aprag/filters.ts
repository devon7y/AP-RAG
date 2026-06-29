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
  const years = Array.from(new Set([...(a?.years ?? []), ...(b?.years ?? [])])).sort(
    (x, y) => x - y
  );
  if (years.length > 0) {
    out.years = years;
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

// Stable key for a single filter value, used to track user dismissals across the
// client/server boundary (e.g. "authors:caplan", "year_from:2020").
export function filterKey(dim: string, value: string | number): string {
  return `${dim}:${String(value).toLowerCase()}`;
}

// Remove any filter values whose key is in `dismissed` (the user cancelled them in the
// preview, so the server's second-pass extraction must not re-add them).
export function dropDismissed(
  f: RagFilters,
  dismissed: string[]
): RagFilters {
  if (dismissed.length === 0) {
    return f;
  }
  const drop = new Set(dismissed);
  const out: RagFilters = {};
  for (const k of FILTER_LIST_KEYS) {
    const kept = (f[k] ?? []).filter((v) => !drop.has(filterKey(k, v)));
    if (kept.length > 0) {
      out[k] = kept;
    }
  }
  const keptYears = (f.years ?? []).filter((y) => !drop.has(filterKey("years", y)));
  if (keptYears.length > 0) {
    out.years = keptYears;
  }
  for (const k of ["year", "year_from", "year_to"] as const) {
    const v = f[k];
    if (v != null && !drop.has(filterKey(k, v))) {
      out[k] = v;
    }
  }
  return out;
}
