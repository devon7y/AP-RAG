import "server-only";

import type {
  PaperDetail,
  PaperListResponse,
  RagChunk,
  RagEntity,
  RagFilters,
  RagReference,
  RagRelationship,
  RankedPaper,
} from "./types";

// The AP-RAG query server (LightRAG + Qdrant + embeddings) runs on the always-on PC and
// is reached over a Cloudflare Tunnel. Only this server-side module talks to it — the
// URL and shared secret never reach the browser.
const BASE_URL = (
  process.env.APRAG_QUERY_URL ?? "http://localhost:8001"
).replace(/\/$/, "");
const API_KEY = process.env.APRAG_API_KEY;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) {
    h["X-API-Key"] = API_KEY;
  }
  return h;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

export type RetrieveParams = {
  question: string;
  mode?: string;
  topK?: number;
  chunkTopK?: number;
  filters?: RagFilters | null;
  // Supplying these skips LightRAG's own keyword-extraction LLM call on the query
  // server (~1.0-1.5s per KG-mode query). The router already produces them.
  hlKeywords?: string[];
  llKeywords?: string[];
};

export type RetrieveResult = {
  references: RagReference[];
  chunks: RagChunk[];
  entities: RagEntity[];
  relationships: RagRelationship[];
  mode: string;
};

// POST /retrieve — structured retrieval (entities/relationships/chunks + enriched
// references), no LLM. The web app does its own gpt-6-luna synthesis on top of this.
export async function retrieve(
  params: RetrieveParams
): Promise<RetrieveResult> {
  const body: Record<string, unknown> = {
    question: params.question,
    mode: params.mode ?? "naive",
  };
  if (params.topK != null) {
    body.top_k = params.topK;
  }
  if (params.chunkTopK != null) {
    body.chunk_top_k = params.chunkTopK;
  }
  if (params.filters) {
    body.filters = params.filters;
  }
  if (params.hlKeywords?.length) {
    body.hl_keywords = params.hlKeywords;
  }
  if (params.llKeywords?.length) {
    body.ll_keywords = params.llKeywords;
  }

  const res = await fetch(`${BASE_URL}/retrieve`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(
      `AP-RAG /retrieve failed: ${res.status} ${await safeText(res)}`
    );
  }

  const json = (await res.json()) as {
    data?: {
      references?: RagReference[];
      chunks?: RagChunk[];
      entities?: RagEntity[];
      relationships?: RagRelationship[];
    };
    metadata?: { query_mode?: string };
  };
  const data = json.data ?? {};
  return {
    references: data.references ?? [],
    chunks: data.chunks ?? [],
    entities: data.entities ?? [],
    relationships: data.relationships ?? [],
    mode: json.metadata?.query_mode ?? params.mode ?? "naive",
  };
}

// GET /stats — number of papers ingested into the database (for the header badge).
export async function getStats(): Promise<{ papers: number }> {
  const res = await fetch(`${BASE_URL}/stats`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`AP-RAG /stats failed: ${res.status}`);
  }
  return (await res.json()) as { papers: number };
}

// GET /health — is the backend actually able to answer right now? "Online" requires the
// query server AND its dependencies (Qdrant + embedding) to be up — the process can be
// reachable while retrieval is broken. `detail` explains a degraded/offline state.
export async function getHealth(): Promise<{
  online: boolean;
  detail?: string;
}> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: headers(),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { online: false, detail: "query server unreachable" };
    }
    const body = (await res.json().catch(() => ({}))) as {
      retrieval_ready?: boolean;
      qdrant?: boolean;
      embedding?: boolean;
    };
    if (body.retrieval_ready === false) {
      const down: string[] = [];
      if (body.qdrant === false) {
        down.push("vector DB");
      }
      if (body.embedding === false) {
        down.push("embedding server");
      }
      return {
        online: false,
        detail:
          down.length > 0 ? `${down.join(" + ")} down` : "retrieval not ready",
      };
    }
    return { online: true };
  } catch {
    return { online: false, detail: "backend unreachable" };
  }
}

export type Facets = {
  authors: string[];
  journals: string[];
  subjects: string[];
  keywords: string[];
  affiliations: string[];
  types?: string[]; // optional: absent from a query server predating the Papers Database
};

// GET /facets — distinct filter values (authors/journals/...) for the filter autocomplete.
export async function getFacets(): Promise<Facets> {
  const res = await fetch(`${BASE_URL}/facets`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`AP-RAG /facets failed: ${res.status}`);
  }
  return (await res.json()) as Facets;
}

