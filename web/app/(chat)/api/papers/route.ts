import { auth } from "@/app/(auth)/auth";
import { getPaper, listPapers } from "@/lib/aprag/client";
import type { RagFilters } from "@/lib/aprag/types";

// Paper Database proxy: browse rows (GET /papers on the query server) or one full
// record (`?filename=` → GET /paper). Behind auth; the tunnel URL + key stay
// server-side, like every other query-server proxy.

const LIST_KEYS = [
  "authors",
  "journals",
  "subjects",
  "keywords",
  "affiliations",
  "types",
] as const;

const MAX_LIMIT = 1000;

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const sp = new URL(request.url).searchParams;

  const filename = sp.get("filename");
  if (filename) {
    try {
      return Response.json(await getPaper(filename));
    } catch {
      return Response.json({ error: "paper not found" }, { status: 404 });
    }
  }

  const filters: RagFilters = {};
  for (const k of LIST_KEYS) {
    const values = sp.getAll(k).filter(Boolean);
    if (values.length > 0) {
      filters[k] = values;
    }
  }
  for (const k of ["year", "year_from", "year_to"] as const) {
    const v = sp.get(k);
    if (v && Number.isFinite(Number(v))) {
      filters[k] = Number(v);
    }
  }
  for (const k of ["date_from", "date_to"] as const) {
    const v = sp.get(k);
    if (v) {
      filters[k] = v;
    }
  }

  try {
    const result = await listPapers({
      q: sp.get("q") ?? undefined,
      sort: sp.get("sort") ?? undefined,
      order: sp.get("order") ?? undefined,
      offset: Math.max(0, Number(sp.get("offset")) || 0),
      limit: Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || 50)),
      filters: Object.keys(filters).length > 0 ? filters : null,
    });
    return Response.json(result);
  } catch {
    return Response.json(
      { error: "paper database unavailable" },
      { status: 502 }
    );
  }
}
