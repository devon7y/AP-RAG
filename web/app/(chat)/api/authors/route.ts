import { auth } from "@/app/(auth)/auth";
import { getAuthorSuggestions } from "@/lib/aprag/client";

// Author picker for the composer's Authors filter: people ("Zhang, Kechen"), not the
// bare surnames the /facets payload carries. Behind auth; proxies the query server's
// /authors. Degrades to an empty list — the picker then falls back to surname facets,
// which is also what happens against a query server predating this endpoint.

const MAX_LIMIT = 50;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ authors: [] }, { status: 401 });
  }
  const sp = new URL(request.url).searchParams;
  const q = sp.get("q")?.trim() ?? "";
  const limit = Math.min(
    Number.parseInt(sp.get("limit") ?? "", 10) || 15,
    MAX_LIMIT
  );
  try {
    return Response.json(
      { authors: await getAuthorSuggestions(q, limit) },
      { headers: { "Cache-Control": "private, max-age=300" } }
    );
  } catch {
    return Response.json({ authors: [] });
  }
}
