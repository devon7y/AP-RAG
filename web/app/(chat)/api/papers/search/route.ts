import { auth } from "@/app/(auth)/auth";
import { searchPapersRanked } from "@/lib/aprag/client";
import type { RagFilters } from "@/lib/aprag/types";

// Papers Database deep search: semantic chunk search folded into ranked papers
// (the query server's POST /search), honoring the same metadata filters as browsing.

const MAX_QUESTION_CHARS = 2000;
const MAX_TOP_K = 200;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { question?: string; top_k?: number; filters?: RagFilters | null };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const question = (body.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) {
    return Response.json({ error: "question required" }, { status: 400 });
  }

  try {
    const result = await searchPapersRanked({
      question,
      topK: Math.min(MAX_TOP_K, Math.max(1, Number(body.top_k) || 60)),
      filters: body.filters ?? null,
    });
    return Response.json(result);
  } catch {
    return Response.json(
      { error: "papers database unavailable" },
      { status: 502 }
    );
  }
}
