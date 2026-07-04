import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";

export const maxDuration = 30;

/**
 * Daily hidden-AUTHOR game (the guessable-author variant of Semantle).
 * Temperatures come from precomputed oeuvre-centroid cosines over the real
 * 4096-d chunk vectors (server-data/author_game.json, from export_metadata.py).
 * Rank-based temperature keeps the game fair even though embedding cosines
 * compress into a narrow band.
 *
 * GET  → { day, nEligible, nAuthors }
 * POST { guess: "<author name>" } → { temperature, cosine, rank, correct, ... }
 * POST { reveal: true }           → { target }
 *
 * Scale note: at the full corpus (~30k authors) swap the matrix for on-demand
 * centroid cosines via the PC's /paper_centroid.
 */

interface GameData {
  names: string[];
  nPapers: number[];
  eligible: number[];
  sim: number[][]; // eligible × all
}

let data: GameData | null = null;
function load(): GameData {
  data ??= JSON.parse(
    readFileSync(join(process.cwd(), "server-data", "author_game.json"), "utf-8"),
  ) as GameData;
  return data!;
}

function dayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function targetRow(g: GameData): number {
  let t = dayNumber() * 2654435761 + 0x9e3779b9;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return Math.floor(r * g.eligible.length);
}

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const g = load();
  return NextResponse.json({
    day: dayNumber(),
    nEligible: g.eligible.length,
    nAuthors: g.names.length,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const g = load();
    const row = targetRow(g);
    const targetIdx = g.eligible[row];
    const body = (await req.json()) as { guess?: string; reveal?: boolean };

    if (body.reveal) {
      return NextResponse.json({
        revealed: true,
        target: { name: g.names[targetIdx], idx: targetIdx, nPapers: g.nPapers[targetIdx] },
      });
    }

    const guess = normName(body.guess ?? "");
    if (!guess) {
      return NextResponse.json({ error: "guess required" }, { status: 400 });
    }
    const guessIdx = g.names.findIndex((n) => normName(n) === guess);
    if (guessIdx === -1) {
      return NextResponse.json(
        { error: "unknown author — pick a name from the corpus author list" },
        { status: 404 },
      );
    }

    const correct = guessIdx === targetIdx;
    const simRow = g.sim[row];
    const cosine = simRow[guessIdx];
    // rank among all authors by closeness to the target (0 = the target itself)
    let rank = 0;
    for (let i = 0; i < simRow.length; i++) {
      if (i !== targetIdx && simRow[i] > cosine) rank++;
    }
    const n = simRow.length - 1;
    const temperature = correct
      ? 100
      : Math.round(Math.pow(1 - rank / Math.max(1, n), 2.2) * 990) / 10;

    return NextResponse.json({
      correct,
      temperature,
      cosine,
      rank,
      nAuthors: simRow.length,
      guessIdx,
      guessName: g.names[guessIdx],
      guessNPapers: g.nPapers[guessIdx],
      ...(correct
        ? { target: { name: g.names[targetIdx], idx: targetIdx, nPapers: g.nPapers[targetIdx] } }
        : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
