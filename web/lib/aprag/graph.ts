// Shared shaping for knowledge-graph entity displays.

/**
 * LightRAG's ingest-time cap on how many source papers it records per entity
 * (`MAX_FILE_PATHS`, default 75 — see LightRAG/lightrag/constants.py). Once an entity is
 * seen in 75 papers it stops recording new ones and appends a "…truncated…" marker, so
 * the stored list is a floor, not a count: "Experiment 1" links 48,545 relationships but
 * still lists 75 papers. Anything at the cap has to be shown as "75+".
 */
export const MAX_SOURCE_PAPERS = 75;

export const SOURCE_PAPERS_CAPPED_HINT =
  `Capped at ${MAX_SOURCE_PAPERS}: the graph stops recording source papers per entity ` +
  "at that point, so this is a floor, not the true count.";

export function isSourcePapersCapped(n: number): boolean {
  return n >= MAX_SOURCE_PAPERS;
}

/** "12 papers", or "75+ papers" once the ingest cap has swallowed the real number. */
export function formatSourcePapers(n: number): string {
  if (isSourcePapersCapped(n)) {
    return `${MAX_SOURCE_PAPERS}+ papers`;
  }
  return `${n.toLocaleString()} paper${n === 1 ? "" : "s"}`;
}
