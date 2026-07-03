"use client";

import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { PointsNodeMaterial } from "three/webgpu";
import {
  instancedBufferAttribute,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3,
} from "three/tsl";
import { useAtlasStore } from "@/lib/store";
import type { CorpusData } from "@/lib/types";
import { ringTexture, shortCite, type ObservatoryData } from "./derive";
import { useObservatory } from "./store";

/**
 * The night sky itself: 9k chunks as one instanced-sprite point cloud.
 *
 * WebGPU renders THREE.Points as 1-pixel primitives, so sized stars use the
 * three r185 pattern instead: a single THREE.Sprite with `count = n` and a
 * PointsNodeMaterial whose positionNode reads an instanced buffer attribute
 * (one screen-facing quad per star, one draw call).
 */

const HIT_TINT = new THREE.Color("#86b6ef");

function Stars({ data }: { data: ObservatoryData }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const searchHits = useObservatory((s) => s.searchHits);

  const { sprite, selAttr, uCalm, uHit } = useMemo(() => {
    const posAttr = new THREE.InstancedBufferAttribute(data.positions, 3);
    const colAttr = new THREE.InstancedBufferAttribute(data.colors, 3);
    const sizeAttr = new THREE.InstancedBufferAttribute(data.sizes, 1);
    const phaseAttr = new THREE.InstancedBufferAttribute(data.phases, 1);
    const selAttr = new THREE.InstancedBufferAttribute(new Float32Array(data.n), 1);
    selAttr.setUsage(THREE.DynamicDrawUsage);

    const aPos = instancedBufferAttribute<"vec3">(posAttr, "vec3");
    const aColor = instancedBufferAttribute<"vec3">(colAttr, "vec3");
    const aSize = instancedBufferAttribute<"float">(sizeAttr, "float");
    const aPhase = instancedBufferAttribute<"float">(phaseAttr, "float");
    const aSel = instancedBufferAttribute<"float">(selAttr, "float");

    // Bulk field brightness rises gently with HDR headroom; search-hit pulses use it fully.
    const uCalm = uniform(1);
    const uHit = uniform(1);

    const mat = new PointsNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.blending = THREE.AdditiveBlending;
    mat.sizeAttenuation = true;

    mat.positionNode = aPos;

    const twinkle = sin(time.mul(1.6).add(aPhase)).mul(0.5).add(0.5).mul(0.34).add(0.66);
    const hitPulse = sin(time.mul(5.0)).mul(0.5).add(0.5).mul(0.75).add(0.25).mul(aSel);

    const d = uv().sub(0.5).length().mul(2.0).clamp(0, 1); // 0 centre → 1 edge
    // (ascending edges only — descending smoothstep is undefined in WGSL/GLSL)
    const core = smoothstep(0.0, 0.5, d).oneMinus().pow(2.0).mul(1.6).add(1.0);

    mat.colorNode = aColor
      .mul(twinkle)
      .mul(core)
      .mul(uCalm)
      .add(vec3(HIT_TINT.r, HIT_TINT.g, HIT_TINT.b).mul(hitPulse).mul(uHit).mul(core));
    mat.opacityNode = d.oneMinus().pow(2.6);
    mat.sizeNode = aSize.mul(hitPulse.mul(1.2).add(1.0));

    const sprite = new THREE.Sprite(mat as unknown as THREE.SpriteMaterial);
    sprite.count = data.n;
    sprite.frustumCulled = false;
    return { sprite, selAttr, uCalm, uHit };
  }, [data]);

  useEffect(() => {
    uCalm.value = 0.55 + 0.45 * boost;
    uHit.value = boost;
  }, [boost, uCalm, uHit]);

  // Mark warp-drive search hits so they pulse in the sky.
  useEffect(() => {
    const arr = selAttr.array as Float32Array;
    arr.fill(0);
    if (searchHits) for (const h of searchHits) arr[h.idx] = 1;
    selAttr.needsUpdate = true;
  }, [searchHits, selAttr]);

  useEffect(() => {
    return () => {
      sprite.material.dispose();
    };
  }, [sprite]);

  return <primitive object={sprite} />;
}

