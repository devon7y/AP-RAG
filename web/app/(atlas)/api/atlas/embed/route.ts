import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { pcEmbed } from "@/lib/atlas/pc";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
