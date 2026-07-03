import { NextRequest, NextResponse } from "next/server";
import { pcEmbed } from "@/lib/pc";

export async function POST(req: NextRequest) {
  try {
    const { texts, context } = await req.json();
    if (!Array.isArray(texts) || texts.length === 0 || texts.length > 16) {
      return NextResponse.json({ error: "texts: 1-16 strings" }, { status: 400 });
    }
    const embeddings = await pcEmbed(texts, context === "document" ? "document" : "query");
    return NextResponse.json({ embeddings });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
