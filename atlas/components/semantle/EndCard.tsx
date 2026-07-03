"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Paper } from "@/lib/types";
import type { DayState, Stats } from "./game";
import {
  bestTemperature,
  buildShareText,
  copyToClipboard,
  puzzleNo,
} from "./game";

const GOLD = "#c98500";
const GOLD_HOT = "#ffd27a";

/**
 * The post-game reveal: full citation + abstract of the hidden paper, personal
 * record, and the copyable result grid for the lab thread (the leaderboard
 * lives wherever the lab argues — nothing here leaks tomorrow's answer).
 */
export default function EndCard({
  state,
  paper,
  stats,
}: {
  state: DayState;
  paper: Paper | null;
  stats: Stats;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const won = state.status === "won";
  const ended = state.status !== "playing";

  const share = async () => {
    const ok = await copyToClipboard(buildShareText(state));
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <AnimatePresence>
        {ended && !dismissed && (
          <motion.aside
            key={state.targetFile ?? "end"}
            initial={{ opacity: 0, x: 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 36 }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
            className="hud-panel hud-scroll pointer-events-auto absolute top-24 right-5 z-40 max-h-[76vh] w-[400px] max-w-[calc(100vw-2.5rem)] overflow-y-auto p-6"
          >
            <div className="flex items-center justify-between">
              <span
                className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium tracking-[0.25em] uppercase"
                style={
                  won
                    ? { borderColor: GOLD, color: GOLD_HOT }
                    : { borderColor: "var(--baseline)", color: "var(--text-secondary)" }
                }
              >
                {won
                  ? `Found · puzzle #${puzzleNo(state.day)}`
                  : `Revealed · puzzle #${puzzleNo(state.day)}`}
              </span>
              <button
                onClick={() => setDismissed(true)}
                className="text-ink-3 transition-colors hover:text-ink"
                aria-label="Close results"
              >
                ✕
              </button>
            </div>

            {paper ? (
              <>
                <h2 className="font-display mt-4 text-2xl leading-tight edr-glow">
                  {paper.title}
                </h2>
                <p className="mt-2 text-sm text-ink-2">
                  {paper.authors} ({paper.year})
                  {paper.journal && (
                    <>
                      {" · "}
                      <em>{paper.journal}</em>
                    </>
                  )}
                </p>
                {paper.doi && (
                  <a
                    href={`https://doi.org/${paper.doi}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-xs text-accent transition-opacity hover:opacity-80"
                  >
                    doi:{paper.doi}
                  </a>
                )}
                {paper.abstract && (
                  <p className="mt-4 text-sm leading-relaxed text-ink-2">
                    {paper.abstract}
                  </p>
                )}
              </>
            ) : (
              <h2 className="font-display mt-4 text-2xl leading-tight">
                {state.targetFile}
              </h2>
            )}

            <div className="mt-4 border-t border-hairline pt-4">
              <p className="text-sm text-ink-2">
                {won
                  ? `Identified in ${state.guesses.length} guess${state.guesses.length === 1 ? "" : "es"}`
                  : `Gave up after ${state.guesses.length} guess${state.guesses.length === 1 ? "" : "es"}`}
                {state.idAttempts > 0 &&
                  ` · ${state.idAttempts} identification${state.idAttempts === 1 ? "" : "s"}`}
                {state.guesses.length > 0 &&
                  ` · best ${bestTemperature(state).toFixed(1)}°`}
              </p>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-2">
              {(
                [
                  [stats.played, "played"],
                  [
                    stats.played ? Math.round((100 * stats.won) / stats.played) + "%" : "—",
                    "won",
                  ],
                  [stats.streak, "streak"],
                  [stats.maxStreak, "max streak"],
                ] as [number | string, string][]
              ).map(([v, label]) => (
                <div
                  key={label}
                  className="rounded-lg border border-white/10 bg-black/25 px-2 py-2 text-center"
                >
                  <p className="font-display text-lg text-ink">{v}</p>
                  <p className="mt-0.5 text-[9px] tracking-wider text-ink-3 uppercase">
                    {label}
                  </p>
                </div>
              ))}
            </div>

            <button
              onClick={share}
              className="mt-4 w-full rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-white/5"
              style={{ borderColor: GOLD, color: copied ? GOLD_HOT : GOLD }}
            >
              {copied ? "copied — paste it in the lab thread ✓" : "copy result for the lab thread"}
            </button>

            <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
              The share grid shows only temperatures — never the paper. New
              puzzle at midnight UTC.
            </p>
          </motion.aside>
        )}
      </AnimatePresence>

      {ended && dismissed && (
        <button
          onClick={() => setDismissed(false)}
          className="hud-panel pointer-events-auto absolute right-5 bottom-5 z-40 px-3 py-1.5 text-xs text-ink-2 transition-colors hover:text-ink"
        >
          results ↗
        </button>
      )}
    </>
  );
}
