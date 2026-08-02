import { auth } from "@/app/(auth)/auth";
import { similarPapers } from "@/lib/aprag/client";

// Related papers: rank the corpus against one paper's chunk centroid ("more like
// this"). Proxies the query server's POST /similar; results are cached per filename
// for the deployment lifetime (the vector store is read-mostly).

const MAX_TOP_K = 40;
const cache = new Map<string, unknown>();

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = new URL(request.url).searchParams;
  const filename = sp.get("filename")?.trim();
  if (!filename) {
    return Response.json({ error: "filename required" }, { status: 400 });
  }
  const topK = Math.min(
    MAX_TOP_K,
    Math.max(1, Number(sp.get("top_k")) || 12)
  );

  const key = `${filename}|${topK}`;
  const hit = cache.get(key);
  if (hit) {
    return Response.json(hit);
  }
  try {
    const data = await similarPapers({ filename, topK });
    cache.set(key, data);
    return Response.json(data);
  } catch {
    return Response.json(
      { error: "related papers unavailable" },
      { status: 502 }
    );
  }
}
