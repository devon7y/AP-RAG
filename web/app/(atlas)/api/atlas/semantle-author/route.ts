import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { chunkTextTable } from "@/lib/atlas/chunkText";

export const maxDuration = 30;

/**
 * Semantle, corpus edition: each day the server picks a real PASSAGE from the
 * corpus. Players see the passage (and its location on the map) and must name
 * the paper's FIRST author. Guessing a co-author is flagged as a hint, not a
 * win. Temperatures come from precomputed oeuvre-centroid cosines over the
 * real 4096-d chunk vectors, rank-calibrated.
 *
 * GET  → { day, nEligible, passage: { chunkId, text, section } }
 * POST { guess } → { correct, coauthor, temperature, rank, ... }
 * POST { reveal: true } → { target }
 *
 * Scale note: at the full corpus swap the sim matrix for on-demand centroid
 * cosines via the PC's /paper_centroid.
 */

interface GameData {
  names: string[];
  nPapers: number[];
  eligible: number[];
  sim: number[][]; // eligible × all
}

interface PaperRec {
  file: string;
  title: string;
  authors: string;
  year: number;
  nChunks: number;
}

interface AuthorRec {
  name: string;
  papers: number[];
}

interface Store {
  game: GameData;
  papers: PaperRec[];
  authors: AuthorRec[];
  firstIdx: number[]; // per paper → authors.json idx
  paperChunks: Map<number, string[]>; // paper idx → chunkIds (long-enough ones)
  candidatePapers: number[]; // papers whose first author is an eligible target
}

let store: Store | null = null;

function load(): Store {
  if (store) return store;
  const pub = (f: string) =>
    JSON.parse(readFileSync(join(process.cwd(), "public", "data", f), "utf-8"));
  const game = JSON.parse(
    readFileSync(join(process.cwd(), "server-data", "author_game.json"), "utf-8"),
  ) as GameData;
  const papers = pub("papers.json") as PaperRec[];
  const authors = pub("authors.json") as AuthorRec[];
  const meta = pub("papermeta.json") as { first: number[] };
  const firstIdx = meta.first;

  const fileToPaper = new Map(papers.map((p, i) => [p.file, i]));
  const paperChunks = new Map<number, string[]>();
  for (const [chunkId, rec] of Object.entries(chunkTextTable())) {
    const pi = fileToPaper.get((rec as { file: string }).file);
    if (pi === undefined) continue;
    if (((rec as { text: string }).text ?? "").length < 400) continue;
    const list = paperChunks.get(pi);
    if (list) list.push(chunkId);
    else paperChunks.set(pi, [chunkId]);
  }

  const eligibleSet = new Set(game.eligible);
  const candidatePapers = papers
    .map((_, i) => i)
    .filter(
      (i) =>
        firstIdx[i] >= 0 &&
        eligibleSet.has(firstIdx[i]) &&
        (paperChunks.get(i)?.length ?? 0) >= 3,
    );

  store = { game, papers, authors, firstIdx, paperChunks, candidatePapers };
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

interface Daily {
  paperIdx: number;
  chunkId: string;
  targetAuthor: number; // authors.json idx
}

function today(s: Store): Daily {
  const paperIdx = s.candidatePapers[seeded(s.candidatePapers.length, 0)];
  const chunks = s.paperChunks.get(paperIdx)!;
  return {
    paperIdx,
    chunkId: chunks[seeded(chunks.length, 7)],
    targetAuthor: s.firstIdx[paperIdx],
  };
}

function normName(x: string): string {
  return x.trim().toLowerCase().replace(/\s+/g, " ");
}

function targetPayload(s: Store, d: Daily) {
  return {
    name: s.game.names[d.targetAuthor],
    idx: d.targetAuthor,
    paperTitle: s.papers[d.paperIdx].title,
    paperIdx: d.paperIdx,
    year: s.papers[d.paperIdx].year,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const s = load();
  const d = today(s);
  const rec = chunkTextTable()[d.chunkId] as
    | { text: string; section: string }
    | undefined;
  return NextResponse.json({
    day: dayNumber(),
    nEligible: s.game.eligible.length,
    passage: {
      chunkId: d.chunkId,
      text: (rec?.text ?? "").slice(0, 1400),
      section: rec?.section ?? "",
    },
  });
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

    const correct = guessIdx === d.targetAuthor;
    const coauthor =
      !correct && (s.authors[guessIdx]?.papers ?? []).includes(d.paperIdx);

    const row = s.game.eligible.indexOf(d.targetAuthor);
    const simRow = s.game.sim[row];
    const cosine = simRow[guessIdx];
    let rank = 0;
    for (let i = 0; i < simRow.length; i++) {
      if (i !== d.targetAuthor && simRow[i] > cosine) rank++;
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
