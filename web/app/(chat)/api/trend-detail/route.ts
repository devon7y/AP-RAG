import { auth } from "@/app/(auth)/auth";
import { getTrendDetail } from "@/lib/aprag/client";

// One term's context for the Trends dashboard: co-occurrence per window, the authors
// and journals that owned it then vs now, and its papers. Fetched on demand (the
// overview payload carries none of this), and memoised here per dim+term — the
// underlying manifest is read-mostly, so a repeat open costs nothing.

const cache = new Map<string, { at: number; data: unknown }>();
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 120;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const dim = searchParams.get("dim");
  const term = searchParams.get("term");
  if (!(dim && term)) {
    return Response.json({ error: "dim and term required" }, { status: 400 });
  }

  const key = `${dim}::${term.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return Response.json(hit.data);
  }

  try {
    const data = await getTrendDetail(dim, term);
    if (cache.size >= MAX_ENTRIES) {
      cache.clear();
    }
    cache.set(key, { at: Date.now(), data });
    return Response.json(data);
  } catch {
    return Response.json(
      { error: "trend detail unavailable" },
      { status: 502 }
    );
  }
}
