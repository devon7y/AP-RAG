import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { pcPaperDetail } from "@/lib/atlas/pc";

export const maxDuration = 30;

/**
 * Full manifest record for one paper — abstract, affiliations, APA strings.
 *
 * The atlas pack ships a 320-character teaser because 10k abstracts would be
 * megabytes on every visit, and 99% of them were being cut mid-sentence. The
 * card fetches the whole thing when it opens, the same way passage text does.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const file = req.nextUrl.searchParams.get("file");
  if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });
  try {
    const r = await pcPaperDetail(file);
    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
