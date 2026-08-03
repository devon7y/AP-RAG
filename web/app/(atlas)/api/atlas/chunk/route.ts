import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { pcQueryServer } from "@/lib/atlas/pc";

export const maxDuration = 60;

/**
 * One passage's prose, by chunk id.
 *
 * This used to read a JSON table bundled into the function. At the full corpus
 * that table is ~445k passages — far past what a serverless bundle can carry —
 * so the text now comes from the query server, which already has the store open.
 * The map ships positions; the words arrive when you click.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  try {
    const r = await pcQueryServer("/chunk_text", { ids: [id] });
    if (!r.ok) {
      // an older query server has no /chunk_text yet — degrade to "no text"
      // rather than surfacing a 500 into the inspector
      return NextResponse.json(
        { text: "", section: "", page: null, file: "", unavailable: true },
        { status: r.status === 404 ? 200 : 502 },
      );
    }
    const data = (await r.json()) as {
      chunks?: Record<string, { text: string; section: string; page: number | null; file: string }>;
    };
    const rec = data.chunks?.[id];
    if (!rec) return NextResponse.json({ error: "unknown chunk" }, { status: 404 });
    return NextResponse.json(rec);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
