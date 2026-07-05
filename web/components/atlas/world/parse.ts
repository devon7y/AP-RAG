"use client";

import type { AuthorRec } from "@/lib/atlas/types";

/**
 * One language for the command bar:
 *   memory consolidation             → semantic warp
 *   humor -> word frequency          → interpolation geodesic
 *   humor - comedy + memory          → embedding arithmetic
 *   @Westbury                        → author lens + trail
 *   year:1990..2005 | year:1995      → time window
 *   journal:cognition | kw:entropy   → metadata lens
 *   ghost | radio | clear            → instruments
 */

export interface SignedTerm {
  sign: "+" | "−";
  text: string;
}

export type Command =
  | { kind: "warp"; query: string }
  | { kind: "interpolate"; a: string; b: string }
  | { kind: "arithmetic"; terms: SignedTerm[] }
  | { kind: "author"; name: string }
  | { kind: "year"; from: number | null; to: number }
  | { kind: "journal"; value: string }
  | { kind: "keyword"; value: string }
  | { kind: "ghost" }
  | { kind: "radio" }
  | { kind: "clear" };

export function parseCommand(raw: string): Command | null {
  const input = raw.trim();
  if (!input) return null;
  const lower = input.toLowerCase();

  if (lower === "ghost" || lower === "plant") return { kind: "ghost" };
  if (lower === "radio") return { kind: "radio" };
  if (lower === "clear" || lower === "reset") return { kind: "clear" };

  const yearM = lower.match(/^year:\s*(\d{4})(?:\s*(?:\.\.|-|–)\s*(\d{4}))?$/);
  if (yearM) {
    const a = Number.parseInt(yearM[1], 10);
    const b = yearM[2] ? Number.parseInt(yearM[2], 10) : null;
    return b !== null
      ? { kind: "year", from: Math.min(a, b), to: Math.max(a, b) }
      : { kind: "year", from: null, to: a };
  }

  const jM = input.match(/^journal:\s*(.+)$/i);
  if (jM) return { kind: "journal", value: jM[1].trim() };
  const kM = input.match(/^(?:kw|keyword|subject):\s*(.+)$/i);
  if (kM) return { kind: "keyword", value: kM[1].trim() };

  const interpM = input.split(/\s*(?:->|→|=>)\s*/);
  if (interpM.length === 2 && interpM[0].trim() && interpM[1].trim()) {
    return { kind: "interpolate", a: interpM[0].trim(), b: interpM[1].trim() };
  }

  // general embedding algebra: any mix of "a + b - c …" (spaces around ops).
  // checked BEFORE @author so "@westbury + @caplan - EEG" parses as math.
  const parts = input.split(/\s+([+\-−])\s+/);
  if (parts.length >= 3 && parts.length % 2 === 1) {
    const terms: SignedTerm[] = [{ sign: "+", text: parts[0].trim() }];
    let ok = parts[0].trim().length > 0;
    for (let i = 1; i < parts.length; i += 2) {
      const text = (parts[i + 1] ?? "").trim();
      if (!text) {
        ok = false;
        break;
      }
      terms.push({ sign: parts[i] === "+" ? "+" : "−", text });
    }
    if (ok) return { kind: "arithmetic", terms };
  }

  if (input.startsWith("@")) {
    const name = input.slice(1).trim();
    if (name) return { kind: "author", name };
  }

  return { kind: "warp", query: input };
}

/** Fuzzy author lookup: exact name → family → substring; prefers bigger oeuvres. */
export function findAuthor(authors: AuthorRec[], q: string): number | null {
  const n = q.trim().toLowerCase();
  if (!n) return null;
  let best: number | null = null;
  let bestScore = 0;
  authors.forEach((a, i) => {
    const name = a.name.toLowerCase();
    const family = a.family.toLowerCase();
    let score = 0;
    if (name === n) score = 400;
    else if (family === n) score = 300;
    else if (name.startsWith(n) || family.startsWith(n)) score = 200;
    else if (name.includes(n)) score = 100;
    if (!score) return;
    score += Math.min(60, a.papers.length); // tie-break toward bigger oeuvres
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** "@Name" inside interpolate/arithmetic slots becomes an author endpoint. */
export function slotToEndpoint(
  slot: string,
): { kind: "phrase"; text: string } | { kind: "author"; name: string } {
  if (slot.startsWith("@")) {
    const name = slot.slice(1).trim();
    if (name) return { kind: "author", name };
  }
  return { kind: "phrase", text: slot };
}
