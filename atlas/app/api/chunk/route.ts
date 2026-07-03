import { NextRequest, NextResponse } from "next/server";
import { chunkTextTable } from "@/lib/chunkText";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const rec = chunkTextTable()[id];
  if (!rec) return NextResponse.json({ error: "unknown chunk" }, { status: 404 });
  return NextResponse.json(rec);
}
