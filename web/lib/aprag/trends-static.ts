// Types for the two precomputed trend payloads served as static files from
// /public/data, rather than through the query server on the PC.
//
// Both are derived from artifacts that live on this machine, not from the manifest
// the query server holds: the cluster/frontier layer comes out of the Atlas chunk
// embeddings (web/data-pipeline/build_cluster_trends.py) and the citation layer comes
// from OpenAlex (scripts/fetch_openalex.py). Serving them statically also means the
// dashboard keeps these sections when the PC is unreachable.

export type ClusterTrend = {
  term: string; // the region's LLM-written name
  id: number;
  flavor: string;
  terms: string[];
  center: [number, number] | null;
  center3: [number, number, number] | null;
  total: number;
  counts: Record<string, number>;
  stats?: {
    first: number;
    last: number;
    peak: number;
    peakN: number;
    median: number;
  };
  base: number;
  recent: number;
  delta: number;
};

export type FrontierCell = {
  x: number;
  y: number;
  n: number;
  recentN: number;
  expected: number;
  z: number;
  cluster: number;
  name: string;
  titles: string[];
  files: string[];
};

export type ClusterTrendsData = {
  generated: string;
  years: Record<string, number>;
  windows: { base: [number, number]; recent: [number, number] };
  frontierWindow: [number, number];
  clusters: ClusterTrend[];
  frontier: FrontierCell[];
  totals: {
    papers: number;
    dated: number;
    clustered: number;
    regions: number;
  };
};

export type CitedPaper = {
  file: string;
  title: string;
  year: number | null;
  cited: number;
  pct?: number;
};

export type SleepingBeauty = CitedPaper & {
  recent: number;
  share: number;
  score: number;
};

export type InternalCited = {
  file: string;
  title: string;
  year: number | null;
  inCorpus: number;
  cited: number;
};

export type TopicImpact = {
  term: string;
  papers: number;
  meanPct: number;
  medianCited: number;
  totalCited: number;
  top: { file: string; title: string; cited: number };
};

export type CitationsData = {
  generated: string;
  coverage: {
    matched: number;
    manifest: number;
    withDoi: number;
    totalCitations: number;
    internalEdges: number;
  };
  top: CitedPaper[];
  perDecade: Record<string, CitedPaper[]>;
  sleeping: SleepingBeauty[];
  internal: InternalCited[];
  topic: Record<string, TopicImpact[]>;
  arrivals: Record<string, number>;
  baseline: Record<string, Record<string, number>>;
};

/**
 * Fetch a static payload, returning null when it is absent.
 *
 * Both files are optional build products. A dashboard that hard-failed without them
 * would break for anyone who has not run the precompute scripts, so every section
 * they feed disappears instead.
 */
export async function loadStatic<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path, { cache: "force-cache" });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
