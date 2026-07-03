"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Billboard, OrbitControls, Text } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import HDRCanvas from "@/components/atlas/HDRCanvas";
import { sampleHeight, toWorld, WORLD_SIZE } from "@/lib/atlas/data";
import { clusterColor } from "@/lib/atlas/palette";
import { useAtlasStore } from "@/lib/atlas/store";
import type { CorpusData } from "@/lib/atlas/types";
import { tempRGB } from "./game";

const HEIGHT_SCALE = 16;

/** A guess rendered on the map: where its nearest chunk sits. */
export interface ScenePing {
  key: number; // guess ts
  x01: number;
  y01: number;
  temperature: number;
  text: string;
  latest: boolean;
}

/** Game-over payload: light the target paper up. */
export interface SceneEnd {
  paperIdx: number;
  centroid: [number, number];
  won: boolean;
}

const GOLD = new THREE.Color("#c98500");
const GOLD_HOT = new THREE.Color("#ffd27a");

/**
 * The corpus under fog of war: very dim until guesses ping it. Each ping clears
 * a soft pool of light around where it landed (bigger + brighter when hotter).
 * On game end the fog lifts and the target paper's chunks turn gold.
 */
function FogLandmass({
  corpus,
  pings,
  end,
}: {
  corpus: CorpusData;
  pings: ScenePing[];
  end: SceneEnd | null;
}) {
  const { geom, colorAttr } = useMemo(() => {
    const { atlas, heightmap } = corpus;
    const n = atlas.n;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x01 = atlas.pos2[i * 2];
      const y01 = atlas.pos2[i * 2 + 1];
      const [wx, wz] = toWorld(x01, y01);
      pos[i * 3] = wx;
      pos[i * 3 + 1] = sampleHeight(heightmap, x01, y01) * HEIGHT_SCALE;
      pos[i * 3 + 2] = wz;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const attr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    g.setAttribute("color", attr);
    return { geom: g, colorAttr: attr };
  }, [corpus]);

  useEffect(() => () => geom.dispose(), [geom]);

  const colors = useMemo(() => {
    const { atlas, heightmap } = corpus;
    const n = atlas.n;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    // Fog of war: dim while playing; lifts when the game ends.
    const baseLift = end ? 0.3 : 0.11;
    for (let i = 0; i < n; i++) {
      const x01 = atlas.pos2[i * 2];
      const y01 = atlas.pos2[i * 2 + 1];
      const h01 = sampleHeight(heightmap, x01, y01);

      if (end && atlas.paper[i] === end.paperIdx) {
        // The hidden paper, revealed in gold.
        const k = 0.9 + 0.8 * h01;
        col[i * 3] = GOLD_HOT.r * k;
        col[i * 3 + 1] = GOLD_HOT.g * k;
        col[i * 3 + 2] = GOLD_HOT.b * k;
        continue;
      }

      // Pools of light around pings — hotter guesses clear more fog.
      let reveal = 0;
      for (const p of pings) {
        const t01 = p.temperature / 100;
        const sigma = (0.018 + 0.038 * t01) * 2; // in [0,1]² map units
        const dx = x01 - p.x01;
        const dy = y01 - p.y01;
        reveal += Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) * (0.25 + 0.75 * t01);
      }
      reveal = Math.min(reveal, 1.15);

      c.set(clusterColor(atlas.cluster[i]));
      const lift = baseLift * (0.6 + 0.9 * h01) + reveal * 0.55;
      col[i * 3] = c.r * lift + reveal * 0.16;
      col[i * 3 + 1] = c.g * lift + reveal * 0.16;
      col[i * 3 + 2] = c.b * lift + reveal * 0.16;
    }
    return col;
  }, [corpus, pings, end]);

  useLayoutEffect(() => {
    (colorAttr.array as Float32Array).set(colors);
    colorAttr.needsUpdate = true;
  }, [colors, colorAttr]);

  return (
    <points geometry={geom}>
      <pointsMaterial
        size={0.55}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.85}
        depthWrite={false}
      />
    </points>
  );
}

/**
 * One guess on the map: ground ring + beam + glowing core, all scaled and
 * colored by temperature (dim deep blue → white-hot). The latest guess emits
 * a sonar pulse so you can find it. Hover (or hover its row) for the label.
 */
