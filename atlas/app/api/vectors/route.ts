import { NextRequest, NextResponse } from "next/server";
import { qdrantVectors } from "@/lib/pc";

export async function POST(req: NextRequest) {
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
