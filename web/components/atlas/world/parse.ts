"use client";

import type { AuthorRec } from "@/lib/atlas/types";

/**
 * One language for the command bar:
 *   memory consolidation             → semantic warp
 *   what predicts humor ratings?     → ask the atlas (?-prefix or trailing ?)
 *   humor -> word frequency          → interpolation geodesic
 *   humor - comedy + memory          → embedding arithmetic
 *   @Westbury                        → author lens + trail
 *   year:1990..2005 | year:1995      → time window
 *   journal:cognition | kw:entropy   → metadata lens
 *   ghost | draft | radio | clear    → instruments
 */

export interface SignedTerm {
  sign: "+" | "−";
  text: string;
}

export type Command =
  | { kind: "warp"; query: string }
  | { kind: "ask"; question: string }
  | { kind: "interpolate"; a: string; b: string }
  | { kind: "arithmetic"; terms: SignedTerm[] }
  | { kind: "author"; name: string }
  | { kind: "year"; from: number | null; to: number }
  | { kind: "journal"; value: string }
  | { kind: "keyword"; value: string }
  | { kind: "view"; view: "atlas" | "space" }
  | { kind: "reset" }
  | { kind: "timeplay" }
  | { kind: "timenow" }
  | { kind: "game" }
  | { kind: "help" }
  | { kind: "ghost" }
  | { kind: "draft" }
  | { kind: "radio" }
  | { kind: "clear" };

/** A half-typed operator at the end of an expression: "humor +", "humor ->".
 *  Longest alternatives first so "->" wins over a bare "-". */
const DANGLING_OP = /\s*(?:->|→|=>|\+|-|−)\s*$/;

/** Drop a trailing operator so a half-typed expression still previews the
 *  terms that ARE complete. Submission keeps the raw text — an incomplete
 *  expression should not run as a search. */
export function stripDanglingOperator(raw: string): string {
  return raw.replace(DANGLING_OP, "");
}

/** Strip one pair of surrounding quotes (straight or smart). */
export function stripQuotes(s: string): string {
  const m = s.trim().match(/^["“'](.*)["”']$/s);
  return m ? m[1].trim() : s.trim();
}

/** Split "a + b - c" into signed terms, ignoring operators inside quotes. */
function splitSigned(input: string): SignedTerm[] | null {
  const terms: SignedTerm[] = [];
  let cur = "";
  let sign: "+" | "−" = "+";
  let inQ = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"' || ch === "“" || ch === "”") {
      inQ = !inQ;
      cur += ch;
      continue;
    }
    if (
      !inQ &&
      (ch === "+" || ch === "-" || ch === "−") &&
      input[i - 1] === " " &&
      input[i + 1] === " "
    ) {
      terms.push({ sign, text: cur.trim() });
      sign = ch === "+" ? "+" : "−";
      cur = "";
      i++; // skip the following space
      continue;
    }
    cur += ch;
  }
  terms.push({ sign, text: cur.trim() });
  if (terms.length < 2 || terms.some((t) => !t.text)) return null;
  return terms.map((t) => ({ ...t, text: stripQuotes(t.text) }));
}

export function parseCommand(raw: string): Command | null {
  const input = raw.trim();
  if (!input) return null;
  const lower = input.toLowerCase();

  // a fully-quoted input is always a plain search — never math or a command
  const quoted = input.match(/^["“](.*)["”]$/s);
  if (quoted) {
    const inner = quoted[1].trim();
    return inner ? { kind: "warp", query: inner } : null;
  }

  // slash commands
  if (input.startsWith("/")) {
    switch (lower.slice(1).trim()) {
      case "landscape":
      case "land":
        return { kind: "view", view: "atlas" };
      case "galaxy":
      case "space":
        return { kind: "view", view: "space" };
      case "radio":
        return { kind: "radio" };
      case "gap":
      case "gaps":
        return { kind: "ghost" };
      case "draft":
        return { kind: "draft" };
      case "reset":
      case "home":
        return { kind: "reset" };
      case "play":
        return { kind: "timeplay" };
      case "now":
        return { kind: "timenow" };
      case "semantle":
      case "game":
        return { kind: "game" };
      case "clear":
        return { kind: "clear" };
      default:
        return { kind: "help" }; // unknown slash → show the command list
    }
  }

  // ask the atlas: "?" prefix or a trailing "?" turns the input into a
  // question for the RAG engine (beats every other pattern, so "a -> b?"
  // is a question, not a geodesic)
  if (input.startsWith("?") || input.endsWith("?")) {
    const question = (
      input.startsWith("?") ? input.slice(1) : input
    ).trim();
    return question.replace(/\?+$/, "").trim()
      ? { kind: "ask", question }
      : { kind: "help" };
  }

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
    return {
      kind: "interpolate",
      a: stripQuotes(interpM[0]),
      b: stripQuotes(interpM[1]),
    };
  }

  // general embedding algebra: any mix of "a + b - c …" (spaces around ops,
  // quoted spans protected). Checked BEFORE @author so "@westbury + @caplan
  // - EEG" parses as math.
  const terms = splitSigned(input);
  if (terms) return { kind: "arithmetic", terms };

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
  const s = stripQuotes(slot);
  if (s.startsWith("@")) {
    const name = s.slice(1).trim();
    if (name) return { kind: "author", name };
  }
  return { kind: "phrase", text: s };
}
