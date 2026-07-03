import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { meanVector, pcEmbed, qdrantPaperVectors, qdrantSearch } from "@/lib/pc";

/**
 * Daily hidden-paper game. The server holds the secret; the client only ever
 * sees similarity temperatures — plus the full target on a win (or reveal).
 *
 * GET  → { day, nGuessable }               (puzzle id only)
 * POST { guess }         → temperature + map ping for a free-text guess
 * POST { paperFile }     → win check for an explicit paper identification
 * POST { reveal: true }  → give up: returns the target
 */

interface PaperRec {
  file: string;
  title: string;
  authors: string;
  year: number;
  journal: string;
  nChunks: number;
  centroid: [number, number];
}

let papers: PaperRec[] | null = null;
const centroidCache = new Map<string, number[]>();

function loadPapers(): PaperRec[] {
  papers ??= (
    JSON.parse(
      readFileSync(join(process.cwd(), "public", "data", "papers.json"), "utf-8"),
    ) as PaperRec[]
  ).filter((p) => p.nChunks >= 15);
  return papers!;
}

function dayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/** Deterministic per-day pick (mulberry32 over the day number). */
function targetForToday(pool: PaperRec[]): PaperRec {
  let t = dayNumber() + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return pool[Math.floor(r * pool.length)];
}

async function targetCentroid(file: string): Promise<number[]> {
  const hit = centroidCache.get(file);
  if (hit) return hit;
  const vecs = await qdrantPaperVectors(file);
  const c = meanVector(vecs);
  centroidCache.set(file, c);
  return c;
}

/** Map cosine to a 0-100 temperature with a game-friendly curve.
 *  Qwen3 cosines for unrelated text sit ~0.3-0.45; same-topic ~0.6+; so stretch that band. */
function temperature(cos: number): number {
  const t = (cos - 0.35) / (0.78 - 0.35);
  return Math.round(Math.min(1, Math.max(0, t)) * 1000) / 10;
}

export async function GET() {
  const pool = loadPapers();
  return NextResponse.json({ day: dayNumber(), nGuessable: pool.length });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const pool = loadPapers();
    const target = targetForToday(pool);

    if (body.reveal === true) {
      return NextResponse.json({ revealed: true, target });
    }

    if (typeof body.paperFile === "string") {
      const correct = body.paperFile === target.file;
      return NextResponse.json(
        correct ? { correct: true, target } : { correct: false },
      );
    }

    const guess = String(body.guess ?? "").trim();
    if (!guess) return NextResponse.json({ error: "guess required" }, { status: 400 });

    const [gv] = await pcEmbed([guess.slice(0, 500)], "query");
    const centroid = await targetCentroid(target.file);
    let dot = 0;
    for (let i = 0; i < gv.length; i++) dot += gv[i] * centroid[i];
    const gn = Math.sqrt(gv.reduce((s, v) => s + v * v, 0)) + 1e-9;
    const cos = dot / gn; // centroid already unit-norm

    // Where the guess itself lands in the corpus (top hit) — the map ping.
    const [top] = await qdrantSearch(gv, 1);

    return NextResponse.json({
      temperature: temperature(cos),
      cosine: Math.round(cos * 10000) / 10000,
      ping: top ? { chunkId: top.chunkId, file: top.file, score: top.score } : null,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
