import "server-only";

import type {
  RagChunk,
  RagEntity,
  RagFilters,
  RagReference,
  RagRelationship,
} from "./types";

// The AP-RAG query server (LightRAG + Qdrant + embeddings) runs on the always-on PC and
// is reached over a Cloudflare Tunnel. Only this server-side module talks to it — the
// URL and shared secret never reach the browser.
const BASE_URL = (process.env.APRAG_QUERY_URL ?? "http://localhost:8001").replace(
  /\/$/,
  ""
);
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
export async function retrieve(params: RetrieveParams): Promise<RetrieveResult> {
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

// GET /health — is the query server (PC backend) reachable right now?
export async function getHealth(): Promise<{ online: boolean }> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: headers(),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    return { online: res.ok };
  } catch {
    return { online: false };
  }
}

export type Facets = {
  authors: string[];
  journals: string[];
  subjects: string[];
  keywords: string[];
  affiliations: string[];
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
