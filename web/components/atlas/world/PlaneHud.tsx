"use client";

import { useEffect, useRef } from "react";
import { planeTelemetry } from "./PlaneLayer";

/**
 * The 747's glass cockpit — styled after Microsoft Flight Simulator's
 * instrument overlays, deliberately NOT the atlas's hud-panel language:
 * near-black bordered boxes, white mono digits, cyan/magenta/green avionics
 * accents. Moving airspeed + altitude tapes, VSI, compass rose, engine N1
 * dial, and an artificial horizon with a pitch ladder. Everything updates
 * from an rAF loop reading planeTelemetry — zero React re-renders in flight.
 */

const PANEL =
  "rounded-[3px] border border-white/25 bg-[#0a0d11]/85 shadow-[0_1px_10px_rgba(0,0,0,0.55)]";
const LABEL =
  "text-[8px] font-semibold tracking-[0.16em] text-[#ccd2d9] uppercase";
const CYAN = "#29d3fe";
const MAGENTA = "#ff4df0";
const GREEN = "#35c94b";

/* ---- tape geometry ---- */
const TAPE_H = 176; // px window
const SPD_MAX = 700;
const SPD_PX = 2.2; // px per kt
const ALT_MAX = 7000;
const ALT_PX = 0.22; // px per ft

const SPD_TICKS: number[] = [];
for (let v = 0; v <= SPD_MAX; v += 10) SPD_TICKS.push(v);
const ALT_TICKS: number[] = [];
for (let v = 0; v <= ALT_MAX; v += 100) ALT_TICKS.push(v);

const ROSE: { deg: number; label: string | null }[] = [];
for (let d = 0; d < 360; d += 10) {
  ROSE.push({
    deg: d,
    label:
      d % 90 === 0 ? "NESW"[d / 90] : d % 30 === 0 ? String(d / 10) : null,
  });
}

