"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, QuadraticBezierLine, Text, type QuadraticBezierLineRef } from "@react-three/drei";
import * as THREE from "three";
import type { CitedSite } from "./authors";
import { sampleHeight, toWorld } from "@/lib/atlas/data";
import { useAtlasStore } from "@/lib/atlas/store";

/**
 * Where the answer was drawn from: one arcing thread per cited paper, from the
 * ghost to that paper's centroid on the map, with a pulsing marker + in-text
 * citation label at the far end. Remount (key by answer id) to replay the
 * fade-in for each new answer.
 */

function Thread({
  origin,
  site,
  index,
  baseY,
}: {
  origin: [number, number, number];
  site: CitedSite;
  index: number;
  baseY: number;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const line = useRef<QuadraticBezierLineRef>(null);
  const marker = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const born = useRef<number | null>(null);

  const [ex, ez] = toWorld(site.pos[0], site.pos[1]);
  const end: [number, number, number] = [ex, baseY + 0.5, ez];

  const mid = useMemo<[number, number, number]>(() => {
    const dx = end[0] - origin[0];
    const dz = end[2] - origin[2];
    const dist = Math.hypot(dx, dz);
    return [
      (origin[0] + end[0]) / 2,
      Math.max(origin[1], end[1]) + 4 + dist * 0.18,
      (origin[2] + end[2]) / 2,
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin[0], origin[1], origin[2], end[0], end[1], end[2]]);

  const { lineColor, markerColor } = useMemo(
    () => ({
      lineColor: new THREE.Color(site.color).multiplyScalar(0.9 * boost),
      markerColor: new THREE.Color(site.color).lerp(new THREE.Color("#ffffff"), 0.35).multiplyScalar(boost),
    }),
    [site.color, boost],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (born.current === null) born.current = t;
    // staggered fade-in per thread
    const age = t - born.current - index * 0.18;
    const fade = THREE.MathUtils.smoothstep(age, 0, 0.9);
    if (line.current) {
      (line.current.material as THREE.Material & { opacity: number }).opacity = 0.55 * fade;
    }
    if (marker.current) {
      const pulse = 1 + 0.35 * Math.sin(t * 2.6 + index * 1.3);
      marker.current.scale.setScalar(fade * 0.45 * pulse);
    }
    if (ringRef.current) {
      ringRef.current.rotation.z = t * 0.4 + index;
      ringRef.current.scale.setScalar(fade * (1 + 0.15 * Math.sin(t * 1.8 + index)));
      (ringRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 * fade;
    }
  });

  return (
    <group>
      <QuadraticBezierLine
        ref={line}
        start={origin}
        end={end}
        mid={mid}
        color={lineColor}
        lineWidth={1.6}
        transparent
        opacity={0}
        depthWrite={false}
      />
      <mesh ref={marker} position={end} scale={0}>
        <icosahedronGeometry args={[1, 1]} />
        <meshBasicMaterial color={markerColor} toneMapped={false} />
      </mesh>
      <mesh
        ref={ringRef}
        position={[end[0], baseY + 0.12, end[2]]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[0.9, 1.15, 40]} />
        <meshBasicMaterial
          color={lineColor}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Billboard position={[end[0], end[1] + 1.4, end[2]]}>
        <Text
          fontSize={0.85}
          color="#d9e8de"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.028}
          outlineColor="#0d0d0d"
          maxWidth={18}
          textAlign="center"
        >
          {site.intext}
        </Text>
        <Text
          position={[0, -0.22, 0]}
          fontSize={0.55}
          color={site.color}
          anchorX="center"
          anchorY="top"
          letterSpacing={0.1}
        >
          {site.region}
        </Text>
      </Billboard>
    </group>
  );
}

export default function CitationThreads({
  origin,
  sites,
  heightmap,
  heightScale,
}: {
  origin: [number, number, number];
  sites: CitedSite[];
  heightmap: Float32Array;
  heightScale: number;
}) {
  return (
    <group>
      {sites.map((site, i) => (
        <Thread
          key={site.filename}
          origin={origin}
          site={site}
          index={i}
          baseY={sampleHeight(heightmap, site.pos[0], site.pos[1]) * heightScale}
        />
      ))}
    </group>
  );
}
