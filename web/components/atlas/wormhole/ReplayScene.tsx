"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, Line, OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import HDRCanvas from "@/components/atlas/HDRCanvas";
import { useCorpus } from "@/lib/atlas/useCorpus";
import { sampleHeight, toWorld, WORLD_SIZE } from "@/lib/atlas/data";
import { clusterColor } from "@/lib/atlas/palette";
import { useAtlasStore } from "@/lib/atlas/store";
import type { CorpusData } from "@/lib/atlas/types";
import type { WormholePair } from "./graph";
import { shortPaperLabel } from "./graph";
import { WORMHOLE_ACCENT } from "./types";

/**
 * Post-game replay: both players' routes drawn over the Atlas terrain,
 * comets re-flying each path simultaneously so divergent strategies
 * ("via entropy" vs "via memory") are visible at a glance.
 */

const HEIGHT_SCALE = 16;
const PATH_LIFT = 1.1;

export interface ReplayTrail {
  path: number[];
  color: string;
}

function worldPoint(corpus: CorpusData, chunk: number): THREE.Vector3 {
  const x01 = corpus.atlas.pos2[chunk * 2];
  const y01 = corpus.atlas.pos2[chunk * 2 + 1];
  const [wx, wz] = toWorld(x01, y01);
  const h = sampleHeight(corpus.heightmap, x01, y01) * HEIGHT_SCALE;
  return new THREE.Vector3(wx, h + PATH_LIFT, wz);
}

/** The corpus as a dim point-cloud landmass (same treatment as /voids). */
function Landmass({ corpus }: { corpus: CorpusData }) {
  const geom = useMemo(() => {
    const { atlas, heightmap } = corpus;
    const n = atlas.n;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const x01 = atlas.pos2[i * 2];
      const y01 = atlas.pos2[i * 2 + 1];
      const [wx, wz] = toWorld(x01, y01);
      const h = sampleHeight(heightmap, x01, y01) * HEIGHT_SCALE;
      pos[i * 3] = wx;
      pos[i * 3 + 1] = h;
      pos[i * 3 + 2] = wz;
      c.set(clusterColor(atlas.cluster[i]));
      const lift = 0.22 + 0.45 * (h / HEIGHT_SCALE);
      col[i * 3] = c.r * lift;
      col[i * 3 + 1] = c.g * lift;
      col[i * 3 + 2] = c.b * lift;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [corpus]);

  return (
    <points geometry={geom}>
      <pointsMaterial
        size={0.5}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.6}
        depthWrite={false}
      />
    </points>
  );
}

