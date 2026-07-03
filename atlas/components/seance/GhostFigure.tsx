"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import * as THREE from "three";
import { useAtlasStore } from "@/lib/store";
import { GHOST_GREEN, GHOST_HOT } from "./theme";

/**
 * The summoned author: a wisp of updrafting particles inside translucent
 * shroud cones, a flickering hot core, and a ground ring at their embedding
 * centroid. Emissives scale with hdrBoost so the figure overshoots 1.0 on a
 * true-HDR canvas. `presence` dims the whole figure (drops when the record is
 * silent); `channeling` quickens the pulse while an answer is being drawn.
 */

const N_WISP = 150;
const WISP_HEIGHT = 6.4;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function GhostFigure({
  position,
  name,
  years,
  presence,
  channeling,
}: {
  position: [number, number, number];
  name: string;
  years: string;
  /** 0..1 target visibility (silence dims the ghost) */
  presence: number;
  channeling: boolean;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const core = useRef<THREE.Mesh>(null);
  const shroudA = useRef<THREE.Mesh>(null);
  const shroudB = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const wisp = useRef<THREE.Points>(null);
  const presCur = useRef(0); // eased-in from 0 so the summon materializes

  // per-particle seeds, deterministic per author so re-summons look identical
  const seeds = useMemo(() => {
    const rand = mulberry32(hashSeed(name));
    return Array.from({ length: N_WISP }, () => ({
      r: 0.35 + rand() * 1.05,
      a: rand() * Math.PI * 2,
      speed: 0.045 + rand() * 0.11,
      phase: rand(),
    }));
  }, [name]);

  const wispGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N_WISP * 3), 3));
    // generous bounds — positions are rewritten every frame
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, WISP_HEIGHT / 2, 0), WISP_HEIGHT);
    return g;
  }, []);

  const { ghostColor, hotColor, wispColor } = useMemo(() => {
    const k = boost;
    return {
      ghostColor: new THREE.Color(GHOST_GREEN).multiplyScalar(0.55 * k),
      hotColor: new THREE.Color(GHOST_HOT).multiplyScalar(0.95 * k),
      wispColor: new THREE.Color(GHOST_GREEN).multiplyScalar(0.85 * k),
    };
  }, [boost]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    presCur.current = THREE.MathUtils.damp(presCur.current, presence, 3, delta);
    const p = presCur.current;

    // candle-flame flicker; quicker and brighter while channeling
    const rate = channeling ? 3.4 : 1.0;
    const flicker =
      0.78 +
      0.14 * Math.sin(t * 7.3 * rate) +
      0.08 * Math.sin(t * 13.7 * rate + 1.7) +
      (channeling ? 0.22 : 0);

    if (wisp.current) {
      const attr = wispGeom.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < N_WISP; i++) {
        const s = seeds[i];
        const y01 = (s.phase + t * s.speed * (channeling ? 1.7 : 1)) % 1;
        const y = y01 * WISP_HEIGHT;
        const taper = 1 - y01 * 0.6;
        const swirl = s.a + t * 0.3 + y * 0.4;
        const r = s.r * taper + 0.12 * Math.sin(t * 0.9 + s.a * 5 + y);
        arr[i * 3] = Math.cos(swirl) * r;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = Math.sin(swirl) * r;
      }
      attr.needsUpdate = true;
      (wisp.current.material as THREE.PointsMaterial).opacity = 0.75 * p * flicker;
    }
    if (core.current) {
      core.current.scale.setScalar((0.85 + 0.18 * Math.sin(t * 2.1 * rate)) * (0.4 + 0.6 * p));
      core.current.position.y = 2.7 + Math.sin(t * 0.8) * 0.25;
      (core.current.material as THREE.MeshBasicMaterial).color
        .copy(hotColor)
        .multiplyScalar(flicker * (0.35 + 0.65 * p));
    }
    if (shroudA.current) {
      shroudA.current.rotation.y = t * 0.22;
      (shroudA.current.material as THREE.MeshBasicMaterial).opacity = 0.16 * p * flicker;
    }
    if (shroudB.current) {
      shroudB.current.rotation.y = -t * 0.31;
      shroudB.current.position.y = 1.9 + Math.sin(t * 0.7 + 1) * 0.18;
      (shroudB.current.material as THREE.MeshBasicMaterial).opacity = 0.22 * p * flicker;
    }
    if (ring.current) {
      ring.current.rotation.z = t * 0.2;
      ring.current.scale.setScalar(1 + 0.1 * Math.sin(t * 1.4) + (channeling ? 0.25 : 0));
      (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.55 * p;
    }
  });

  return (
    <group position={position}>
      {/* ground ring seating the figure on the terrain */}
      <mesh ref={ring} position={[0, 0.14, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.9, 2.4, 48]} />
        <meshBasicMaterial
          color={ghostColor}
          transparent
          opacity={0.55}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* translucent shroud cones */}
      <mesh ref={shroudA} position={[0, 2.4, 0]}>
        <coneGeometry args={[1.5, 4.8, 24, 1, true]} />
        <meshBasicMaterial
          color={ghostColor}
          transparent
          opacity={0.16}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={shroudB} position={[0, 1.9, 0]}>
        <coneGeometry args={[0.95, 3.6, 20, 1, true]} />
        <meshBasicMaterial
          color={ghostColor}
          transparent
          opacity={0.22}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* updrafting wisp */}
      <points ref={wisp} geometry={wispGeom}>
        <pointsMaterial
          color={wispColor}
          size={0.16}
          sizeAttenuation
          transparent
          opacity={0.75}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>

      {/* hot core */}
      <mesh ref={core} position={[0, 2.7, 0]}>
        <icosahedronGeometry args={[0.42, 2]} />
        <meshBasicMaterial color={hotColor} toneMapped={false} />
      </mesh>

      {/* nameplate */}
      <Billboard position={[0, WISP_HEIGHT + 1.7, 0]}>
        <Text
          fontSize={1.5}
          color="#dcffe9"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.03}
          outlineColor="#0d0d0d"
          maxWidth={26}
          textAlign="center"
        >
          {name}
        </Text>
        <Text
          position={[0, -0.35, 0]}
          fontSize={0.8}
          color={GHOST_GREEN}
          anchorX="center"
          anchorY="top"
          letterSpacing={0.15}
        >
          {years ? `SUMMONED · ${years}` : "SUMMONED"}
        </Text>
      </Billboard>
    </group>
  );
}
