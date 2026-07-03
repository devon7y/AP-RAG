import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { pcQueryServer } from "@/lib/atlas/pc";

export const maxDuration = 300;

const ALLOWED = new Set(["query", "retrieve", "search"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ op: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
