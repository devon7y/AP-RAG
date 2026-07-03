"use client";

import type { Paper } from "@/lib/types";

/**
 * Client logic for Semantle: Corpus Edition (/api/semantle).
 * The server holds the daily secret; everything here is presentation state —
 * guesses, temperatures, localStorage persistence, share text.
 */

// ---------------------------------------------------------------- API types

export interface SemantleMeta {
  day: number;
  nGuessable: number;
}

/** What the route returns as `target` on win/reveal (a papers.json row). */
export interface ApiTarget {
  file: string;
  title: string;
  authors: string;
  year: number;
  journal: string;
  nChunks: number;
  centroid: [number, number];
}

export interface GuessResult {
  temperature: number;
  cosine: number;
  ping: { chunkId: string; file: string; score: number } | null;
}

async function post<T>(body: unknown): Promise<T> {
  const r = await fetch("/api/semantle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(
      (data as { error?: string } | null)?.error ?? `semantle: ${r.status}`,
    );
  }
  return data as T;
}

export function fetchMeta(): Promise<SemantleMeta> {
  return fetch("/api/semantle").then((r) => {
    if (!r.ok) throw new Error(`semantle meta: ${r.status}`);
    return r.json();
  });
}

export function apiGuess(guess: string): Promise<GuessResult> {
  return post<GuessResult>({ guess });
}

export function apiIdentify(
  paperFile: string,
): Promise<{ correct: boolean; target?: ApiTarget }> {
  return post({ paperFile });
}

export function apiReveal(): Promise<{ revealed: true; target: ApiTarget }> {
  return post({ reveal: true });
}

/** The PC stack answers guesses; translate transport-level failures for players. */
export function friendlyError(e: unknown): string {
  const msg = String(e instanceof Error ? e.message : e);
  if (/fetch failed|ECONN|ETIMEDOUT|AbortError|502|NetworkError/i.test(msg)) {
    return "The corpus engine (lab PC) isn't answering — try again in a minute.";
  }
  return msg;
}

// ---------------------------------------------------------------- game state

export type GameStatus = "playing" | "won" | "revealed";

export interface StoredGuess {
  text: string;
  temperature: number;
  cosine: number;
  /** atlas chunk index the guess pinged (null = not resolvable on the map) */
  chunkIdx: number | null;
  /** file of the nearest paper to the guess */
  file: string | null;
  ts: number;
}

export interface DayState {
  day: number;
  guesses: StoredGuess[];
  /** paper files struck out by wrong identifications */
  eliminated: string[];
  idAttempts: number;
  status: GameStatus;
  targetFile: string | null;
}

export interface Stats {
  played: number;
  won: number;
  streak: number;
  maxStreak: number;
  lastEndedDay: number | null;
  lastWonDay: number | null;
  totalGuessesOnWins: number;
}

export function emptyDayState(day: number): DayState {
  return {
    day,
    guesses: [],
    eliminated: [],
    idAttempts: 0,
    status: "playing",
    targetFile: null,
  };
}

export function emptyStats(): Stats {
  return {
    played: 0,
    won: 0,
    streak: 0,
    maxStreak: 0,
    lastEndedDay: null,
    lastWonDay: null,
    totalGuessesOnWins: 0,
  };
}

// ---------------------------------------------------------------- persistence

const STATE_KEY = "atlas-semantle:v1:state";
const STATS_KEY = "atlas-semantle:v1:stats";

export function loadDayState(day: number): DayState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as DayState;
    return s.day === day ? s : null;
  } catch {
    return null;
  }
}

export function saveDayState(s: DayState): void {
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* storage full/blocked — the game still plays, it just won't persist */
  }
}

export function loadStats(): Stats {
  if (typeof window === "undefined") return emptyStats();
  try {
    const raw = window.localStorage.getItem(STATS_KEY);
    return raw ? { ...emptyStats(), ...(JSON.parse(raw) as Stats) } : emptyStats();
  } catch {
    return emptyStats();
  }
}

