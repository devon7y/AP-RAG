import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { pcEmbed, qdrantSearch } from "@/lib/atlas/pc";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { text, vector, limit } = await req.json();
    let v: number[] | undefined = vector;
    if (!v) {
      if (typeof text !== "string" || !text.trim()) {
        return NextResponse.json({ error: "text or vector required" }, { status: 400 });
      }
      [v] = await pcEmbed([text], "query");
    }
    const hits = await qdrantSearch(v!, Math.min(limit ?? 10, 100));
    return NextResponse.json({ hits });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
