import "server-only";

/**
 * Server-side bridge to the AP-RAG query server on the always-on PC, reached over
 * its Cloudflare Tunnel — the same APRAG_QUERY_URL / APRAG_API_KEY the chat backend
 * uses (see lib/aprag/client.ts). The atlas-support endpoints (/embed · /qsearch ·
 * /vectors · /paper_centroid) live in query_server.py alongside /query · /retrieve.
 * The URL and shared secret never reach the browser.
 */

const BASE_URL = (process.env.APRAG_QUERY_URL ?? "http://localhost:8001").replace(
  /\/$/,
  "",
);
const API_KEY = process.env.APRAG_API_KEY ?? "";

async function pcPost(
  path: string,
  body: unknown,
  timeoutMs = 60_000,
): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function pcJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const r = await pcPost(path, body, timeoutMs);
  if (!r.ok) {
    throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  return (await r.json()) as T;
}

export async function pcEmbed(
  texts: string[],
  context: "query" | "document" = "query",
): Promise<number[][]> {
  const data = await pcJson<{ embeddings: number[][] }>("/embed", { texts, context });
  return data.embeddings;
}

export async function qdrantSearch(
  vector: number[],
  limit = 10,
): Promise<{ qid: string; chunkId: string; file: string; score: number }[]> {
  const data = await pcJson<{
    hits: { qid: string; chunkId: string; file: string; score: number }[];
  }>("/qsearch", { vector, limit });
  return data.hits;
}

export async function qdrantVectors(qids: string[]): Promise<Record<string, number[]>> {
  const data = await pcJson<{ vectors: Record<string, number[]> }>("/vectors", { qids });
  return data.vectors;
}

/** Unit-norm mean vector of one paper's chunks (computed and cached PC-side). */
export async function paperCentroid(file: string): Promise<number[]> {
  const data = await pcJson<{ centroid: number[] }>("/paper_centroid", { file }, 120_000);
  return data.centroid;
}

/** GET one paper's full manifest record (the query server's /paper). */
export async function pcPaperDetail(file: string): Promise<Response> {
  return fetch(`${BASE_URL}/paper?filename=${encodeURIComponent(file)}`, {
    headers: API_KEY ? { "X-API-Key": API_KEY } : {},
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
}

/** Proxy a JSON POST to the PC query server (adds X-API-Key when configured). */
export async function pcQueryServer(path: string, body: unknown): Promise<Response> {
  // answer synthesis can be slow
  return pcPost(path, body, 180_000);
}
