"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { entityWorldPos } from "./SkyLayer";
import type { WorldData } from "./derive";
import { useWorld } from "./store";
import { uMorph } from "./uniforms";

/**
 * DOM labels over the world (drei Html — WGSL-safe, per the atlas conventions).
 * Region names always ride their cluster; the top knowledge-graph entities get
 * small typed chips. Both fade by camera distance and hide while warping.
 * Total label count stays well under the ~60 budget.
 */

/**
 * One screen-space occupancy list per frame, shared by every label family.
 *
 * Region labels used to skip collision entirely while peak labels tested only
 * against each other, using an estimated rect that badly under-measured the
 * rendered text — which is why the middle of the map turned into a pile of
 * overlapping words. Now everything competes in one list, measured from the
 * real DOM box, and the winner is whoever reserves first: regions (largest
 * first), then summits by prominence.
 */
export interface LabelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const occupancy: { frame: number; rects: LabelRect[] } = { frame: -1, rects: [] };

export function beginLabelFrame(frame: number): void {
  if (occupancy.frame !== frame) {
    occupancy.frame = frame;
    occupancy.rects = [];
  }
}

/** True when the box is clear; reserves it when so. */
export function reserveLabel(el: HTMLElement, x: number, y: number): boolean {
  const w = (el.offsetWidth || 60) + 8;
  const h = (el.offsetHeight || 14) + 4;
  const clash = occupancy.rects.some(
    (r) => Math.abs(r.x - x) * 2 < r.w + w && Math.abs(r.y - y) * 2 < r.h + h,
  );
  if (clash) return false;
  occupancy.rects.push({ x, y, w, h });
  return true;
}

function FadingLabel({
  getPos,
  near,
  far,
  children,
  zRange = [20, 0],
  alpha,
}: {
  getPos: (out: THREE.Vector3) => void;
  near: number;
  far: number;
  children: React.ReactNode;
  zRange?: [number, number];
  /** extra opacity multiplier evaluated per frame (morph/time gating) */
  alpha?: () => number;
}) {
  const group = useRef<THREE.Group>(null);
  const div = useRef<HTMLDivElement>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera, size, clock }) => {
    const g = group.current;
    const d = div.current;
    if (!g || !d) return;
    getPos(tmp);
    g.position.copy(tmp);
    const st = useWorld.getState();
    const dist = camera.position.distanceTo(tmp);
    const t = THREE.MathUtils.clamp((far - dist) / (far - near), 0, 1);
    let o = st.warping || !st.showLabels ? 0 : Math.min(1, t * 1.6);
    if (alpha) o *= alpha();
    // regions reserve screen space before summits do, so the big names win
    if (o > 0.05) {
      beginLabelFrame((clock.elapsedTime * 1000) | 0);
      const p = tmp.clone().project(camera);
      if (p.z >= 1) o = 0;
      else {
        const sx = ((p.x + 1) / 2) * size.width;
        const sy = ((1 - p.y) / 2) * size.height;
        if (!reserveLabel(d, sx, sy)) o = 0;
      }
    }
    d.style.opacity = o.toFixed(3);
    d.style.pointerEvents = o > 0.25 ? "auto" : "none";
  });

  return (
    <group ref={group}>
      <Html center zIndexRange={zRange} style={{ pointerEvents: "none" }}>
        <div ref={div} style={{ opacity: 0, transition: "opacity 0.2s linear" }}>
          {children}
        </div>
      </Html>
    </group>
  );
}

/**
 * Named summits, coordinated as one set: every frame the peaks are projected
 * to screen space in prominence order, and any label whose rectangle would
 * overlap an already-placed (more prominent) one is hidden — big peaks win.
 * Landscape-only; they step back while the time machine is scrubbed.
 */