// One person in the corpus, for the Authors filter picker. The `authors` facet above is
// surnames only, which can't tell the ~80 Zhangs apart; `name` here is the value to send
// as an `authors` filter ("Zhang, Kechen"). The rest is context for the dropdown.
export type AuthorSuggestion = {
  name: string;
  family: string;
  given: string;
  n_papers: number;
  year_min: number;
  year_max: number;
  journal: string;
  coauthor: string;
};

// GET /authors — people matching a typed prefix, most published first (empty query = the
// most published overall).
export async function getAuthorSuggestions(
  q: string,
  limit = 15
): Promise<AuthorSuggestion[]> {
  const sp = new URLSearchParams({ limit: String(limit) });
  if (q) {
    sp.set("q", q);
  }
  const res = await fetch(`${BASE_URL}/authors?${sp}`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`AP-RAG /authors failed: ${res.status}`);
  }
  const data = (await res.json()) as { authors?: AuthorSuggestion[] };
  return data.authors ?? [];
}

// Module-cached facets (the corpus is read-mostly within a deployment), used to validate
// LLM-inferred filters without re-fetching the large payload each turn.
let _facetsCache: Facets | null = null;
export async function getFacetsCached(): Promise<Facets | null> {
  if (_facetsCache) {
    return _facetsCache;
  }
  try {
    _facetsCache = await getFacets();
    return _facetsCache;
  } catch {
    return null;
  }
}

// ── Papers Database (browse + deep search) ─────────────────────────────────────

export type PaperListParams = {
  q?: string;
  sort?: string;
  order?: string;
  offset?: number;
  limit?: number;
  filters?: RagFilters | null;
};

// Serialize metadata filters as repeated GET params (list values may contain commas —
// journal names do — so joined encodings are not an option).
function appendFilterParams(
  sp: URLSearchParams,
  filters?: RagFilters | null
): void {
  if (!filters) {
    return;
  }
  const lists = [
    "authors",
    "journals",
    "subjects",
    "keywords",
    "affiliations",
    "types",
  ] as const;
  for (const k of lists) {
    for (const v of filters[k] ?? []) {
      sp.append(k, v);
    }
  }
  const scalars = [
    "year",
    "year_from",
    "year_to",
    "date_from",
    "date_to",
  ] as const;
  for (const k of scalars) {
    const v = filters[k];
    if (v != null && v !== "") {
      sp.set(k, String(v));
    }
  }
}

// GET /papers — the manifest as a table: filter + quick text match + sort + paginate.
export async function listPapers(
  params: PaperListParams
): Promise<PaperListResponse> {
  const sp = new URLSearchParams();
  if (params.q?.trim()) {
    sp.set("q", params.q.trim());
  }
  if (params.sort) {
    sp.set("sort", params.sort);
  }
  if (params.order) {
    sp.set("order", params.order);
  }
  sp.set("offset", String(params.offset ?? 0));
  sp.set("limit", String(params.limit ?? 50));
  appendFilterParams(sp, params.filters);

  const res = await fetch(`${BASE_URL}/papers?${sp.toString()}`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(
      `AP-RAG /papers failed: ${res.status} ${await safeText(res)}`
    );
  }
  return (await res.json()) as PaperListResponse;
}

// GET /paper — the full manifest record (abstract, affiliations, provenance) for the
// detail drawer.
export async function getPaper(filename: string): Promise<PaperDetail> {
  const sp = new URLSearchParams({ filename });
  const res = await fetch(`${BASE_URL}/paper?${sp.toString()}`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(
      `AP-RAG /paper failed: ${res.status} ${await safeText(res)}`
    );
  }
  return (await res.json()) as PaperDetail;
}

// GET /papers_index — every paper as a compact [filename, title, first_author_family,
// year] row, for the composer's client-side paper-mention detection.
export type PapersIndexRow = [string, string, string, number];

export async function getPapersIndex(): Promise<{ papers: PapersIndexRow[] }> {
  const res = await fetch(`${BASE_URL}/papers_index`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`AP-RAG /papers_index failed: ${res.status}`);
  }
  return (await res.json()) as { papers: PapersIndexRow[] };
}

// POST /similar — papers most similar to one paper (its chunk-centroid's nearest
// neighbours in the vector store), in the same ranked-paper shape as /search.
export async function similarPapers(params: {
  filename: string;
  topK?: number;
}): Promise<{ papers: RankedPaper[] }> {
  const body: Record<string, unknown> = { filename: params.filename };
  if (params.topK != null) {
    body.top_k = params.topK;
  }
  const res = await fetch(`${BASE_URL}/similar`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) {
    // The paper isn't in the vector store (e.g. not yet ingested) — no neighbours,
    // not an outage.
    return { papers: [] };
  }
  if (!res.ok) {
    throw new Error(
      `AP-RAG /similar failed: ${res.status} ${await safeText(res)}`
    );
  }
  const json = (await res.json()) as { papers?: RankedPaper[] };
  return { papers: json.papers ?? [] };
}

