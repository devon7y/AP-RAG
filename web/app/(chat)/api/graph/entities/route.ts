import { auth } from "@/app/(auth)/auth";
import { searchGraphEntities } from "@/lib/aprag/client";

// Search/browse knowledge-graph entities (degree-sorted; name substring + type +
// per-paper filters). Proxies the query server's GET /graph/entities.

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const sp = new URL(request.url).searchParams;
  try {
    const data = await searchGraphEntities({
      q: sp.get("q") ?? undefined,
      type: sp.get("type") ?? undefined,
      file: sp.get("file") ?? undefined,
      limit: Math.min(200, Math.max(1, Number(sp.get("limit")) || 50)),
      offset: Math.max(0, Number(sp.get("offset")) || 0),
    });
    return Response.json(data);
  } catch {
    return Response.json(
      { error: "knowledge graph unavailable" },
      { status: 502 }
    );
  }
}
