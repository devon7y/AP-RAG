"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Paper } from "@/lib/types";
import type { DayState, SemantleMeta, Stats } from "./game";
import { puzzleNo, shortCite } from "./game";

const ACCENT = "#c98500";

/**
 * The play console: free-text guesses, the "I know the paper" identifier over
 * the guessable pool, and the give-up path. One action in flight at a time.
 */
export default function GuessConsole({
  meta,
  state,
  stats,
  busy,
  error,
  staleDay,
  pool,
  onGuess,
  onIdentify,
  onReveal,
}: {
  meta: SemantleMeta;
  state: DayState;
  stats: Stats;
  busy: boolean;
  error: string | null;
  staleDay: boolean;
  pool: Paper[];
  onGuess: (text: string) => void;
  onIdentify: (file: string) => void;
  onReveal: () => void;
}) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmReveal, setConfirmReveal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const playing = state.status === "playing" && !staleDay;

  // arm/disarm the give-up confirmation
  useEffect(() => {
    if (!confirmReveal) return;
    const id = setTimeout(() => setConfirmReveal(false), 4000);
    return () => clearTimeout(id);
  }, [confirmReveal]);

  const eliminated = useMemo(() => new Set(state.eliminated), [state.eliminated]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/);
    return pool
      .filter((p) => {
        const hay = `${p.title} ${p.authors} ${p.year}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      })
      .slice(0, 8);
  }, [pool, query]);

  const submit = () => {
    const t = text.trim();
    if (!t || !playing || busy) return;
    onGuess(t);
    setText("");
    inputRef.current?.focus();
  };

  return (
    <div className="hud-panel pointer-events-auto shrink-0 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-xl">
          Puzzle&nbsp;#{puzzleNo(state.day)}
        </h2>
        <p className="text-[11px] text-ink-3">
          one of {meta.nGuessable} papers
          {stats.streak > 0 && <> · streak {stats.streak}</>}
        </p>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-ink-3">
        A paper is hiding in the fog. Guess what it&rsquo;s <em>about</em> — each
        guess is embedded and scored against the real thing.
      </p>

      {staleDay ? (
        <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3">
          <p className="text-sm text-ink-2">
            Midnight (UTC) passed — a new paper is hiding.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-2 w-full rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-white/5"
            style={{ borderColor: ACCENT, color: ACCENT }}
          >
            load today&rsquo;s puzzle
          </button>
        </div>
      ) : (
        state.status === "playing" && (
          <>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={300}
                placeholder="humor comprehension in aphasia…"
                aria-label="Your guess"
                autoFocus
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-ink placeholder:text-ink-3/60 outline-none transition-colors focus:border-white/25"
              />
              <button
                type="submit"
                disabled={busy || !text.trim()}
                className="shrink-0 rounded-lg border px-3.5 py-2 text-sm transition-colors hover:bg-white/5 disabled:cursor-default disabled:opacity-40"
                style={{ borderColor: ACCENT, color: ACCENT }}
              >
                {busy ? "…" : "guess"}
              </button>
            </form>

            {/* Identify: the win condition */}
            <div className="mt-3 border-t border-hairline pt-3">
              <button
                onClick={() => setPickerOpen((v) => !v)}
                className="text-xs text-ink-2 transition-colors hover:text-ink"
              >
                {pickerOpen ? "▾" : "▸"} I think I know the paper
                {state.idAttempts > 0 && (
                  <span className="text-ink-3"> · {state.idAttempts} tried</span>
                )}
              </button>

              {pickerOpen && (
                <div className="mt-2">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="search title / author / year"
                    aria-label="Search papers to identify"
                    spellCheck={false}
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-ink placeholder:text-ink-3/60 outline-none focus:border-white/25"
                  />
                  {query.trim() && (
                    <ul className="hud-scroll mt-1.5 max-h-44 space-y-0.5 overflow-y-auto">
                      {matches.length === 0 && (
                        <li className="px-1 py-1 text-xs text-ink-3">
                          no paper in the pool matches
                        </li>
                      )}
                      {matches.map((p) => {
                        const dead = eliminated.has(p.file);
                        return (
                          <li key={p.file}>
                            <button
                              disabled={dead || busy}
                              onClick={() => onIdentify(p.file)}
                              className={`w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                                dead
                                  ? "cursor-default text-ink-3/50 line-through"
                                  : "text-ink-2 hover:bg-white/5 hover:text-ink"
                              }`}
                            >
                              <span className="block truncate">
                                {dead && "✗ "}
                                {p.title}
                              </span>
                              <span className="text-ink-3">
                                {shortCite(p)} · {p.journal || "—"}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <p className="mt-1.5 text-[10px] leading-snug text-ink-3">
                    Naming the exact paper is how you win — wrong picks get
                    struck out.
                  </p>
                </div>
              )}
            </div>

            <div className="mt-2 flex justify-end">
              <button
                onClick={() => {
                  if (confirmReveal) {
                    setConfirmReveal(false);
                    onReveal();
                  } else setConfirmReveal(true);
                }}
                disabled={busy}
                className="text-[11px] transition-colors disabled:opacity-40"
                style={{ color: confirmReveal ? "#e66767" : "var(--text-muted)" }}
              >
                {confirmReveal ? "really reveal? (ends the streak)" : "give up · reveal"}
              </button>
            </div>
          </>
        )
      )}

      {state.status !== "playing" && !staleDay && (
        <p className="mt-3 text-xs leading-relaxed text-ink-2">
          {state.status === "won" ? "Found it. " : "Revealed. "}
          The fog has lifted — the gold beacon marks where the paper lives.
          Come back after UTC midnight for the next one.
        </p>
      )}

      {error && (
        <p className="mt-2 text-xs leading-snug" style={{ color: "#e66767" }}>
          {error}
        </p>
      )}
    </div>
  );
}
