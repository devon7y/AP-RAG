import { auth } from "@/app/(auth)/auth";
import { getGraphEntitiesByFile } from "@/lib/aprag/client";

// The knowledge-graph entities of many papers at once — what the Papers Database's
// graph column needs for one page of rows. Proxies POST /graph/entities_by_file.

const MAX_FILES = 250;

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    files?: unknown;
    limit?: unknown;
  };
  const files = Array.isArray(body.files)
    ? body.files
        .filter((f): f is string => typeof f === "string")
        .slice(0, MAX_FILES)
    : [];
  if (files.length === 0) {
    return Response.json({ entities: {} });
  }

  try {
    return Response.json(
      await getGraphEntitiesByFile({
        files,
        limit: Math.min(12, Math.max(1, Number(body.limit) || 8)),
      })
    );
  } catch {
    return Response.json(
      { error: "knowledge graph unavailable" },
      { status: 502 }
    );
  }
}
