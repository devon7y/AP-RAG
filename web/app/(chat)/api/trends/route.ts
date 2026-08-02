import { auth } from "@/app/(auth)/auth";
import { getTrends } from "@/lib/aprag/client";

// Corpus publication trends (papers per year + per-term-per-year counts) for the
// Trends dashboard. The query server computes and caches the aggregation; this proxy
// adds its own hour cache so a dashboard visit costs at most one tunnel round-trip.

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
    const data = await getTrends();
    cache = { at: Date.now(), data };
    return Response.json(data);
  } catch {
    return Response.json({ error: "trends unavailable" }, { status: 502 });
  }
}
