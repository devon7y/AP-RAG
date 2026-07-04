"use client";

import { useEffect, useMemo, useState } from "react";
import { tempBand, tempCSS } from "@/components/atlas/semantle/game";
import type { AuthorRec } from "@/lib/atlas/types";
import { useWorld } from "./store";

/**
 * The daily hidden-author game. Guess researchers from the corpus; every
 * guess flares on the map at that author's oeuvre, colored by temperature
 * (real oeuvre-centroid cosine, rank-calibrated server-side). Win by naming
 * the author of the day.
 */

interface StoredGuess {
  name: string;
  idx: number;
  temperature: number;
  rank: number;
  nPapers: number;
  ts: number;
}

interface DayState {
  day: number;
  guesses: StoredGuess[];
  status: "playing" | "won" | "revealed";
  target: string | null;
}

const KEY = "atlas-world:author-game:v1";

function loadState(day: number): DayState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as DayState;
      if (s.day === day) return s;
    }
  } catch {
    /* fresh */
  }
  return { day, guesses: [], status: "playing", target: null };
}

function saveState(s: DayState) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* unsaved is fine */
  }
}

export default function GamePanel({ authors }: { authors: AuthorRec[] }) {
  const [meta, setMeta] = useState<{ day: number; nEligible: number } | null>(null);
  const [state, setState] = useState<DayState | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const set = useWorld((s) => s.set);
  const setLens = useWorld((s) => s.setLens);

  useEffect(() => {
    fetch("/api/atlas/semantle-author")
      .then((r) => r.json())
      .then((m: { day: number; nEligible: number }) => {
        setMeta(m);
        setState(loadState(m.day));
      })
      .catch(() => setNotice("the corpus engine isn't answering — try later"));
  }, []);

  const matches = useMemo(() => {
    const q = input.trim().toLowerCase();
    if (!q || !state || state.status !== "playing") return [];
    const guessed = new Set(state.guesses.map((g) => g.name));
    return authors
      .filter((a) => !guessed.has(a.name) && a.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [authors, input, state]);

  const update = (s: DayState) => {
    setState(s);
    saveState(s);
  };

  const ping = (idx: number, temperature: number) => {
    const st = useWorld.getState();
    st.set("gamePings", [
      ...st.gamePings.slice(-13),
      { authorIdx: idx, temperature, ts: Date.now() },
    ]);
  };

  const guess = async (name: string) => {
    if (!state || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch("/api/atlas/semantle-author", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guess: name }),
      });
      const body = (await r.json()) as {
        error?: string;
        correct?: boolean;
        temperature?: number;
        rank?: number;
        guessIdx?: number;
        guessName?: string;
        guessNPapers?: number;
        target?: { name: string };
      };
      if (!r.ok) throw new Error(body.error ?? `game: ${r.status}`);
      const g: StoredGuess = {
        name: body.guessName ?? name,
        idx: body.guessIdx ?? -1,
        temperature: body.temperature ?? 0,
        rank: body.rank ?? 0,
        nPapers: body.guessNPapers ?? 0,
        ts: Date.now(),
      };
      const won = body.correct === true;
      update({
        ...state,
        guesses: [...state.guesses, g],
        status: won ? "won" : state.status,
        target: won ? (body.target?.name ?? g.name) : state.target,
      });
      if (g.idx >= 0) ping(g.idx, won ? 100 : (body.temperature ?? 0));
      if (won && g.idx >= 0) {
        setLens({ author: g.idx });
        set("instrument", "lenses");
      }
      setInput("");
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (!state || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/atlas/semantle-author", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reveal: true }),
      });
      const body = (await r.json()) as { target?: { name: string; idx: number } };
      update({
        ...state,
        status: "revealed",
        target: body.target?.name ?? null,
      });
      if (body.target) {
        const i = authors.findIndex((a) => a.name === body.target!.name);
        if (i >= 0) ping(i, 100);
      }
    } catch {
      setNotice("couldn't reveal — try again");
    } finally {
      setBusy(false);
    }
  };

  const sorted = state
    ? [...state.guesses].sort((a, b) => b.temperature - a.temperature)
    : [];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[10px] tracking-[0.3em] text-ink-3 uppercase">
          Daily author {meta ? `· #${meta.day - 20635}` : ""}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          A researcher from the corpus is hidden. Every guess measures how close
          that author's whole body of work is to theirs — and flares on the map
          where the guess lives. {meta ? `${meta.nEligible} possible targets.` : ""}
        </p>
      </div>

      {state?.status === "playing" && (
        <div>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="guess an author…"
            disabled={busy}
            className="w-full rounded-md border hairline bg-transparent px-2 py-1.5 text-xs text-ink outline-none placeholder:text-ink-3"
          />
          {matches.length > 0 && (
            <ul className="mt-1 max-h-36 space-y-0.5 overflow-y-auto">
              {matches.map((a) => (
                <li key={a.name}>
                  <button
                    type="button"
                    disabled={busy}
                    className="w-full rounded px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5 hover:text-ink"
                    onClick={() => guess(a.name)}
                  >
                    {a.name} <span className="text-ink-3">· {a.papers.length}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state && state.status !== "playing" && (
        <div className="rounded-md border border-[#ffd27a]/50 p-3 text-center">
          <p className="text-[10px] tracking-[0.25em] text-ink-3 uppercase">
            {state.status === "won" ? "found in" : "it was"}
          </p>
          <p className="font-display mt-1 text-xl text-[#ffd27a]">{state.target}</p>
          {state.status === "won" && (
            <p className="mt-1 text-[11px] text-ink-3">
              {state.guesses.length} guess{state.guesses.length === 1 ? "" : "es"} —
              their trail is lit gold
            </p>
          )}
        </div>
      )}

      {notice && <p className="text-[11px] text-[#fab219]">{notice}</p>}

      {sorted.length > 0 && (
        <ul className="space-y-1">
          {sorted.map((g) => {
            const band = tempBand(g.temperature);
            return (
              <li
                key={g.ts}
                className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs"
              >
                <span className="line-clamp-1 text-ink-2">{g.name}</span>
                <span
                  className="shrink-0 rounded-full px-2 py-0.5 text-[10px] tabular-nums"
                  style={{
                    color: tempCSS(g.temperature),
                    border: `1px solid ${tempCSS(g.temperature)}55`,
                  }}
                >
                  {band.emoji} {g.temperature.toFixed(1)}°
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {state?.status === "playing" && state.guesses.length > 2 && (
        <button
          type="button"
          onClick={reveal}
          disabled={busy}
          className="w-full rounded-md border hairline px-3 py-1.5 text-[11px] tracking-widest text-ink-3 uppercase hover:text-ink"
        >
          give up · reveal
        </button>
      )}
    </div>
  );
}