function PeakLabels({ data }: { data: WorldData }) {
  const select = useWorld((s) => s.select);
  const requestWarp = useWorld((s) => s.requestWarp);
  const divs = useRef<(HTMLDivElement | null)[]>([]);
  const proj = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera, size, clock }) => {
    const st = useWorld.getState();
    const timeFade = st.year > st.yearMax ? 1 : 0.15;
    const base = (1 - uMorph.value) * timeFade;
    const globallyHidden = base <= 0.02 || st.warping || !st.showLabels;
    beginLabelFrame((clock.elapsedTime * 1000) | 0);

    for (let i = 0; i < data.peaks.length; i++) {
      const peak = data.peaks[i]; // already rank-ordered, 0 = most prominent
      const el = divs.current[i];
      if (!el) continue;

      let o = 0;
      if (!globallyHidden) {
        proj.copy(peak.pos).project(camera);
        if (proj.z < 1) {
          const x = ((proj.x + 1) / 2) * size.width;
          const y = ((1 - proj.y) / 2) * size.height;
          const dist = camera.position.distanceTo(peak.pos);
          const far = peak.rank < 10 ? 300 : 150;
          const t = THREE.MathUtils.clamp((far - dist) / (far - 14), 0, 1);
          o = Math.min(1, t * 1.6) * base;
          if (o > 0.05 && !reserveLabel(el, x, y)) o = 0;
        }
      }
      el.style.opacity = o.toFixed(3);
      el.style.pointerEvents = o > 0.25 ? "auto" : "none";
    }
  });

  return (
    <>
      {data.peaks.map((peak, i) => (
        <group key={`pk-${peak.rank}`} position={peak.pos}>
          <Html center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <div
              ref={(el) => {
                divs.current[i] = el;
              }}
              style={{
                opacity: 0,
                transition: "opacity 0.15s linear",
                // fixed lane so text wraps naturally onto multiple lines
                // instead of being clipped or squeezed into a vertical stack
                width: 230,
                textAlign: "center",
              }}
            >
              <button
                type="button"
                className="pointer-events-auto inline-block max-w-full cursor-pointer text-center select-none"
                onClick={() => {
                  if (peak.kind === "paper")
                    select({ kind: "paper", idx: peak.paperIdx });
                  else if (peak.kind === "entity")
                    select({ kind: "entity", idx: peak.entityIdx });
                  else requestWarp([peak.pos.x, peak.pos.y, peak.pos.z], 26, 1.8);
                }}
              >
                <span
                  className={`font-display block text-[9px] tracking-[0.12em] text-white [text-shadow:0_0_12px_rgba(0,0,0,0.95)] ${
                    peak.kind === "paper" ? "italic" : ""
                  }`}
                >
                  {peak.label}
                </span>
              </button>
            </div>
          </Html>
        </group>
      ))}
    </>
  );
}

export default function Labels({ data }: { data: WorldData }) {
  const requestWarp = useWorld((s) => s.requestWarp);
  const select = useWorld((s) => s.select);

  return (
    <group>
      {data.labelClusters.map(({ cluster, ground, space }) => (
        <FadingLabel
          key={`cl-${cluster.id}`}
          near={40}
          far={230}
          getPos={(out) => out.copy(ground).lerp(space, uMorph.value)}
        >
          <button
            type="button"
            className="cursor-pointer select-none text-center"
            onClick={() => {
              const p = ground.clone().lerp(space, uMorph.value);
              requestWarp([p.x, p.y, p.z], 34, 2.0);
            }}
            title={cluster.flavor}
          >
            <span className="font-display block text-[15px] tracking-[0.14em] text-white [text-shadow:0_0_14px_rgba(0,0,0,0.9)]">
              {cluster.name}
            </span>
          </button>
        </FadingLabel>
      ))}

      <PeakLabels data={data} />

      {data.labelEntities.map((idx) => {
        const e = data.entities[idx];
        return (
          <FadingLabel
            key={`en-${e.id}`}
            near={18}
            far={120}
            getPos={(out) => entityWorldPos(data, idx, uMorph.value, out)}
            alpha={() => THREE.MathUtils.clamp((uMorph.value - 0.3) / 0.4, 0, 1)}
          >
            <button
              type="button"
              className="cursor-pointer rounded-full border px-2 py-0.5 text-[10px] tracking-wide whitespace-nowrap backdrop-blur-[2px]"
              style={{
                borderColor: `${e.color}88`,
                color: e.color,
                background: "rgba(10,10,14,0.45)",
                transform: "translateY(-14px)",
              }}
              onClick={() => select({ kind: "entity", idx })}
            >
              {e.id.length > 26 ? `${e.id.slice(0, 25)}…` : e.id}
            </button>
          </FadingLabel>
        );
      })}

    </group>
  );
}
