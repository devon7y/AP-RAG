"use client";

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { type AuthorSpirit, SUMMON_MIN_CHUNKS } from "./authors";
import { SEANCE_UI } from "./theme";

/**
 * The summoning table: choose whom to reach. Spirits are ranked by how much of
 * them survives in the corpus (indexed chunks); below the threshold they are
 * listed but too faint to summon.
 */
export default function AuthorPicker({
  spirits,
  onSummon,
}: {
  spirits: AuthorSpirit[];
  onSummon: (s: AuthorSpirit) => void;
}) {
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? spirits.filter((s) => s.name.toLowerCase().includes(q)) : spirits;
  }, [spirits, query]);

  const reachable = useMemo(
    () => spirits.filter((s) => s.nChunks >= SUMMON_MIN_CHUNKS).length,
    [spirits],
  );

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 28 }}
        className="hud-panel pointer-events-auto flex max-h-[76vh] w-[520px] max-w-[94vw] flex-col p-6"
      >
        <p className="text-[11px] tracking-[0.3em] uppercase" style={{ color: SEANCE_UI }}>
          the table is set
        </p>
        <h2 className="font-display edr-glow mt-2 text-3xl">Who do you wish to reach?</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          {reachable} first authors answer the call. Each speaks only from their own
          indexed passages — every claim cited, and silence where the record is silent.
        </p>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search a name…"
          autoFocus
          className="mt-4 w-full rounded-lg border border-hairline bg-page/60 px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-[color:var(--atlas-accent)]"
        />

        <ul className="hud-scroll mt-3 flex-1 space-y-1 overflow-y-auto pr-1">
          {shown.map((s) => {
            const faint = s.nChunks < SUMMON_MIN_CHUNKS;
            const years =
              s.yearMin > 0
                ? s.yearMin === s.yearMax
                  ? ` · ${s.yearMin}`
                  : ` · ${s.yearMin}–${s.yearMax}`
                : "";
            return (
              <li key={s.name}>
                <button
                  disabled={faint}
                  onClick={() => onSummon(s)}
                  className={
                    "group flex w-full items-baseline justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors " +
                    (faint ? "cursor-not-allowed opacity-40" : "hover:bg-white/5")
                  }
                >
                  <span className="font-display text-lg text-ink group-hover:edr-glow">
                    {s.name}
                  </span>
                  <span className="shrink-0 text-xs text-ink-3">
                    {faint
                      ? "too faint to reach"
                      : `${s.nPapers} paper${s.nPapers === 1 ? "" : "s"} · ${s.nChunks} passages${years}`}
                  </span>
                </button>
              </li>
            );
          })}
          {shown.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-ink-3">
              no spirit by that name in this corpus
            </li>
          )}
        </ul>

        <p className="mt-4 border-t border-hairline pt-3 text-[11px] leading-relaxed text-ink-3">
          Grounding, not mimicry: retrieval is scoped to papers where this family name
          is an author. If nothing they wrote covers your question, they will tell you
          they never wrote about it.
        </p>
      </motion.div>
    </div>
  );
}
