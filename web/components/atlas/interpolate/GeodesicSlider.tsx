"use client";

import { COOL, STEPS, WARM } from "./engine";

/** The instrument itself: scrub t between A and B; ticks jump to waypoints. */
export default function GeodesicSlider({
  t,
  onT,
  stepIdx,
  aLabel,
  bLabel,
  angleDeg,
}: {
  t: number;
  onT: (v: number) => void;
  stepIdx: number;
  aLabel: string;
  bLabel: string;
  angleDeg: number;
}) {
  return (
    <div className="hud-panel pointer-events-auto absolute bottom-9 left-1/2 z-40 w-[min(720px,76vw)] -translate-x-1/2 px-5 pt-3 pb-2.5">
      <div className="flex items-center gap-3">
        <span className="max-w-[10rem] truncate text-xs" style={{ color: COOL }} title={aLabel}>
          {aLabel}
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.002}
          value={t}
          onChange={(e) => onT(parseFloat(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              const d = e.key === "ArrowLeft" ? -1 : 1;
              const next = (Math.round(t * (STEPS - 1)) + d) / (STEPS - 1);
              onT(Math.min(1, Math.max(0, next)));
            }
          }}
          className="igeo-range flex-1"
          aria-label="interpolation position between A and B"
          style={{ background: `linear-gradient(90deg, ${COOL}, ${WARM})` }}
        />
        <span
          className="max-w-[10rem] truncate text-right text-xs"
          style={{ color: WARM }}
          title={bLabel}
        >
          {bLabel}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-ink-3 tabular-nums">
          t = {t.toFixed(2)} · {Math.round(t * 100)}% toward B
        </span>
        <div className="flex items-center gap-1.5">
          {Array.from({ length: STEPS }, (_, i) => (
            <button
              key={i}
              onClick={() => onT(i / (STEPS - 1))}
              aria-label={`waypoint ${i + 1}`}
              className="h-2 w-2 rounded-full transition-transform hover:scale-125"
              style={{
                background: `color-mix(in srgb, ${WARM} ${(i / (STEPS - 1)) * 100}%, ${COOL})`,
                opacity: i === stepIdx ? 1 : 0.35,
                transform: i === stepIdx ? "scale(1.35)" : undefined,
              }}
            />
          ))}
        </div>
        <span className="text-[11px] text-ink-3 tabular-nums">Δ {angleDeg.toFixed(1)}° apart</span>
      </div>

      <style>{`
        .igeo-range { -webkit-appearance: none; appearance: none; height: 4px; border-radius: 999px; outline: none; }
        .igeo-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 999px; background: #fff; border: 2px solid #0d0d0d; box-shadow: 0 0 12px rgba(255,255,255,0.8); cursor: ew-resize; }
        .igeo-range::-moz-range-thumb { width: 16px; height: 16px; border-radius: 999px; background: #fff; border: 2px solid #0d0d0d; box-shadow: 0 0 12px rgba(255,255,255,0.8); cursor: ew-resize; }
      `}</style>
    </div>
  );
}