/** Distant 1px dust for parallax depth (deterministic scatter on a far shell). */
function DustShell() {
  const geom = useMemo(() => {
    let s = 42;
    const rand = () => {
      // mulberry32
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const N = 1600;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = rand() * 2 - 1;
      const th = rand() * Math.PI * 2;
      const r = 260 + rand() * 160;
      const s2 = Math.sqrt(1 - u * u);
      pos[i * 3] = r * s2 * Math.cos(th);
      pos[i * 3 + 1] = r * u;
      pos[i * 3 + 2] = r * s2 * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);

  return (
    <points geometry={geom} frustumCulled={false}>
      <pointsMaterial
        color="#565e7d"
        size={1.5}
        sizeAttenuation={false}
        transparent
        opacity={0.55}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

/** Billboard ring markers for the hovered / observed star. */
function StarRing({
  index,
  data,
  color,
  base,
  pulse,
  speed,
}: {
  index: number;
  data: ObservatoryData;
  color: string;
  base: number;
  pulse: number;
  speed: number;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const sprite = useMemo(() => {
    const m = new THREE.SpriteMaterial({
      map: ringTexture(),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    return new THREE.Sprite(m);
  }, []);
  useEffect(() => {
    sprite.material.color.set(color).multiplyScalar(0.85 * boost);
  }, [sprite, color, boost]);
  useEffect(() => () => sprite.material.dispose(), [sprite]);

  const size = 1.6 + data.sizes[index] * 1.9;

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    sprite.scale.setScalar(size * (base + pulse * (0.5 + 0.5 * Math.sin(t * speed))));
    sprite.material.rotation = t * 0.3;
  });

  return (
    <primitive
      object={sprite}
      position={[
        data.positions[index * 3],
        data.positions[index * 3 + 1],
        data.positions[index * 3 + 2],
      ]}
    />
  );
}

/**
 * Telescope pointing: angular picking against every star on pointer move
 * (9k dot products — cheap), click to observe, double-click to fly there.
 * Listeners live on the canvas element so DOM panels naturally block them.
 */
function StarPicker({ data, corpus }: { data: ObservatoryData; corpus: CorpusData }) {
  const { camera, gl } = useThree();
  const setHoveredStar = useObservatory((s) => s.setHoveredStar);
  const selectStar = useObservatory((s) => s.selectStar);
  const requestWarp = useObservatory((s) => s.requestWarp);

  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let hovered: number | null = null;
    let down: { x: number; y: number; t: number } | null = null;
    let dragging = false;

    const pick = (e: PointerEvent | MouseEvent): number | null => {
      const rect = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, camera);
      const o = ray.ray.origin;
      const dir = ray.ray.direction;
      const pos = data.positions;
      let best = -1;
      let bestQ = 1; // normalized angular miss, <1 = inside cone
      for (let i = 0; i < data.n; i++) {
        const vx = pos[i * 3] - o.x;
        const vy = pos[i * 3 + 1] - o.y;
        const vz = pos[i * 3 + 2] - o.z;
        const dot = vx * dir.x + vy * dir.y + vz * dir.z;
        if (dot <= 0.5) continue; // behind or on top of the camera
        const l2 = vx * vx + vy * vy + vz * vz;
        const cos2 = (dot * dot) / l2;
        const sin2 = 1 - cos2;
        // pick cone: a base of ~0.9° widened by the star's apparent radius
        const app = (data.sizes[i] * 0.9) / Math.sqrt(l2);
        const ang = Math.max(0.016, app);
        const q = sin2 / (ang * ang);
        if (q < bestQ) {
          bestQ = q;
          best = i;
        }
      }
      return best >= 0 ? best : null;
    };

    const onMove = (e: PointerEvent) => {
      if (down && (Math.abs(e.clientX - down.x) > 5 || Math.abs(e.clientY - down.y) > 5)) {
        dragging = true;
      }
      if (dragging || useObservatory.getState().warping) {
        if (hovered !== null) {
          hovered = null;
          setHoveredStar(null);
          el.style.cursor = "";
        }
        return;
      }
      const hit = pick(e);
      if (hit !== hovered) {
        hovered = hit;
        setHoveredStar(hit);
        el.style.cursor = hit !== null ? "pointer" : "";
      }
    };

    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      dragging = false;
    };

    const onUp = (e: PointerEvent) => {
      const wasDrag = dragging || !down || performance.now() - down.t > 450;
      down = null;
      dragging = false;
      if (wasDrag) return;
      // labels & nebulae own their clicks; don't fight them
      if (useObservatory.getState().hoveredEntity !== null) return;
      const hit = pick(e);
      if (hit !== null) {
        selectStar(hit);
      } else if (useObservatory.getState().selection) {
        selectStar(null);
      }
    };

    const onDblClick = (e: MouseEvent) => {
      const hit = pick(e);
      if (hit === null) return;
      selectStar(hit);
      requestWarp(
        [data.positions[hit * 3], data.positions[hit * 3 + 1], data.positions[hit * 3 + 2]],
        6.5 + data.sizes[hit] * 2,
        1.7,
      );
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDblClick);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDblClick);
      el.style.cursor = "";
      setHoveredStar(null);
    };
  }, [camera, gl, data, corpus, setHoveredStar, selectStar, requestWarp]);

  return null;
}

/** The finder readout that follows the hovered star. */
function StarTooltip({ data, corpus }: { data: ObservatoryData; corpus: CorpusData }) {
  const hovered = useObservatory((s) => s.hoveredStar);
  if (hovered === null) return null;
  const paper = corpus.papers[corpus.atlas.paper[hovered]];
  const section = corpus.atlas.section[hovered];
  const title = paper?.title ?? "Unknown paper";
  return (
    <Html
      position={[
        data.positions[hovered * 3],
        data.positions[hovered * 3 + 1],
        data.positions[hovered * 3 + 2],
      ]}
      zIndexRange={[30, 0]}
      style={{ pointerEvents: "none", transform: "translate(14px, -50%)" }}
    >
      <div className="hud-panel w-64 px-3 py-2">
        <p className="line-clamp-1 text-[10px] tracking-[0.25em] text-ink-3 uppercase">
          {section && section !== "Untitled" ? section : "passage"}
        </p>
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-ink">{title}</p>
        <p className="mt-1 text-[11px] text-ink-3">
          {shortCite(paper)} · click to observe
        </p>
      </div>
    </Html>
  );
}

export default function Starfield({
  data,
  corpus,
}: {
  data: ObservatoryData;
  corpus: CorpusData;
}) {
  const hovered = useObservatory((s) => s.hoveredStar);
  const selection = useObservatory((s) => s.selection);
  const selectedStar = selection?.kind === "star" ? selection.idx : null;

  return (
    <group>
      <Stars data={data} />
      <DustShell />
      <StarPicker data={data} corpus={corpus} />
      {hovered !== null && hovered !== selectedStar && (
        <StarRing index={hovered} data={data} color="#c3c2b7" base={1.0} pulse={0.12} speed={5} />
      )}
      {selectedStar !== null && (
        <StarRing index={selectedStar} data={data} color="#9ec5f4" base={1.1} pulse={0.22} speed={2.6} />
      )}
      <StarTooltip data={data} corpus={corpus} />
    </group>
  );
}
