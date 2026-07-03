import { NextRequest, NextResponse } from "next/server";
import { pcQueryServer } from "@/lib/pc";

const ALLOWED = new Set(["query", "retrieve", "search"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ op: string }> },
) {
  const { op } = await params;
  if (!ALLOWED.has(op)) {
    return NextResponse.json({ error: "unknown op" }, { status: 404 });
  }
  try {
    const body = await req.json();
    const r = await pcQueryServer(`/${op}`, body);
    const data = await r.json();
    return NextResponse.json(data, { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
