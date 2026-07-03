import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { chunkTextTable } from "@/lib/atlas/chunkText";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const rec = chunkTextTable()[id];
  if (!rec) return NextResponse.json({ error: "unknown chunk" }, { status: 404 });
  return NextResponse.json(rec);
}
