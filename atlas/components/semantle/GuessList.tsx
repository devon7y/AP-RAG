"use client";

import { useMemo } from "react";
import type { CorpusData } from "@/lib/types";
import type { DayState, StoredGuess } from "./game";
import { bestTemperature, shortCite, tempBand, tempCSS, tempGradientCSS } from "./game";

/**
 * Guess history, hottest first, with the latest guess pinned on top. Each row
 * shows the temperature bar (sequential ramp, direct-labeled) and where the
 * guess landed on the map. Hovering a row lights its ping in the scene.
 */
export default function GuessList({
  state,
  corpus,
  focusKey,
  onFocus,
}: {
  state: DayState;
  corpus: CorpusData;
  focusKey: number | null;
  onFocus: (key: number | null) => void;
}) {
  const clusterName = useMemo(() => {
    const m = new Map(corpus.clusters.map((c) => [c.id, c.name]));
    return (idx: number | null) =>
      idx === null ? null : (m.get(corpus.atlas.cluster[idx]) ?? null);
  }, [corpus]);

  const citeFor = useMemo(() => {
    const m = new Map(corpus.papers.map((p) => [p.file, p]));
    return (file: string | null) => {
      const p = file ? m.get(file) : undefined;
      return p ? shortCite(p) : null;
    };
  }, [corpus]);

  const sorted = useMemo(
    () =>
      [...state.guesses].sort(
        (a, b) => b.temperature - a.temperature || a.ts - b.ts,
      ),
    [state.guesses],
  );
  const latest = state.guesses[state.guesses.length - 1] ?? null;
  const best = bestTemperature(state);

  return (
    <div className="hud-panel pointer-events-auto flex min-h-0 flex-1 flex-col p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs tracking-widest text-ink-3 uppercase">
          Guesses ({state.guesses.length})
        </h3>
        {state.guesses.length > 0 && (
          <span className="text-[11px] text-ink-3">
            best <span className="text-ink-2">{best.toFixed(1)}°</span>
          </span>
        )}
      </div>

      {/* temperature scale */}
      <div className="mt-2 shrink-0">
        <div
          className="h-1.5 rounded-full"
          style={{ background: tempGradientCSS() }}
        />
        <div className="mt-1 flex justify-between text-[10px] text-ink-3">
          <span>0° · unrelated</span>
          <span>100° · the paper</span>
        </div>
      </div>

      {state.guesses.length === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-ink-3">
          No guesses yet. Try a topic — &ldquo;semantic priming in
          bilinguals&rdquo;, &ldquo;why puns are funny&rdquo; — and watch where
          it pings the map.
        </p>
      ) : (
        <ul className="hud-scroll mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {latest && (
            <>
              <Row
                g={latest}
                rank={sorted.findIndex((s) => s.ts === latest.ts) + 1}
                latest
                focused={focusKey === latest.ts}
                onFocus={onFocus}
                clusterName={clusterName}
                citeFor={citeFor}
              />
              <li
                aria-hidden
                className="mx-1 mt-2! mb-1 border-t border-hairline"
              />
            </>
          )}
          {sorted.map((g, i) => (
            <Row
              key={g.ts}
              g={g}
              rank={i + 1}
              focused={focusKey === g.ts}
              onFocus={onFocus}
              clusterName={clusterName}
              citeFor={citeFor}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  g,
  rank,
  latest = false,
  focused,
  onFocus,
  clusterName,
  citeFor,
}: {
  g: StoredGuess;
  rank: number;
  latest?: boolean;
  focused: boolean;
  onFocus: (key: number | null) => void;
  clusterName: (idx: number | null) => string | null;
  citeFor: (file: string | null) => string | null;
}) {
  const band = tempBand(g.temperature);
  const region = clusterName(g.chunkIdx);
  const cite = citeFor(g.file);

  return (
    <li>
      <button
        onMouseEnter={() => onFocus(g.ts)}
        onMouseLeave={() => onFocus(null)}
        onClick={() => onFocus(focused ? null : g.ts)}
        className={`w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
          focused ? "bg-white/10" : "hover:bg-white/5"
        }`}
      >
        <div className="flex items-baseline gap-2">
          <span className="w-6 shrink-0 text-right text-[10px] tabular-nums text-ink-3">
            {latest ? "›" : rank}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink">
            {g.text}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-ink-2">
            {g.temperature.toFixed(1)}°
          </span>
          <span className="w-4 shrink-0 text-center text-[11px]" aria-hidden>
            {band.emoji}
          </span>
        </div>
        <div className="mt-1 ml-8 flex items-center gap-2">
          <div className="h-1 min-w-0 flex-1 rounded-full bg-white/5">
            <div
              className="h-1 rounded-full"
              style={{
                width: `${Math.max(g.temperature, 1.5)}%`,
                background: tempCSS(g.temperature),
              }}
            />
          </div>
          <span className="w-16 shrink-0 text-[10px] text-ink-3">{band.label}</span>
        </div>
        <p className="mt-0.5 ml-8 truncate text-[10px] text-ink-3">
          {g.chunkIdx === null
            ? "landed off the map"
            : `landed in ${region ?? "uncharted terrain"}${cite ? ` · nearest ${cite}` : ""}`}
        </p>
      </button>
    </li>
  );
}