export function saveStats(s: Stats): void {
  try {
    window.localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- day math

/** Same clock the server uses (UTC unix day). */
export function utcDay(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/** Puzzle #1 = 2026-07-02 UTC (launch day). */
export const EPOCH_DAY = 20_635;

export function puzzleNo(day: number): number {
  const n = day - EPOCH_DAY;
  return n > 0 ? n : day;
}

// ---------------------------------------------------------------- temperature

export function normGuess(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface Band {
  label: string;
  emoji: string;
}

/** Hot/cold bands over the route's 0–100 temperature curve. */
export function tempBand(t: number): Band {
  if (t < 20) return { label: "freezing", emoji: "🧊" };
  if (t < 40) return { label: "cold", emoji: "❄️" };
  if (t < 55) return { label: "cool", emoji: "🌫️" };
  if (t < 70) return { label: "warm", emoji: "🌡️" };
  if (t < 85) return { label: "hot", emoji: "🔥" };
  return { label: "scorching", emoji: "🌋" };
}

/** Sequential single-hue ramp for magnitude on dark surfaces:
 *  dim deep blue (cold) → bright blue → white-hot (the paper itself). */
const TEMP_STOPS: [number, number, number, number][] = [
  [0.0, 0x27 / 255, 0x46 / 255, 0x6b / 255], // #27466b
  [0.35, 0x2a / 255, 0x78 / 255, 0xd6 / 255], // #2a78d6
  [0.6, 0x55 / 255, 0x98 / 255, 0xe7 / 255], // #5598e7
  [0.8, 0x9e / 255, 0xc5 / 255, 0xf4 / 255], // #9ec5f4
  [0.93, 0xe2 / 255, 0xee / 255, 0xff / 255], // #e2eeff
  [1.0, 1, 1, 1],
];

/** temperature 0–100 → rgb floats 0..1 */
export function tempRGB(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t / 100));
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    if (x <= TEMP_STOPS[i][0]) {
      const [x0, r0, g0, b0] = TEMP_STOPS[i - 1];
      const [x1, r1, g1, b1] = TEMP_STOPS[i];
      const f = (x - x0) / (x1 - x0 || 1);
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
    }
  }
  return [1, 1, 1];
}

export function tempCSS(t: number): string {
  const [r, g, b] = tempRGB(t);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** CSS gradient for the legend strip (cold → scorching). */
export function tempGradientCSS(): string {
  const stops = [0, 20, 40, 55, 70, 85, 100]
    .map((t) => `${tempCSS(t)} ${t}%`)
    .join(", ");
  return `linear-gradient(90deg, ${stops})`;
}

// ---------------------------------------------------------------- display

/** "Author Year" short cite from a papers.json row. */
export function shortCite(p: Paper): string {
  const first = p.authors.split(/[,;&]/)[0]?.trim() || p.authors;
  return p.year ? `${first} ${p.year}` : first;
}

// ---------------------------------------------------------------- share

export function bestTemperature(state: DayState): number {
  return state.guesses.reduce((m, g) => Math.max(m, g.temperature), 0);
}

/** Wordle-style result for the lab thread — never leaks the answer. */
export function buildShareText(state: DayState): string {
  const n = state.guesses.length;
  const seq = state.guesses.map((g) => tempBand(g.temperature).emoji);
  const shown = seq.length > 20 ? ["…", ...seq.slice(-20)] : seq;
  const outcome =
    state.status === "won"
      ? `🎯 in ${n} guess${n === 1 ? "" : "es"}`
      : `🏳️ gave up after ${n}`;
  const lines = [
    `Atlas of Mind · Semantle #${puzzleNo(state.day)} — ${outcome}`,
    shown.join("") + (state.status === "won" ? "🎯" : "🏳️"),
    `best ${bestTemperature(state).toFixed(1)}°`,
  ];
  return lines.join("\n");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
