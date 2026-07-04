"use client";

import { useEffect, useMemo, useState } from "react";
import type { AuthorRec } from "@/lib/atlas/types";
import type { WorldData } from "./derive";
import { useWorld } from "./store";
import { tempBand, tempCSS } from "./temperature";
import { uMorph } from "./uniforms";

/**
 * Semantle, corpus edition: a real passage from a real paper, pinned to its
 * true location on the map. Name the paper's FIRST author. Naming a co-author
 * is called out as a hint; every guess also reports how semantically close
 * that author's whole body of work is to the target's.
 */

interface StoredGuess {
  name: string;
  idx: number;
  temperature: number;
  coauthor: boolean;
  ts: number;
}

interface DayState {
  day: number;
  guesses: StoredGuess[];
  status: "playing" | "won" | "revealed";
  target: string | null;
  targetPaper: string | null;
}

const KEY = "atlas-world:semantle:v2";

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
  return { day, guesses: [], status: "playing", target: null, targetPaper: null };
}

function saveState(s: DayState) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* unsaved is fine */
  }
}

interface Passage {
  chunkId: string;
  text: string;
  section: string;
}

export default function GamePanel({
  data,
  authors,
}: {
  data: WorldData;
  authors: AuthorRec[];
}) {
  const [meta, setMeta] = useState<{ day: number; nEligible: number } | null>(null);
  const [passage, setPassage] = useState<Passage | null>(null);
  const [state, setState] = useState<DayState | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const set = useWorld((s) => s.set);
  const select = useWorld((s) => s.select);
  const requestWarp = useWorld((s) => s.requestWarp);

  useEffect(() => {
    fetch("/api/atlas/semantle-author")
      .then((r) => r.json())
      .then(
        (m: { day: number; nEligible: number; passage: Passage; error?: string }) => {
          if (m.error) throw new Error(m.error);
          setMeta({ day: m.day, nEligible: m.nEligible });
          setPassage(m.passage);
          setState(loadState(m.day));
        },
      )
      .catch(() => setNotice("the corpus engine isn't answering — try later"));
  }, []);

  // pin today's passage on the map
  const chunkIdx = useMemo(
    () => (passage ? (data.chunkIdToIdx.get(passage.chunkId) ?? null) : null),
    [passage, data],
  );
  useEffect(() => {
    set("gameChunk", chunkIdx);
    return () => set("gameChunk", null);
  }, [chunkIdx, set]);

  const flyToPassage = () => {
    if (chunkIdx === null) return;
    const m = uMorph.value;
    const gx = data.chunkGround[chunkIdx * 3];
    const gy = data.chunkGroundY[chunkIdx];
    const gz = data.chunkGround[chunkIdx * 3 + 2];
    requestWarp(
      [
        gx + (data.chunkSpace[chunkIdx * 3] - gx) * m,
        gy + (data.chunkSpace[chunkIdx * 3 + 1] - gy) * m,
        gz + (data.chunkSpace[chunkIdx * 3 + 2] - gz) * m,
      ],
      14,
      1.9,
    );
  };

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
        coauthor?: boolean;
        temperature?: number;
        guessIdx?: number;
        guessName?: string;
        target?: { name: string; paperTitle: string; paperIdx: number };
      };
      if (!r.ok) throw new Error(body.error ?? `semantle: ${r.status}`);
      const g: StoredGuess = {
        name: body.guessName ?? name,
        idx: body.guessIdx ?? -1,
        temperature: body.temperature ?? 0,
        coauthor: body.coauthor === true,
        ts: Date.now(),
      };
      const won = body.correct === true;
      update({
        ...state,
        guesses: [...state.guesses, g],
        status: won ? "won" : state.status,
        target: won ? (body.target?.name ?? g.name) : state.target,
        targetPaper: won ? (body.target?.paperTitle ?? null) : state.targetPaper,
      });
      if (g.idx >= 0) ping(g.idx, won ? 100 : (body.temperature ?? 0));
      if (won && body.target) {
        select({ kind: "paper", idx: body.target.paperIdx });
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
      const body = (await r.json()) as {
        target?: { name: string; idx: number; paperTitle: string; paperIdx: number };
      };
      update({
        ...state,
        status: "revealed",
        target: body.target?.name ?? null,
        targetPaper: body.target?.paperTitle ?? null,
      });
      if (body.target) {
        ping(body.target.idx, 100);
        select({ kind: "paper", idx: body.target.paperIdx });
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
          Semantle {meta ? `· #${meta.day - 20635}` : ""}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
          Today's passage, pinned to its true spot on the map. Name the paper's{" "}
          <span className="text-ink-2">first author</span>. Co-authors count as
          hints; every guess shows how close that author's work is.
        </p>
      </div>

      {passage && (
        <div className="rounded-md border hairline p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] tracking-[0.25em] text-ink-3 uppercase">
              {passage.section && passage.section !== "Untitled"
                ? passage.section
                : "the passage"}
            </p>
            <button
              type="button"
              className="shrink-0 text-[10px] text-[#c98500] underline decoration-dotted"
              onClick={flyToPassage}
            >
              fly to it
            </button>
          </div>
          <p className="hud-scroll mt-1.5 max-h-44 overflow-y-auto text-[11px] leading-relaxed text-ink-2">
            {passage.text}
          </p>
        </div>
      )}

      {state?.status === "playing" && (
        <div>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="who led this paper?"
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
            {state.status === "won"
              ? `found in ${state.guesses.length} guess${state.guesses.length === 1 ? "" : "es"}`
              : "it was"}
          </p>
          <p className="font-display mt-1 text-xl text-[#ffd27a]">{state.target}</p>
          {state.targetPaper && (
            <p className="mt-1 line-clamp-2 text-[11px] text-ink-3">
              {state.targetPaper}
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
                <span className="line-clamp-1 text-ink-2">
                  {g.name}
                  {g.coauthor && (
                    <span className="ml-1.5 rounded-full border border-[#c98500]/60 px-1.5 text-[9px] tracking-wide text-[#c98500] uppercase">
                      co-author!
                    </span>
                  )}
                </span>
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