// GET /trends — corpus-wide publication trends (papers per year + per-term-per-year
// counts across six facet dimensions, plus the derived scoring), for the Trends
// dashboard. Every field past `years` and the four original dimensions is optional so
// the page still renders against a query server that predates them.
export type TrendStats = {
  first: number;
  last: number;
  peak: number;
  peakN: number;
  median: number;
};

export type TrendTerm = {
  term: string;
  total: number;
  counts: Record<string, number>; // year → papers
  stats?: TrendStats;
  base?: number; // papers in the base window
  recent?: number; // papers in the recent window
  delta?: number; // change in share of corpus output, percentage points
};

export type TrendWindows = { base: [number, number]; recent: [number, number] };

export type TrendNewcomer = {
  term: string;
  first: number;
  total: number;
  recent: number;
};

export type TrendBurst = {
  term: string;
  from: number;
  to: number;
  n: number;
  expected: number;
  z: number;
};

export type TrendLeadLag = {
  lead: string;
  follow: string;
  lag: number;
  r: number;
  gain: number;
};

export const TREND_DIMS = [
  "keywords",
  "subjects",
  "journals",
  "authors",
  "affiliations",
  "types",
] as const;

export type TrendDim = (typeof TREND_DIMS)[number];

export type TrendsData = {
  years: Record<string, number>;
  partialFrom?: number | null; // the current year is only partly collected
  windows?: TrendWindows;
  totals?: {
    papers: number;
    dated: number;
    undated: number;
    dims: Record<string, number>;
  };
  newcomers?: Partial<Record<TrendDim, TrendNewcomer[]>>;
  bursts?: Partial<Record<TrendDim, TrendBurst[]>>;
  leadlag?: TrendLeadLag[];
} & Record<TrendDim, TrendTerm[]>;

export async function getTrends(): Promise<TrendsData> {
  const res = await fetch(`${BASE_URL}/trends`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`AP-RAG /trends failed: ${res.status}`);
  }
  return (await res.json()) as TrendsData;
}

// GET /trend_detail — one term's co-occurrence neighbourhood, then-vs-now owners, and
// papers. Answers *why* a line moved, which the overview payload deliberately leaves
// out (it would be 300 terms' worth of context nobody asked for).
export type TrendCount = { term: string; n: number };

export type TrendDetail = {
  dim: string;
  term: string;
  total: number;
  windows: TrendWindows;
  cooccur: { all: TrendCount[]; base: TrendCount[]; recent: TrendCount[] };
  cross: Record<string, TrendCount[]>;
  authors: { base: TrendCount[]; recent: TrendCount[] };
  journals: { base: TrendCount[]; recent: TrendCount[] };
  papers: {
    filename: string;
    title: string;
    year: number | null;
    journal: string;
    authors: string[];
  }[];
};

export async function getTrendDetail(
  dim: string,
  term: string
): Promise<TrendDetail> {
  const sp = new URLSearchParams({ dim, term });
  const res = await fetch(`${BASE_URL}/trend_detail?${sp.toString()}`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`AP-RAG /trend_detail failed: ${res.status}`);
  }
  return (await res.json()) as TrendDetail;
}

// ── PDF assets (GET /pdf, GET /pdf_page) ───────────────────────────────────────
// Returned RAW (not parsed) so the API route can stream the body straight through and
// preserve range/conditional semantics — pdf.js relies on 206/304 working end to end.