function PathTrail({ corpus, trail }: { corpus: CorpusData; trail: ReplayTrail }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const comet = useRef<THREE.Mesh>(null);
  const progress = useRef(0);

  const points = useMemo(
    () => trail.path.map((c) => worldPoint(corpus, c)),
    [corpus, trail.path],
  );
  const curve = useMemo(
    () =>
      points.length >= 2
        ? new THREE.CatmullRomCurve3(points, false, "centripetal", 0.35)
        : null,
    [points],
  );
  const linePoints = useMemo(
    () => (curve ? curve.getPoints(Math.max(24, points.length * 14)) : []),
    [curve, points.length],
  );
  const cometColor = useMemo(
    () => new THREE.Color(trail.color).multiplyScalar(1.2 * boost),
    [trail.color, boost],
  );

  useFrame((_, dt) => {
    if (!curve || !comet.current) return;
    const duration = 2 + trail.path.length * 0.45;
    progress.current = Math.min(1, progress.current + dt / duration);
    comet.current.position.copy(curve.getPointAt(progress.current));
  });

  return (
    <group>
      {curve && (
        <Line
          points={linePoints}
          color={trail.color}
          lineWidth={2.5}
          transparent
          opacity={0.55}
        />
      )}
      {points.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[i === 0 || i === points.length - 1 ? 0.45 : 0.28, 12, 12]} />
          <meshBasicMaterial color={trail.color} transparent opacity={0.85} />
        </mesh>
      ))}
      {curve && (
        <mesh ref={comet} position={points[0]}>
          <sphereGeometry args={[0.55, 16, 16]} />
          <meshBasicMaterial color={cometColor} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

function Beacon({
  corpus,
  paperIdx,
  chunk,
  color,
  hot,
  label,
  sub,
  pulse,
}: {
  corpus: CorpusData;
  /** anchor: a paper centroid… */
  paperIdx?: number;
  /** …or an exact chunk */
  chunk?: number;
  color: string;
  hot: string;
  label: string;
  sub: string;
  pulse?: boolean;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const core = useRef<THREE.Mesh>(null);

  const [x01, y01] =
    chunk != null
      ? [corpus.atlas.pos2[chunk * 2], corpus.atlas.pos2[chunk * 2 + 1]]
      : (corpus.papers[paperIdx ?? 0]?.centroid ?? [0.5, 0.5]);
  const [x, z] = toWorld(x01, y01);
  const baseY = sampleHeight(corpus.heightmap, x01, y01) * HEIGHT_SCALE;

  const beamColor = useMemo(
    () => new THREE.Color(color).multiplyScalar(0.5 * boost),
    [color, boost],
  );
  const coreColor = useMemo(
    () => new THREE.Color(hot).multiplyScalar(0.9 * boost),
    [hot, boost],
  );

  useFrame((state) => {
    if (!pulse || !core.current) return;
    const t = state.clock.elapsedTime;
    core.current.scale.setScalar(0.9 + 0.25 * Math.sin(t * 2.2));
  });

  const height = 12;
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, baseY + 0.15, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.5, 2.0, 48]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={0.5}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, baseY + height / 2, 0]}>
        <cylinderGeometry args={[0.35, 0.9, height, 16, 1, true]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={0.3}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={core} position={[0, baseY + 2, 0]}>
        <icosahedronGeometry args={[0.5, 2]} />
        <meshBasicMaterial color={coreColor} toneMapped={false} />
      </mesh>
      <Billboard position={[0, baseY + height + 1.6, 0]}>
        <Text
          fontSize={1.5}
          color="#ffffff"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.03}
          outlineColor="#0d0d0d"
          maxWidth={26}
          textAlign="center"
        >
          {label}
        </Text>
        <Text
          position={[0, -0.3, 0]}
          fontSize={0.75}
          color={color}
          anchorX="center"
          anchorY="top"
          letterSpacing={0.15}
        >
          {sub}
        </Text>
      </Billboard>
    </group>
  );
}

export default function ReplayScene({
  pair,
  trails,
}: {
  pair: WormholePair;
  trails: ReplayTrail[];
}) {
  const { corpus } = useCorpus();
  if (!corpus) return null;

  return (
    <HDRCanvas
      camera={{ position: [0, 52, 82], fov: 55, near: 0.1, far: 400 }}
      clearColor={0x08070c}
    >
      <fog attach="fog" args={[0x08070c, 90, 240]} />
      <ambientLight intensity={0.4} />

      <Landmass corpus={corpus} />

      {trails.map((t, i) => (
        <PathTrail key={i} corpus={corpus} trail={t} />
      ))}

      <Beacon
        corpus={corpus}
        chunk={pair.startChunk}
        color="#c3c2b7"
        hot="#ffffff"
        label={shortPaperLabel(corpus, pair.startPaper)}
        sub="START"
      />
      <Beacon
        corpus={corpus}
        paperIdx={pair.targetPaper}
        color={WORMHOLE_ACCENT}
        hot="#5ad6a8"
        label={shortPaperLabel(corpus, pair.targetPaper)}
        sub="TARGET"
        pulse
      />

      <gridHelper args={[WORLD_SIZE, 20, 0x2c2c2a, 0x1c1c22]} position={[0, -0.5, 0]} />

      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        minDistance={12}
        maxDistance={200}
        maxPolarAngle={Math.PI / 2.05}
        target={[0, 4, 0]}
      />
    </HDRCanvas>
  );
}
