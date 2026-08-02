import { auth } from "@/app/(auth)/auth";
import { getGraphEntity } from "@/lib/aprag/client";

// One knowledge-graph entity's full card (description, neighbours, papers).
// Distinguishes "unknown entity" (404) from a backend outage (502).

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const name = new URL(request.url).searchParams.get("name")?.trim();
  if (!name) {
    return Response.json({ error: "name required" }, { status: 400 });
  }
  try {
    return Response.json(await getGraphEntity(name));
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return Response.json({ error: "unknown entity" }, { status: 404 });
    }
    return Response.json(
      { error: "knowledge graph unavailable" },
      { status: 502 }
    );
  }
}
