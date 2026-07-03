/** Server-side bridge to the always-on PC stack (Tailscale). Node runtime only. */

export const PC_HOST = process.env.APRAG_PC_HOST || "100.98.84.84";
export const EMBED_URL = `http://${PC_HOST}:8000`;
export const QDRANT_URL = `http://${PC_HOST}:6333`;
export const QUERY_URL = `http://${PC_HOST}:8001`;
const API_KEY = process.env.APRAG_API_KEY || "";

export const CHUNKS_COLLECTION = "lightrag_vdb_chunks";

export async function pcEmbed(
  texts: string[],
  context: "query" | "document" = "query",
): Promise<number[][]> {
  const r = await fetch(`${EMBED_URL}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: texts, model: "qwen3-embedding-8b", context }),
  });
  if (!r.ok) throw new Error(`embedder ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.data.map((d: { embedding: number[] }) => d.embedding);
}

export async function qdrantSearch(
  vector: number[],
  limit = 10,
): Promise<{ qid: string; chunkId: string; file: string; score: number }[]> {
  const r = await fetch(`${QDRANT_URL}/collections/${CHUNKS_COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector, limit, with_payload: true }),
  });
  if (!r.ok) throw new Error(`qdrant search ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.result.map(
    (p: { id: string; score: number; payload: Record<string, string> }) => ({
      qid: p.id,
      chunkId: p.payload.id,
      file: p.payload.file_path,
      score: p.score,
    }),
  );
}

export async function qdrantVectors(qids: string[]): Promise<Record<string, number[]>> {
  const r = await fetch(`${QDRANT_URL}/collections/${CHUNKS_COLLECTION}/points`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: qids, with_vector: true, with_payload: false }),
  });
  if (!r.ok) throw new Error(`qdrant points ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const out: Record<string, number[]> = {};
  for (const p of data.result) out[p.id] = p.vector;
  return out;
}

/** All chunk vectors of one paper (by file_path payload filter). */
export async function qdrantPaperVectors(file: string): Promise<number[][]> {
  const vectors: number[][] = [];
  let offset: unknown = null;
  do {
    const body: Record<string, unknown> = {
      limit: 128,
      with_vector: true,
      with_payload: false,
      filter: { must: [{ key: "file_path", match: { value: file } }] },
    };
    if (offset) body.offset = offset;
    const r = await fetch(`${QDRANT_URL}/collections/${CHUNKS_COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`qdrant scroll ${r.status}: ${await r.text()}`);
    const res = (await r.json()).result;
    for (const p of res.points) vectors.push(p.vector);
    offset = res.next_page_offset;
  } while (offset);
  return vectors;
}

/** Proxy a JSON POST to the PC query server (adds X-API-Key when configured). */
export async function pcQueryServer(path: string, body: unknown): Promise<Response> {
  return fetch(`${QUERY_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    },
    body: JSON.stringify(body),
    // answer synthesis can be slow
    signal: AbortSignal.timeout(180_000),
  });
}

export function meanVector(vecs: number[][]): number[] {
  const out = new Array(vecs[0].length).fill(0);
  for (const v of vecs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  const n = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) + 1e-9;
  return out.map((v) => v / n);
}
