"use client";

import { AnimatePresence, motion } from "motion/react";
import { useObservatory } from "./store";

/** Screen-space warp streaks while the drive is engaged (pure CSS, no GPU cost). */
export default function WarpOverlay() {
  const warping = useObservatory((s) => s.warping);
  return (
    <AnimatePresence>
      {warping && (
        <motion.div
          className="pointer-events-none absolute inset-0 z-30"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
        >
          {/* radiating speed lines */}
          <motion.div
            className="absolute inset-[-30%]"
            style={{
              background:
                "repeating-conic-gradient(from 0deg, rgba(158,197,244,0.14) 0deg 0.6deg, transparent 0.6deg 4.1deg)",
              maskImage: "radial-gradient(circle at 50% 50%, transparent 18%, black 62%)",
              WebkitMaskImage: "radial-gradient(circle at 50% 50%, transparent 18%, black 62%)",
            }}
            animate={{ scale: [1, 1.5], opacity: [0.35, 0.85, 0.55] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
          />
          {/* blue-shift vignette */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, transparent 42%, rgba(57,135,229,0.16) 100%)",
            }}
          />
          <p className="absolute bottom-24 left-1/2 -translate-x-1/2 text-[11px] tracking-[0.4em] text-ink-2 uppercase pulse-soft">
            warp drive engaged
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