function PingMarker({
  ping,
  baseY,
  index,
  focused,
}: {
  ping: ScenePing;
  baseY: number;
  index: number;
  focused: boolean;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const core = useRef<THREE.Mesh>(null);
  const sonar = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const active = hovered || focused;

  const t01 = ping.temperature / 100;
  const beamH = 1.6 + 9 * Math.pow(t01, 1.4);
  const ringR = 0.8 + 1.1 * t01;

  const { beamColor, coreColor, labelY } = useMemo(() => {
    const [r, g, b] = tempRGB(ping.temperature);
    const base = new THREE.Color(r, g, b);
    const k = boost * (active ? 1.5 : 1.0);
    return {
      beamColor: base.clone().multiplyScalar(0.55 * k),
      coreColor: base.clone().multiplyScalar((0.7 + 0.9 * t01) * k),
      labelY: beamH + 1.6,
    };
  }, [ping.temperature, boost, active, t01, beamH]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pulse = 0.5 + 0.5 * Math.sin(t * (1.2 + t01 * 2.2) + index * 1.7);
    if (core.current) {
      core.current.scale.setScalar(0.85 + pulse * (0.15 + 0.45 * t01) + (active ? 0.4 : 0));
    }
    if (sonar.current) {
      // expanding, fading sonar ring on the latest guess
      const phase = (t % 2.4) / 2.4;
      sonar.current.scale.setScalar(1 + phase * 5.5);
      (sonar.current.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.45;
    }
  });

  const [x, z] = toWorld(ping.x01, ping.y01);

  return (
    <group position={[x, 0, z]}>
      {/* ground ring */}
      <mesh position={[0, baseY + 0.12, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[ringR, ringR + 0.28, 40]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={active ? 0.85 : 0.55}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* sonar pulse, latest guess only */}
      {ping.latest && (
        <mesh ref={sonar} position={[0, baseY + 0.14, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[ringR, ringR + 0.16, 40]} />
          <meshBasicMaterial
            color={beamColor}
            transparent
            opacity={0.4}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {/* beam */}
      <mesh position={[0, baseY + beamH / 2, 0]}>
        <cylinderGeometry args={[0.07, 0.14, beamH, 10, 1, true]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={active ? 0.55 : 0.34}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* core */}
      <mesh ref={core} position={[0, baseY + beamH, 0]}>
        <sphereGeometry args={[0.26 + 0.22 * t01, 20, 20]} />
        <meshBasicMaterial color={coreColor} toneMapped={false} />
      </mesh>

      {/* generous hit target */}
      <mesh
        position={[0, baseY + beamH / 2, 0]}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "auto";
        }}
      >
        <cylinderGeometry args={[1.6, 1.6, beamH + 3, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {active && (
        <Billboard position={[0, baseY + labelY, 0]}>
          <Text
            fontSize={1.15}
            color="#f2f0e8"
            anchorX="center"
            anchorY="bottom"
            outlineWidth={0.03}
            outlineColor="#0d0d0d"
            maxWidth={22}
            textAlign="center"
          >
            {ping.text.length > 64 ? `${ping.text.slice(0, 63)}…` : ping.text}
          </Text>
          <Text
            position={[0, -0.25, 0]}
            fontSize={0.85}
            color="#c3c2b7"
            anchorX="center"
            anchorY="top"
            outlineWidth={0.02}
            outlineColor="#0d0d0d"
          >
            {`${ping.temperature.toFixed(1)}°`}
          </Text>
        </Billboard>
      )}
    </group>
  );
}

/** Gold beacon over the revealed paper's home territory. */
function TargetBeacon({ end, baseY }: { end: SceneEnd; baseY: number }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const core = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);

  const { spireColor, coreColor } = useMemo(
    () => ({
      spireColor: GOLD.clone().multiplyScalar(0.6 * boost),
      coreColor: GOLD_HOT.clone().multiplyScalar(1.1 * boost),
    }),
    [boost],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.4);
    if (core.current) {
      core.current.scale.setScalar(0.9 + pulse * 0.35);
      core.current.position.y = baseY + 3.2 + Math.sin(t * 0.8) * 0.35;
    }
    if (ring.current) {
      ring.current.rotation.z = t * 0.3;
      ring.current.scale.setScalar(1 + pulse * 0.15);
    }
  });

  const [x, z] = toWorld(end.centroid[0], end.centroid[1]);
  const height = 15;

  return (
    <group position={[x, 0, z]}>
      <mesh ref={ring} position={[0, baseY + 0.18, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.1, 2.7, 56]} />
        <meshBasicMaterial
          color={spireColor}
          transparent
          opacity={0.6}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, baseY + height / 2, 0]}>
        <coneGeometry args={[1.7, height, 24, 1, true]} />
        <meshBasicMaterial
          color={spireColor}
          transparent
          opacity={0.32}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={core} position={[0, baseY + 3.2, 0]}>
        <icosahedronGeometry args={[0.6, 2]} />
        <meshBasicMaterial color={coreColor} toneMapped={false} />
      </mesh>
      <Billboard position={[0, baseY + height + 2.4, 0]}>
        <Text
          fontSize={1.3}
          color="#ffd27a"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.03}
          outlineColor="#0d0d0d"
          letterSpacing={0.12}
        >
          {end.won ? "FOUND" : "THE HIDDEN PAPER"}
        </Text>
      </Billboard>
    </group>
  );
}

