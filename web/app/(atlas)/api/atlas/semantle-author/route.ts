import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { pcQueryServer } from "@/lib/atlas/pc";

export const maxDuration = 30;

/**
 * Semantle, corpus edition: each day the server picks a real PASSAGE from the
 * corpus. Players see the passage (and its location on the map) and must name
 * the paper's FIRST author. Guessing a co-author is flagged as a hint, not a
 * win. Temperatures come from precomputed oeuvre-centroid cosines over the
 * real 4096-d chunk vectors, rank-calibrated.
 *
 * Data: server-data/author_game.json is SELF-CONTAINED (pool names, full
 * pool×pool cosine matrix, candidate papers with prebuilt chunk ids), written
 * by data-pipeline/export_metadata.py from the canonical paper database.
 * Passage prose is fetched live from the PC query server's /chunk_text — no
 * local chunk-text table.
 *
 * GET  → { day, nEligible, passage: { chunkId, text, section } }
 * POST { guess } → { correct, coauthor, temperature, rank, ... }
 * POST { reveal: true } → { target }
 */

interface Candidate {
  i: number; // papers.json idx
  t: number; // pool row of the first author
  c: string[]; // chunk ids to draw the passage from
  co?: number[]; // pool rows of co-authors in the pool
}

interface GameData {
  names: string[];
  nPapers: number[];
  eligible: number[];
  sim: number[][]; // full pool × pool
  papers: Candidate[];
}

interface PaperRec {
  file: string;
  title: string;
  year: number;
}

interface Store {
  game: GameData;
  papers: PaperRec[];
}

interface ChunkTextRec {
  text: string;
  section: string;
  page: number | null;
  file: string;
}

let store: Store | null = null;

function load(): Store {
  if (store) return store;
  const game = JSON.parse(
    readFileSync(join(process.cwd(), "server-data", "author_game.json"), "utf-8"),
  ) as GameData;
  if (!Array.isArray(game.papers)) {
    throw new Error(
      "author_game.json predates the self-contained format — rerun data-pipeline/export_metadata.py",
    );
  }
  const papers = JSON.parse(
    readFileSync(join(process.cwd(), "public", "data", "papers.json"), "utf-8"),
  ) as PaperRec[];
  store = { game, papers };
  return store;
}

function dayNumber(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function seeded(n: number, salt: number): number {
  let t = (dayNumber() + salt) * 2654435761 + 0x9e3779b9;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
}

function today(s: Store): Candidate {
  return s.game.papers[seeded(s.game.papers.length, 0)];
}

async function fetchChunkText(ids: string[]): Promise<Record<string, ChunkTextRec>> {
  const r = await pcQueryServer("/chunk_text", { ids });
  if (!r.ok) return {};
  const data = (await r.json()) as { chunks?: Record<string, ChunkTextRec> };
  return data.chunks ?? {};
}

/** The day's passage: seeded pick, skipping chunks whose prose is too short. */
async function todaysPassage(
  cand: Candidate,
): Promise<{ chunkId: string; text: string; section: string }> {
  const start = seeded(cand.c.length, 7);
  const order = cand.c.map((_, k) => cand.c[(start + k) % cand.c.length]);
  const chunks = await fetchChunkText(order);
  for (const id of order) {
    const rec = chunks[id];
    if ((rec?.text ?? "").length >= 400) {
      return { chunkId: id, text: rec.text.slice(0, 1400), section: rec.section ?? "" };
    }
  }
  const id = order[0];
  const rec = chunks[id];
  return { chunkId: id, text: (rec?.text ?? "").slice(0, 1400), section: rec?.section ?? "" };
}

function normName(x: string): string {
  return x.trim().toLowerCase().replace(/\s+/g, " ");
}

function targetPayload(s: Store, d: Candidate) {
  return {
    name: s.game.names[d.t],
    idx: d.t,
    paperTitle: s.papers[d.i].title,
    paperIdx: d.i,
    year: s.papers[d.i].year,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const s = load();
    const d = today(s);
    const passage = await todaysPassage(d);
    return NextResponse.json({
      day: dayNumber(),
      nEligible: s.game.eligible.length,
      passage,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const s = load();
    const d = today(s);
    const body = (await req.json()) as { guess?: string; reveal?: boolean };

    if (body.reveal) {
      return NextResponse.json({ revealed: true, target: targetPayload(s, d) });
    }

    const guess = normName(body.guess ?? "");
    if (!guess) {
      return NextResponse.json({ error: "guess required" }, { status: 400 });
    }
    const guessIdx = s.game.names.findIndex((n) => normName(n) === guess);
    if (guessIdx === -1) {
      return NextResponse.json(
        { error: "unknown author — pick a name from the corpus author list" },
        { status: 404 },
      );
    }

    const correct = guessIdx === d.t;
    const coauthor = !correct && (d.co ?? []).includes(guessIdx);

    const simRow = s.game.sim[d.t];
    const cosine = simRow[guessIdx];
    let rank = 0;
    for (let i = 0; i < simRow.length; i++) {
      if (i !== d.t && simRow[i] > cosine) rank++;
    }
    const n = simRow.length - 1;
    const temperature = correct
      ? 100
      : coauthor
        ? Math.max(92, Math.round(Math.pow(1 - rank / Math.max(1, n), 2.2) * 990) / 10)
        : Math.round(Math.pow(1 - rank / Math.max(1, n), 2.2) * 990) / 10;

    return NextResponse.json({
      correct,
      coauthor,
      temperature,
      cosine,
      rank,
      nAuthors: simRow.length,
      guessIdx,
      guessName: s.game.names[guessIdx],
      guessNPapers: s.game.nPapers[guessIdx],
      ...(correct ? { target: targetPayload(s, d) } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
