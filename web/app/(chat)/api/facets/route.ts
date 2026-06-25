import { auth } from "@/app/(auth)/auth";
import { getFacets } from "@/lib/aprag/client";

// Distinct filter values for the composer's Filters autocomplete. Behind auth; proxies
// the query server's /facets (read-mostly, so cache briefly). Degrades to empty on error.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return Response.json({}, { status: 401 });
  }
  try {
    const facets = await getFacets();
    return Response.json(facets, {
      headers: { "Cache-Control": "private, max-age=600" },
    });
  } catch {
    return Response.json({
      authors: [],
      journals: [],
      subjects: [],
      keywords: [],
      affiliations: [],
    });
  }
}
