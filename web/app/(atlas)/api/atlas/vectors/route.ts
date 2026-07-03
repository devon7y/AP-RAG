import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { qdrantVectors } from "@/lib/atlas/pc";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { qids } = await req.json();
    if (!Array.isArray(qids) || qids.length === 0 || qids.length > 64) {
      return NextResponse.json({ error: "qids: 1-64 ids" }, { status: 400 });
    }
    const vectors = await qdrantVectors(qids);
    return NextResponse.json({ vectors });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
