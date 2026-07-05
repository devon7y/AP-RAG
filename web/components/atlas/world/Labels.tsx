"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { CorpusData } from "@/lib/atlas/types";
import { paperWorldPos } from "./PaperBeacons";
import { entityWorldPos } from "./SkyLayer";
import { shortCite, type WorldData } from "./derive";
import { useWorld } from "./store";
import { uMorph } from "./uniforms";

/**
 * DOM labels over the world (drei Html — WGSL-safe, per the atlas conventions).
 * Region names always ride their cluster; the top knowledge-graph entities get
 * small typed chips. Both fade by camera distance and hide while warping.
 * Total label count stays well under the ~60 budget.
 */

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

  useFrame(({ camera }) => {
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

export default function Labels({
  data,
  corpus,
}: {
  data: WorldData;
  corpus: CorpusData;
}) {
  const requestWarp = useWorld((s) => s.requestWarp);
  const select = useWorld((s) => s.select);
  const tmp = useMemo(() => new THREE.Vector3(), []);

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
            <span className="font-display block text-[15px] tracking-[0.14em] text-white/75 [text-shadow:0_0_14px_rgba(0,0,0,0.9)]">
              {cluster.name}
            </span>
            <span className="block text-[9px] tracking-[0.3em] text-white/35 uppercase">
              {cluster.nPapers} papers
            </span>
          </button>
        </FadingLabel>
      ))}

      {data.peaks.map((peak) => (
        <FadingLabel
          key={`pk-${peak.rank}`}
          near={14}
          far={peak.rank < 10 ? 300 : 150}
          getPos={(out) => out.copy(peak.pos)}
          alpha={() => {
            const st = useWorld.getState();
            // landscape-only, and step back while the time machine is scrubbed
            const timeFade = st.year > st.yearMax ? 1 : 0.15;
            return (1 - uMorph.value) * timeFade;
          }}
        >
          <button
            type="button"
            className="cursor-pointer text-center select-none"
            onClick={() => {
              if (peak.kind === "paper") select({ kind: "paper", idx: peak.paperIdx });
              else if (peak.kind === "entity")
                select({ kind: "entity", idx: peak.entityIdx });
              else requestWarp([peak.pos.x, peak.pos.y, peak.pos.z], 26, 1.8);
            }}
          >
            <span
              className={`font-display block text-[13px] tracking-[0.12em] text-white/75 [text-shadow:0_0_12px_rgba(0,0,0,0.95)] ${
                peak.kind === "paper" ? "italic" : ""
              }`}
            >
              {peak.label}
            </span>
          </button>
        </FadingLabel>
      ))}

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

      <HoverTooltip data={data} corpus={corpus} tmp={tmp} />
    </group>
  );
}

/** Finder readout for the hovered paper / chunk (entities have chips). */
function HoverTooltip({
  data,
  corpus,
  tmp,
}: {
  data: WorldData;
  corpus: CorpusData;
  tmp: THREE.Vector3;
}) {
  const hovered = useWorld((s) => s.hovered);
  if (!hovered || (hovered.kind !== "paper" && hovered.kind !== "chunk")) return null;

  let pos: THREE.Vector3;
  let head: string;
  let body: string;
  let foot: string;
  if (hovered.kind === "paper") {
    const p = corpus.papers[hovered.idx];
    pos = paperWorldPos(data, hovered.idx, uMorph.value, tmp);
    head = "paper";
    body = p.title;
    foot = `${shortCite(p)} · ${p.nChunks} passages · click to inspect`;
  } else {
    const i = hovered.idx;
    const p = corpus.papers[corpus.atlas.paper[i]];
    const gx = data.chunkGround[i * 3];
    const gy = data.chunkGroundY[i];
    const gz = data.chunkGround[i * 3 + 2];
    pos = tmp.set(
      gx + (data.chunkSpace[i * 3] - gx) * uMorph.value,
      gy + (data.chunkSpace[i * 3 + 1] - gy) * uMorph.value,
      gz + (data.chunkSpace[i * 3 + 2] - gz) * uMorph.value,
    );
    head = "passage";
    body = p?.title ?? "Unknown paper";
    foot = `${shortCite(p)} · click to read`;
  }

  return (
    <Html
      position={pos}
      zIndexRange={[30, 0]}
      style={{ pointerEvents: "none", transform: "translate(14px, -50%)" }}
    >
      <div className="hud-panel w-64 px-3 py-2">
        <p className="line-clamp-1 text-[10px] tracking-[0.25em] text-ink-3 uppercase">
          {head}
        </p>
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-ink">{body}</p>
        <p className="mt-1 text-[11px] text-ink-3">{foot}</p>
      </div>
    </Html>
  );
}
