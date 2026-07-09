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
};

export type RetrieveResult = {
  references: RagReference[];
  chunks: RagChunk[];
  entities: RagEntity[];
  relationships: RagRelationship[];
  mode: string;
};

// POST /retrieve — structured retrieval (entities/relationships/chunks + enriched
// references), no LLM. The web app does its own gpt-5-mini synthesis on top of this.
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
  types?: string[]; // optional: absent from a query server predating the Paper Database
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

// ── Paper Database (browse + deep search) ─────────────────────────────────────

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

// POST /search — semantic chunk search folded into ranked papers (the Paper Database's
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
