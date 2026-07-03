"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRadioStore } from "./radioStore";

/**
 * The passage as lyrics: previous line fading above, the line being read large
 * in the middle, the next line waiting below. Sentence index drives everything —
 * TTS mode advances on utterance end, silent mode on reading-pace timers.
 */
export default function LyricsPanel() {
  const powered = useRadioStore((s) => s.powered);
  const status = useRadioStore((s) => s.status);
  const sentences = useRadioStore((s) => s.sentences);
  const active = useRadioStore((s) => s.active);

  if (!powered) return null;

  const loading = status === "loading";
  const prev = !loading && active > 0 ? sentences[active - 1] : null;
  const cur = !loading ? (sentences[active] ?? null) : null;
  const next = !loading ? (sentences[active + 1] ?? null) : null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-40 z-30 flex justify-center px-6">
      <div
        className="w-full max-w-3xl text-center"
        style={{ textShadow: "0 1px 18px rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.7)" }}
      >
        <div className="flex min-h-10 items-end justify-center">
          <AnimatePresence mode="wait">
            {prev && (
              <motion.p
                key={`prev-${active}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.55 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="mx-auto line-clamp-2 max-w-2xl text-sm leading-snug text-ink-3"
              >
                {prev}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-3 flex min-h-24 items-center justify-center">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.p
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="pulse-soft font-display text-xl text-ink-3"
              >
                drifting…
              </motion.p>
            ) : (
              cur && (
                <motion.p
                  key={`cur-${active}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                  className="font-display text-2xl leading-snug text-ink sm:text-[1.65rem]"
                >
                  {cur}
                </motion.p>
              )
            )}
          </AnimatePresence>
        </div>

        <div className="mt-3 flex min-h-10 items-start justify-center">
          <AnimatePresence mode="wait">
            {next && (
              <motion.p
                key={`next-${active}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.4 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="mx-auto line-clamp-2 max-w-2xl text-sm leading-snug text-ink-3"
              >
                {next}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
