import { auth } from "@/app/(auth)/auth";
import { getStats } from "@/lib/aprag/client";

// Papers-in-the-database count for the header badge. Proxies the query server's /stats
// so the tunnel URL + key stay server-side. Behind auth; degrades to 0 on any error.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ papers: 0 }, { status: 401 });
  }
  try {
    return Response.json(await getStats());
  } catch {
    return Response.json({ papers: 0 });
  }
}
