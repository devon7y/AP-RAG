"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { STATUS } from "@/lib/atlas/palette";
import type { Floor } from "./types";
import type { GameState } from "./state";
import { exploredCount } from "./state";

/** Direct-labeled meter (dataviz rules: one hue, label carries the value). */
export function Meter({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const frac = Math.max(0, Math.min(1, value / max));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[11px] tracking-widest text-ink-3 uppercase">{label}</span>
        <span className="text-xs tabular-nums text-ink-2">
          {Math.round(value)} / {max}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "#2c2c2a" }}>
        <motion.div
          className="h-full rounded-full"
          animate={{ width: `${frac * 100}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
          style={{ background: color }}
        />
      </div>
    </div>
  );
}

export function hpColor(frac: number): string {
  if (frac > 0.6) return STATUS.good;
  if (frac > 0.35) return STATUS.warning;
  if (frac > 0.15) return STATUS.serious;
  return STATUS.critical;
}

/** Top-right run stats: credibility, insight, floor progress, boss seal. */
export function RunStats({
  state,
  floor,
  nFloors,
}: {
  state: GameState;
  floor: Floor;
  nFloors: number;
}) {
  const explored = exploredCount(state, floor);
  const nRooms = floor.rooms.filter((r) => !r.isBoss && !r.isEntrance).length;
  return (
    <div className="hud-panel pointer-events-none absolute top-5 right-5 z-40 w-64 space-y-3 p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] tracking-widest text-ink-3 uppercase">
          Floor {state.floorIdx + 1} / {nFloors}
        </span>
        <span className="text-[11px] text-ink-3">
          ◆ Insight ×{state.insight}
        </span>
      </div>
      <Meter label="Credibility" value={state.hp} max={100} color={hpColor(state.hp / 100)} />
      <div className="flex items-baseline justify-between text-[11px] text-ink-3">
        <span>Chambers charted</span>
        <span className="tabular-nums">
          {explored} / {nRooms}
        </span>
      </div>
      <p className="text-[11px] leading-snug text-ink-3">
        {explored >= floor.roomsToUnseal
          ? "The boss gate stands open."
          : `Chart ${floor.roomsToUnseal - explored} more to unseal the boss gate.`}
      </p>
    </div>
  );
}

/** Transient banner (insight pickups, sealed-door bumps, floor heals). */
export function NoticeToast({ notice, onDismiss }: { notice: string | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDismiss, 4500);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);
  return (
    <AnimatePresence>
      {notice && (
        <motion.button
          key={notice}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          onClick={onDismiss}
          className="hud-panel pointer-events-auto absolute bottom-16 left-1/2 z-40 max-w-md -translate-x-1/2 px-4 py-2.5 text-sm text-ink-2"
        >
          {notice}
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/** Full-screen end states + floor-cleared interstitial. */
export function RunOverlay({
  state,
  floor,
  nFloors,
  onDescend,
  onNewRun,
}: {
  state: GameState;
  floor: Floor;
  nFloors: number;
  onDescend: () => void;
  onNewRun: () => void;
}) {
  if (state.phase !== "floor-cleared" && state.phase !== "victory" && state.phase !== "defeat") {
    return null;
  }
  const lastFloor = state.floorIdx === nFloors - 1;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div className="hud-panel w-[440px] max-w-[92vw] p-8 text-center">
        {state.phase === "floor-cleared" && (
          <>
            <p className="text-[11px] tracking-[0.3em] text-ink-3 uppercase">Boss defeated</p>
            <h2 className="font-display edr-glow mt-3 text-3xl leading-tight">{floor.bossId}</h2>
            <p className="mt-4 text-sm leading-relaxed text-ink-2">
              The panel concedes — your claims held against the literature
              {state.rounds.length > 0 &&
                ` across ${state.rounds.length} round${state.rounds.length === 1 ? "" : "s"}`}
              .
            </p>
            <button
              onClick={onDescend}
              className="mt-6 rounded-lg border px-5 py-2 text-sm transition-colors hover:bg-white/5"
              style={{ borderColor: "#d95926", color: "#ffb38a" }}
            >
              {lastFloor ? "Claim the corpus" : "Descend to the next floor ↓"}
            </button>
          </>
        )}
        {state.phase === "victory" && (
          <>
            <p className="text-[11px] tracking-[0.3em] uppercase" style={{ color: "#ffb38a" }}>
              Run complete
            </p>
            <h2 className="font-display edr-glow mt-3 text-3xl">The literature yields.</h2>
            <p className="mt-4 text-sm leading-relaxed text-ink-2">
              Every boss on {nFloors} floors fell to evidence-backed argument. Credibility
              remaining: {state.hp}/100. This is what a comprehensive exam feels like when you win.
            </p>
            <button
              onClick={onNewRun}
              className="mt-6 rounded-lg border border-hairline px-5 py-2 text-sm text-ink-2 transition-colors hover:text-ink"
            >
              New run (new dungeon)
            </button>
          </>
        )}
        {state.phase === "defeat" && (
          <>
            <p className="text-[11px] tracking-[0.3em] text-ink-3 uppercase">Credibility exhausted</p>
            <h2 className="font-display mt-3 text-3xl">Revise &amp; resubmit.</h2>
            <p className="mt-4 text-sm leading-relaxed text-ink-2">
              {floor.bossId} stands. The literature did not back your claims — read the rulings,
              mine the corridors for lore, and argue sharper next run.
            </p>
            <button
              onClick={onNewRun}
              className="mt-6 rounded-lg border border-hairline px-5 py-2 text-sm text-ink-2 transition-colors hover:text-ink"
            >
              New run
            </button>
          </>
        )}
      </div>
    </motion.div>
  );
}
