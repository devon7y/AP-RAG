import { NextRequest, NextResponse } from "next/server";
import { pcEmbed, qdrantSearch } from "@/lib/pc";

export async function POST(req: NextRequest) {
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