const COMPASS16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export default function PlaneHud() {
  const spdInner = useRef<HTMLDivElement>(null);
  const spdVal = useRef<HTMLSpanElement>(null);
  const tasVal = useRef<HTMLSpanElement>(null);
  const altInner = useRef<HTMLDivElement>(null);
  const altVal = useRef<HTMLSpanElement>(null);
  const vsMark = useRef<HTMLDivElement>(null);
  const vsVal = useRef<HTMLSpanElement>(null);
  const aglVal = useRef<HTMLSpanElement>(null);
  const rose = useRef<HTMLDivElement>(null);
  const hdgVal = useRef<HTMLSpanElement>(null);
  const hdgCard = useRef<HTMLSpanElement>(null);
  const needle = useRef<SVGLineElement>(null);
  const n1Val = useRef<HTMLSpanElement>(null);
  const horizon = useRef<HTMLDivElement>(null);
  const warn = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = planeTelemetry;
      if (!t.active) return;

      const kts = Math.round(t.kts);
      if (spdInner.current)
        spdInner.current.style.transform = `translateY(${(
          TAPE_H / 2 - (SPD_MAX - t.kts) * SPD_PX
        ).toFixed(1)}px)`;
      if (spdVal.current) spdVal.current.textContent = String(kts);
      if (tasVal.current) tasVal.current.textContent = String(Math.round(t.kts * 1.08));

      if (altInner.current)
        altInner.current.style.transform = `translateY(${(
          TAPE_H / 2 - (ALT_MAX - t.altFt) * ALT_PX
        ).toFixed(1)}px)`;
      if (altVal.current)
        altVal.current.textContent = Math.round(t.altFt).toLocaleString();

      const vs = Math.max(-3000, Math.min(3000, t.vsFpm));
      if (vsMark.current)
        vsMark.current.style.transform = `translateY(${(-vs / 3000) * 74}px)`;
      if (vsVal.current) {
        const v = Math.round(t.vsFpm / 50) * 50;
        vsVal.current.textContent = `${v > 0 ? "+" : ""}${v.toLocaleString()}`;
      }
      if (aglVal.current)
        aglVal.current.textContent = Math.round(t.aglFt).toLocaleString();

      if (rose.current)
        rose.current.style.transform = `rotate(${(-t.heading).toFixed(1)}deg)`;
      if (hdgVal.current)
        hdgVal.current.textContent = String(Math.round(t.heading) % 360).padStart(3, "0");
      if (hdgCard.current)
        hdgCard.current.textContent = COMPASS16[Math.round(t.heading / 22.5) % 16];

      if (needle.current)
        needle.current.style.transform = `rotate(${135 + t.throttle * 270}deg)`;
      if (n1Val.current)
        n1Val.current.textContent = String(Math.round(20 + 80 * t.throttle));

      if (horizon.current)
        horizon.current.style.transform = `rotate(${t.rollDeg.toFixed(1)}deg) translateY(${(
          t.pitchDeg * 2
        ).toFixed(1)}px)`;

      if (warn.current) {
        // GPWS banner: hard red flash while below the terrain floor
        warn.current.style.visibility = t.warning ? "visible" : "hidden";
        warn.current.style.opacity = t.warning
          ? Math.floor(performance.now() / 280) % 2 === 0
            ? "1"
            : "0.3"
          : "0";
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 z-40 font-sans">
      {/* ---- GPWS terrain warning (top-center) ---- */}
      <div
        ref={warn}
        className="absolute top-6 left-1/2 -translate-x-1/2 rounded-[3px] border-2 px-5 py-1.5 font-mono text-sm font-bold tracking-[0.25em]"
        style={{
          visibility: "hidden",
          borderColor: "#ff2a2a",
          background: "rgba(46,2,2,0.88)",
          color: "#ff3b30",
          textShadow: "0 0 12px rgba(255,42,42,0.8)",
          boxShadow: "0 0 18px rgba(255,42,42,0.35)",
        }}
      >
        ⚠ TERRAIN · PULL UP
      </div>

      {/* ---- compass rose (top-left) ---- */}
      <div className="absolute top-20 left-5">
        <div className={`${PANEL} relative h-32 w-32 rounded-full`}>
          <div ref={rose} className="absolute inset-1">
            {ROSE.map(({ deg, label }) => (
              <div
                key={deg}
                className="absolute inset-0"
                style={{ transform: `rotate(${deg}deg)` }}
              >
                <div
                  className="absolute top-0 left-1/2 w-px -translate-x-1/2 bg-white/80"
                  style={{ height: deg % 30 === 0 ? 8 : 4 }}
                />
                {label && (
                  <span
                    className="absolute top-2 left-1/2 -translate-x-1/2 font-mono text-[10px] font-bold text-white"
                    style={deg % 90 === 0 ? {} : { color: "#b7bec7", fontSize: 9 }}
                  >
                    {label}
                  </span>
                )}
              </div>
            ))}
          </div>
          {/* lubber line */}
          <div
            className="absolute -top-0.5 left-1/2 -translate-x-1/2"
            style={{
              width: 0,
              height: 0,
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderTop: `7px solid ${MAGENTA}`,
            }}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-lg font-bold text-white tabular-nums">
              <span ref={hdgVal}>000</span>°
            </span>
            <span className="font-mono text-[10px]" style={{ color: CYAN }}>
              <span ref={hdgCard}>N</span>
            </span>
          </div>
        </div>
        <p className={`${LABEL} mt-1 text-center`}>heading</p>
      </div>

      {/* ---- airspeed tape + engine (bottom-left) ---- */}
      <div className="absolute bottom-5 left-5 flex items-end gap-1.5">
        <div className={`${PANEL} w-[74px] overflow-hidden`}>
          <p className={`${LABEL} border-b border-white/15 px-2 py-1`}>
            airspeed
          </p>
          <div className="relative overflow-hidden" style={{ height: TAPE_H }}>
            <div ref={spdInner} className="absolute inset-x-0">
              {SPD_TICKS.map((v) => (
                <div
                  key={v}
                  className="absolute right-0 flex items-center gap-1"
                  style={{ top: (SPD_MAX - v) * SPD_PX - 5 }}
                >
                  {v % 20 === 0 && (
                    <span className="font-mono text-[10px] text-[#c6ccd4] tabular-nums">
                      {v}
                    </span>
                  )}
                  <div
                    className="h-px bg-white/60"
                    style={{ width: v % 20 === 0 ? 8 : 5 }}
                  />
                </div>
              ))}
            </div>
            {/* current-speed window */}
            <div
              className="absolute right-0 left-0 flex items-center justify-center border-y bg-black/90 py-0.5"
              style={{ top: TAPE_H / 2 - 12, borderColor: "rgba(255,255,255,0.4)" }}
            >
              <span
                ref={spdVal}
                className="font-mono text-lg font-bold text-white tabular-nums"
              >
                0
              </span>
            </div>
          </div>
          <p className="border-t border-white/15 px-2 py-1 font-mono text-[9px] text-[#c6ccd4]">
            TAS <span ref={tasVal} className="text-white">0</span> KT
          </p>
        </div>

        {/* engine N1 dial — fixed width so digit count never reflows it */}
        <div className={`${PANEL} w-[100px] px-2 pt-1 pb-1.5 text-center`}>
          <p className={LABEL}>engine n1</p>
          <svg width="84" height="72" viewBox="0 0 84 72" className="mt-0.5">
            <g transform="translate(0,-6)">
              <circle
                cx="42" cy="42" r="30" fill="none"
                stroke="rgba(255,255,255,0.22)" strokeWidth="4"
                strokeDasharray="141.4 188.5"
                transform="rotate(135 42 42)"
              />
              <circle
                cx="42" cy="42" r="30" fill="none"
                stroke={GREEN} strokeWidth="4"
                strokeDasharray="63.6 188.5"
                transform="rotate(243 42 42)"
              />
              <line
                ref={needle}
                x1="42" y1="42" x2="66" y2="42"
                stroke="#ffffff" strokeWidth="2.5"
                style={{ transformOrigin: "42px 42px", transform: "rotate(135deg)" }}
              />
              <circle cx="42" cy="42" r="4" fill="#dfe3e8" />
            </g>
          </svg>
          <p className="text-center font-mono text-[11px] text-white tabular-nums">
            <span ref={n1Val} className="inline-block w-7 text-right">55</span>
            <span className="text-[9px] text-[#c6ccd4]"> %</span>
          </p>
        </div>
      </div>

      {/* ---- attitude indicator + hint (bottom-center) ---- */}
      <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5">
        <div className={`${PANEL} relative h-28 w-40 overflow-hidden`}>
          <div
            ref={horizon}
            className="absolute -inset-x-16 -inset-y-20"
            style={{
              background:
                "linear-gradient(rgb(18,98,175) 0%, rgb(41,131,213) 50%, rgb(146,90,42) 50%, rgb(110,68,32) 100%)",
            }}
          >
            <div className="absolute top-1/2 right-0 left-0 h-[2px] -translate-y-1/2 bg-white" />
            {/* pitch ladder: ±10°, ±20° at 2 px/deg */}
            {[-20, -10, 10, 20].map((p) => (
              <div
                key={p}
                className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1"
                style={{ top: `calc(50% - ${p * 2}px)` }}
              >
                <span className="font-mono text-[8px] text-white/90">
                  {Math.abs(p)}
                </span>
                <div className="h-px w-10 -translate-y-px bg-white/85" />
                <span className="font-mono text-[8px] text-white/90">
                  {Math.abs(p)}
                </span>
              </div>
            ))}
          </div>
          {/* fixed yellow wings */}
          <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2.5">
            <div className="h-[3px] w-10 rounded-sm bg-[#ffd21e]" />
            <div className="h-2 w-2 rounded-sm border-2 border-[#ffd21e]" />
            <div className="h-[3px] w-10 rounded-sm bg-[#ffd21e]" />
          </div>
        </div>
        <p
          className={`${PANEL} px-2.5 py-1 font-mono text-[9px] tracking-wide text-[#c6ccd4]`}
        >
          W/S PITCH · A/D BANK · Q/E YAW · SPACE/SHIFT THR · ESC EJECT
        </p>
      </div>

      {/* ---- altitude tape + VS (bottom-right) ---- */}
      <div className="absolute right-5 bottom-5 flex items-end gap-1.5">
        <div className={`${PANEL} w-[84px] overflow-hidden`}>
          <p className={`${LABEL} border-b border-white/15 px-2 py-1`}>
            altitude
          </p>
          <div className="relative overflow-hidden" style={{ height: TAPE_H }}>
            <div ref={altInner} className="absolute inset-x-0">
              {ALT_TICKS.map((v) => (
                <div
                  key={v}
                  className="absolute left-0 flex items-center gap-1"
                  style={{ top: (ALT_MAX - v) * ALT_PX - 5 }}
                >
                  <div
                    className="h-px bg-white/60"
                    style={{ width: v % 500 === 0 ? 8 : 5 }}
                  />
                  {v % 500 === 0 && (
                    <span className="font-mono text-[10px] text-[#c6ccd4] tabular-nums">
                      {v.toLocaleString()}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div
              className="absolute right-0 left-0 flex items-center justify-center border-y bg-black/90 py-0.5"
              style={{ top: TAPE_H / 2 - 12, borderColor: "rgba(255,255,255,0.4)" }}
            >
              <span
                ref={altVal}
                className="font-mono text-lg font-bold text-white tabular-nums"
              >
                0
              </span>
            </div>
          </div>
          <p className="border-t border-white/15 px-2 py-1 font-mono text-[9px] text-[#c6ccd4]">
            AGL <span ref={aglVal} className="text-white">0</span> FT
          </p>
        </div>

        {/* vertical speed — fixed width so the fpm digits never reflow it */}
        <div className={`${PANEL} flex w-[56px] flex-col items-center px-1.5 pt-1 pb-1.5`}>
          <p className={LABEL}>vs</p>
          <div className="relative my-1 h-40 w-4">
            <div className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-white/25" />
            <div className="absolute top-1/2 right-0 left-0 h-px bg-white/50" />
            <div
              ref={vsMark}
              className="absolute top-1/2 left-1/2 h-[3px] w-4 -translate-x-1/2 -translate-y-1/2 rounded-sm"
              style={{ background: MAGENTA }}
            />
          </div>
          <p className="font-mono text-[9px] text-white tabular-nums">
            <span ref={vsVal}>0</span>
          </p>
          <p className="text-[8px] text-[#c6ccd4]">FPM</p>
        </div>
      </div>
    </div>
  );
}