/** Eases the camera to frame the revealed target, then hands control back. */
function FlyTo({
  controls,
  dest,
}: {
  controls: React.RefObject<OrbitControlsImpl | null>;
  dest: [number, number, number] | null;
}) {
  const camera = useThree((s) => s.camera);
  const startAt = useRef<number | null>(null);
  const target = useMemo(() => (dest ? new THREE.Vector3(...dest) : null), [dest]);

  useEffect(() => {
    startAt.current = target ? performance.now() : null;
  }, [target]);

  useFrame(() => {
    if (!target || startAt.current === null || !controls.current) return;
    if (performance.now() - startAt.current > 3200) {
      startAt.current = null; // done — player keeps the wheel
      return;
    }
    const camDest = target.clone().add(new THREE.Vector3(0, 17, 26));
    controls.current.target.lerp(target, 0.05);
    camera.position.lerp(camDest, 0.05);
  });

  return null;
}

export default function SemantleScene({
  corpus,
  pings,
  focusKey,
  end,
}: {
  corpus: CorpusData;
  pings: ScenePing[];
  focusKey: number | null;
  end: SceneEnd | null;
}) {
  const controls = useRef<OrbitControlsImpl | null>(null);

  const targetBaseY = end
    ? sampleHeight(corpus.heightmap, end.centroid[0], end.centroid[1]) * HEIGHT_SCALE
    : 0;

  const flyDest: [number, number, number] | null = useMemo(() => {
    if (!end) return null;
    const [x, z] = toWorld(end.centroid[0], end.centroid[1]);
    return [x, targetBaseY + 4, z];
  }, [end, targetBaseY]);

  return (
    <HDRCanvas
      camera={{ position: [0, 46, 78], fov: 55, near: 0.1, far: 400 }}
      clearColor={0x08070c}
    >
      <fog attach="fog" args={[0x08070c, 90, 240]} />
      <ambientLight intensity={0.4} />

      <FogLandmass corpus={corpus} pings={pings} end={end} />

      {pings.map((p, i) => (
        <PingMarker
          key={p.key}
          ping={p}
          index={i}
          baseY={sampleHeight(corpus.heightmap, p.x01, p.y01) * HEIGHT_SCALE}
          focused={focusKey === p.key}
        />
      ))}

      {end && <TargetBeacon end={end} baseY={targetBaseY} />}

      <gridHelper
        args={[WORLD_SIZE, 20, 0x2c2c2a, 0x1c1c22]}
        position={[0, -0.5, 0]}
      />

      <OrbitControls
        ref={controls}
        enableDamping
        dampingFactor={0.08}
        minDistance={10}
        maxDistance={200}
        maxPolarAngle={Math.PI / 2.05}
        target={[0, 4, 0]}
      />
      <FlyTo controls={controls} dest={flyDest} />
    </HDRCanvas>
  );
}