export async function fetchPdfAsset(
  kind: "pdf" | "pdf_page",
  params: Record<string, string>,
  forward: { range?: string | null; ifNoneMatch?: string | null }
): Promise<Response> {
  const sp = new URLSearchParams(params);
  const h = headers();
  delete h["Content-Type"]; // GET with no body
  if (forward.range) {
    h.Range = forward.range;
  }
  if (forward.ifNoneMatch) {
    h["If-None-Match"] = forward.ifNoneMatch;
  }
  return await fetch(`${BASE_URL}/${kind}?${sp.toString()}`, {
    headers: h,
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
}

// POST /pdf_locate — which page a cited passage sits on, plus fractional highlight
// rectangles. `page: null` means the text wasn't found (a scan, or mangled text).
export type PdfLocateResult = {
  page: number | null;
  rects: [number, number, number, number][];
  page_count?: number;
  matched?: string;
};

export async function locatePdfQuote(params: {
  filename: string;
  quote: string;
  hintPage?: number;
}): Promise<PdfLocateResult> {
  const res = await fetch(`${BASE_URL}/pdf_locate`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      filename: params.filename,
      quote: params.quote.slice(0, 2000),
      hint_page: params.hintPage,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`AP-RAG /pdf_locate failed: ${res.status}`);
  }
  return (await res.json()) as PdfLocateResult;
}

// ── Knowledge-graph explorer (GET /graph/*) ────────────────────────────────────

export type GraphTypeStat = { type: string; count: number; top: string[] };

export type GraphOverview = {
  entities: number;
  relations: number;
  types: GraphTypeStat[];
};

export type GraphEntitySummary = {
  name: string;
  type: string;
  degree: number;
  papers: number;
  description: string; // snippet
};

export type GraphRelation = {
  entity: string;
  entity_type: string;
  degree: number;
  description: string;
  keywords: string;
  weight: number;
};

export type GraphEntityDetail = {
  name: string;
  type: string;
  description: string;
  degree: number;
  n_relations: number;
  relations: GraphRelation[];
  n_papers: number;
  papers: { filename: string; title: string; year: string }[];
};

async function graphGet<T>(path: string, sp: URLSearchParams): Promise<T> {
  const qs = sp.toString();
  const res = await fetch(`${BASE_URL}${path}${qs ? `?${qs}` : ""}`, {
    headers: headers(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // `status` lets the proxy route distinguish "unknown entity" (404) from an outage.
    throw Object.assign(
      new Error(`AP-RAG ${path} failed: ${res.status} ${await safeText(res)}`),
      { status: res.status }
    );
  }
  return (await res.json()) as T;
}

export function getGraphOverview(): Promise<GraphOverview> {
  return graphGet<GraphOverview>("/graph/overview", new URLSearchParams());
}

export function searchGraphEntities(params: {
  q?: string;
  type?: string;
  file?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  total: number;
  entities: GraphEntitySummary[];
  offset: number;
  limit: number;
}> {
  const sp = new URLSearchParams();
  if (params.q?.trim()) {
    sp.set("q", params.q.trim());
  }
  if (params.type?.trim()) {
    sp.set("type", params.type.trim());
  }
  if (params.file?.trim()) {
    sp.set("file", params.file.trim());
  }
  if (params.limit != null) {
    sp.set("limit", String(params.limit));
  }
  if (params.offset != null) {
    sp.set("offset", String(params.offset));
  }
  return graphGet("/graph/entities", sp);
}

// POST /graph/entities_by_file — the top entities of several papers at once, keyed by
// filename. One round trip fills the Papers Database's knowledge-graph column for a
// whole page (per-paper lookups are label scans, so the server caches them).
export type GraphFileEntity = { name: string; type: string; degree: number };

export async function getGraphEntitiesByFile(params: {
  files: string[];
  limit?: number;
}): Promise<{ entities: Record<string, GraphFileEntity[]> }> {
  const res = await fetch(`${BASE_URL}/graph/entities_by_file`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ files: params.files, limit: params.limit ?? 8 }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw Object.assign(
      new Error(
        `AP-RAG /graph/entities_by_file failed: ${res.status} ${await safeText(res)}`
      ),
      { status: res.status }
    );
  }
  const json = (await res.json()) as {
    entities?: Record<string, GraphFileEntity[]>;
  };
  return { entities: json.entities ?? {} };
}

export function getGraphEntity(name: string): Promise<GraphEntityDetail> {
  return graphGet<GraphEntityDetail>(
    "/graph/entity",
    new URLSearchParams({ name })
  );
}

// POST /search — semantic chunk search folded into ranked papers (the Papers Database's
// deep-search tier), honoring the same metadata filters as browsing.
export async function searchPapersRanked(params: {
  question: string;
  topK?: number;
  filters?: RagFilters | null;
}): Promise<{ papers: RankedPaper[]; matched_files: number | null }> {
  const body: Record<string, unknown> = { question: params.question };
  if (params.topK != null) {
    body.top_k = params.topK;
  }
  if (params.filters) {
    body.filters = params.filters;
  }
  const res = await fetch(`${BASE_URL}/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(
      `AP-RAG /search failed: ${res.status} ${await safeText(res)}`
    );
  }
  const json = (await res.json()) as {
    papers?: RankedPaper[];
    matched_files?: number | null;
  };
  return {
    papers: json.papers ?? [],
    matched_files: json.matched_files ?? null,
  };
}
