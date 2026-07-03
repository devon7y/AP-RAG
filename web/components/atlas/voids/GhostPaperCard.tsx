"use client";

import { AnimatePresence, motion } from "motion/react";
import type { VoidSite } from "@/lib/atlas/types";

/**
 * The dark-matter reveal: the hallucinated paper that would live in an empty
 * region. Clearly stamped as a ghost; grounded by the real neighbor titles that
 * bound the void.
 */
export default function GhostPaperCard({
  site,
  onClose,
}: {
  site: VoidSite | null;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {site && (
        <motion.aside
          key={site.ghost.title}
          initial={{ opacity: 0, x: 36 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 36 }}
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          className="hud-panel hud-scroll pointer-events-auto absolute top-24 right-5 z-40 max-h-[70vh] w-[380px] overflow-y-auto p-6"
        >
          <div className="flex items-center justify-between">
            <span
              className="rounded-full border px-2.5 py-0.5 text-[10px] font-medium tracking-[0.25em] uppercase"
              style={{ borderColor: "#9085e9", color: "#b9b0ff" }}
            >
              Ghost · hallucinated
            </span>
            <button
              onClick={onClose}
              className="text-ink-3 transition-colors hover:text-ink"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <h2 className="font-display mt-4 text-2xl leading-tight edr-glow">
            {site.ghost.title}
          </h2>

          <p className="mt-2 text-xs tracking-wide text-ink-3 uppercase">
            {site.ghost.fields}
          </p>

          <p className="mt-4 text-sm leading-relaxed text-ink-2">
            {site.ghost.abstract}
          </p>

          <div className="mt-4 border-t pt-4 hairline">
            <p className="text-[11px] tracking-widest text-ink-3 uppercase">
              Plausible methods
            </p>
            <p className="mt-1 text-sm text-ink-2">{site.ghost.methods}</p>
          </div>

          <div className="mt-4 border-t pt-4 hairline">
            <p className="text-[11px] tracking-widest text-ink-3 uppercase">
              Bordering literature ({site.neighbors.length})
            </p>
            <ul className="mt-2 space-y-1.5">
              {site.neighbors.map((t) => (
                <li key={t} className="text-xs leading-snug text-ink-2">
                  <span className="text-ink-3">·</span> {t}
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-5 text-[11px] leading-relaxed text-ink-3">
            No paper occupies this pocket of the embedding space. This is the
            paper that <em>would</em> — generated from the gap between its
            neighbors, not retrieved. Treat it as a prompt, not a citation.
          </p>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
