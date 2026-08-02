import { auth } from "@/app/(auth)/auth";
import { getPapersIndex } from "@/lib/aprag/client";

// Slim corpus index ([filename, title, first_author_family, year] per paper) for the
// composer's client-side paper-mention detection. The corpus is read-mostly, so the
// payload is cached in-module for an hour rather than proxied on every keystroke-
// triggered fetch.

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
    const data = await getPapersIndex();
    cache = { at: Date.now(), data };
    return Response.json(data);
  } catch {
    return Response.json({ error: "papers index unavailable" }, { status: 502 });
  }
}
