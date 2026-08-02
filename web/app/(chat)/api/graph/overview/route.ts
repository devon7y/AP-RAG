import { auth } from "@/app/(auth)/auth";
import { getGraphOverview } from "@/lib/aprag/client";

// Knowledge-graph overview (entity/relation counts + per-type stats). The graph is
// static per PC-server lifetime, so an hour of in-module caching is safe.

let cache: { at: number; data: unknown } | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (cache && Date.now() - cache.at < TTL_MS) {
    return Response.json(cache.data);
  }
  try {
    const data = await getGraphOverview();
    cache = { at: Date.now(), data };
    return Response.json(data);
  } catch {
    return Response.json(
      { error: "knowledge graph unavailable" },
      { status: 502 }
    );
  }
}
