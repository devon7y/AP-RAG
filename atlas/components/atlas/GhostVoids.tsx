"use client";

import { useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import * as THREE from "three";
import type { VoidSite } from "@/lib/types";
import { sampleHeight, toWorld } from "@/lib/data";
import { useAtlasStore } from "@/lib/store";

/**
 * The "dark matter" markers: a translucent spire + pulsing core + ground ring at
 * each low-density void. Emissive intensity is scaled by `hdrBoost` so the beams
 * overshoot 1.0 on a true-HDR canvas and merely look bright on SDR.
 *
 * Reusable: drop `<GhostVoids voids={…} heightmap={…} onSelect={…} />` inside any
 * R3F scene that uses the shared world convention (toWorld + sampleHeight).
 */

const GHOST_HUE = new THREE.Color("#9085e9"); // violet (dark-matter)
const GHOST_HOT = new THREE.Color("#b9b0ff");

function VoidMarker({
  site,
  index,
  baseY,
  selected,
  onSelect,
}: {
  site: VoidSite;
  index: number;
  baseY: number;
  selected: boolean;
  onSelect: (i: number) => void;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const core = useRef<THREE.Mesh>(null);
  const spire = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const active = hovered || selected;

  // Emissive colors pushed past 1.0 on HDR canvases (flat/NoToneMapping + half-float).
  const { spireColor, coreColor } = useMemo(() => {
    const k = boost * (active ? 1.6 : 1.0);
    return {
      spireColor: GHOST_HUE.clone().multiplyScalar(0.5 * k),
      coreColor: GHOST_HOT.clone().multiplyScalar(0.9 * k),
    };
  }, [boost, active]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.6 + index);
    if (core.current) {
      const s = 0.8 + pulse * 0.35 + (active ? 0.5 : 0);
      core.current.scale.setScalar(s);
      core.current.position.y = baseY + 2.4 + Math.sin(t * 0.9 + index) * 0.4;
    }
    if (spire.current) {
      (spire.current.material as THREE.MeshBasicMaterial).opacity =
        (active ? 0.5 : 0.28) * (0.7 + 0.3 * pulse);
    }
    if (ring.current) {
      ring.current.rotation.z = t * 0.25 + index;
      ring.current.scale.setScalar(1 + pulse * 0.12 + (active ? 0.35 : 0));
    }
  });

  const [x, z] = toWorld(site.pos[0], site.pos[1]);
  // Bigger voids get taller spires.
  const height = 8 + Math.min(site.area / 500, 8);

  return (
    <group position={[x, 0, z]}>
      {/* Ground ring on the terrain */}
      <mesh
        ref={ring}
        position={[0, baseY + 0.15, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[1.6, 2.1, 48]} />
        <meshBasicMaterial
          color={spireColor}
          transparent
          opacity={0.5}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Translucent spire pointing up out of the void */}
      <mesh ref={spire} position={[0, baseY + height / 2, 0]}>
        <coneGeometry args={[1.5, height, 24, 1, true]} />
        <meshBasicMaterial
          color={spireColor}
          transparent
          opacity={0.28}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* Pulsing core */}
      <mesh ref={core} position={[0, baseY + 2.4, 0]}>
        <icosahedronGeometry args={[0.55, 2]} />
        <meshBasicMaterial color={coreColor} toneMapped={false} />
      </mesh>

      {/* Invisible generous hit target */}
      <mesh
        position={[0, baseY + height / 2, 0]}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "auto";
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(index);
        }}
      >
        <cylinderGeometry args={[2.6, 2.6, height + 5, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Floating label on hover/selection */}
      {active && (
        <Billboard position={[0, baseY + height + 2.6, 0]}>
          <Text
            fontSize={1.5}
            color="#e9e6ff"
            anchorX="center"
            anchorY="bottom"
            outlineWidth={0.03}
            outlineColor="#0d0d0d"
            maxWidth={26}
            textAlign="center"
          >
            {site.ghost.title}
          </Text>
          <Text
            position={[0, -0.3, 0]}
            fontSize={0.8}
            color="#9085e9"
            anchorX="center"
            anchorY="top"
            letterSpacing={0.15}
          >
            GHOST · empty region
          </Text>
        </Billboard>
      )}
    </group>
  );
}

export default function GhostVoids({
  voids,
  heightmap,
  heightScale,
  selected,
  onSelect,
}: {
  voids: VoidSite[];
  heightmap: Float32Array;
  heightScale: number;
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  return (
    <group>
      {voids.map((site, i) => (
        <VoidMarker
          key={i}
          site={site}
          index={i}
          baseY={sampleHeight(heightmap, site.pos[0], site.pos[1]) * heightScale}
          selected={selected === i}
          onSelect={onSelect}
        />
      ))}
    </group>
  );
}
