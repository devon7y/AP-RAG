"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import * as THREE from "three";
import HDRCanvas from "@/components/HDRCanvas";
import { sampleHeight, toWorld, WORLD_SIZE } from "@/lib/data";
import { clusterColor } from "@/lib/palette";
import { useAtlasStore } from "@/lib/store";
import type { CorpusData } from "@/lib/types";
import { useRadioStore } from "./radioStore";
import { cleanTerms } from "./walk";

/**
 * The map quietly scrolling underneath the broadcast: the corpus as a dim
 * terrain of points, the walk as a fading comet trail, the walker as a pulsing
 * transmitter with expanding broadcast rings, and — when tuned — the station as
 * a distant amber antenna. The camera is fully autonomous: it drifts after the
 * walker on a slow orbit. Nothing here is clickable; this scene is wallpaper.
 */

const HEIGHT_SCALE = 14;
const TRAIL_MAX = 48;
const CAM_RADIUS = 30;
const CAM_HEIGHT = 17;

const ACCENT = new THREE.Color("#d55181");
const ACCENT_HOT = new THREE.Color("#ff9fc4");
const AMBER = new THREE.Color("#c98500");
const AMBER_HOT = new THREE.Color("#ffc46b");

function chunkWorld(corpus: CorpusData, i: number, out: THREE.Vector3): THREE.Vector3 {
  const x01 = corpus.atlas.pos2[i * 2];
  const y01 = corpus.atlas.pos2[i * 2 + 1];
  const [wx, wz] = toWorld(x01, y01);
  out.set(wx, sampleHeight(corpus.heightmap, x01, y01) * HEIGHT_SCALE, wz);
  return out;
}

/** The corpus as a dim landmass (single buffer geometry — never React elements). */
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
      const lift = 0.2 + 0.45 * (h / HEIGHT_SCALE);
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
        opacity={0.65}
        depthWrite={false}
      />
    </points>
  );
}

interface TrailObjects {
  geom: THREE.BufferGeometry;
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  line: THREE.Line;
}

function createTrailObjects(): TrailObjects {
  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3);
  const colAttr = new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("position", posAttr);
  geom.setAttribute("color", colAttr);
  geom.setDrawRange(0, 0);
  const line = new THREE.Line(
    geom,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  line.frustumCulled = false;
  return { geom, posAttr, colAttr, line };
}

function fillTrailBuffers(
  o: TrailObjects,
  trail: number[],
  corpus: CorpusData,
  boost: number,
): void {
  const n = Math.min(trail.length, TRAIL_MAX);
  const start = trail.length - n;
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (let j = 0; j < n; j++) {
    chunkWorld(corpus, trail[start + j], v);
    o.posAttr.setXYZ(j, v.x, v.y + 1.0, v.z);
    const recency = (j + 1) / n; // 1 = newest
    if (j === n - 1) {
      c.copy(ACCENT_HOT).multiplyScalar(0.9 * boost);
    } else {
      c.copy(ACCENT).multiplyScalar((0.1 + 0.85 * Math.pow(recency, 1.8)) * 0.9 * boost);
    }
    o.colAttr.setXYZ(j, c.r, c.g, c.b);
  }
  o.geom.setDrawRange(0, n);
  o.posAttr.needsUpdate = true;
  o.colAttr.needsUpdate = true;
  o.geom.computeBoundingSphere();
}

/** The walk's wake: a fading additive comet line + breadcrumb glow points. */
function TrailComet({ corpus }: { corpus: CorpusData }) {
  const trail = useRadioStore((s) => s.trail);
  const boost = useAtlasStore((s) => s.hdrBoost);
  const objects = useMemo(() => createTrailObjects(), []);
  const applied = useRef<{ trail: number[] | null; boost: number }>({ trail: null, boost: -1 });

  useFrame(() => {
    const a = applied.current;
    if (a.trail === trail && a.boost === boost) return;
    a.trail = trail;
    a.boost = boost;
    fillTrailBuffers(objects, trail, corpus, boost);
  });

  return (
    <>
      <primitive object={objects.line} />
      <points geometry={objects.geom} frustumCulled={false}>
        <pointsMaterial
          size={1.0}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>
    </>
  );
}

/**
 * The transmitter beacon gliding between chunks, its broadcast ripples, and the
 * autonomous camera that follows it on a slow orbit.
 */
function WalkerRig({ corpus }: { corpus: CorpusData }) {
  const current = useRadioStore((s) => s.current);
  const powered = useRadioStore((s) => s.powered);
  const playing = useRadioStore((s) => s.playing);
  const boost = useAtlasStore((s) => s.hdrBoost);

  const group = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const rings = useRef<(THREE.Mesh | null)[]>([null, null, null]);
  const anim = useRef({
    from: new THREE.Vector3(0, 6, 0),
    to: new THREE.Vector3(0, 6, 0),
    t: 1,
  });
  const visual = useRef(new THREE.Vector3(0, 6, 0));
  const heading = useRef(0.6);
  const desired = useRef(new THREE.Vector3());
  const first = useRef(true);

  const { coreColor, ringColor, beamColor } = useMemo(
    () => ({
      coreColor: ACCENT_HOT.clone().multiplyScalar(0.95 * boost),
      ringColor: ACCENT.clone().multiplyScalar(0.6 * boost),
      beamColor: ACCENT.clone().multiplyScalar(0.4 * boost),
    }),
    [boost],
  );

  useEffect(() => {
    if (current === null) return;
    const v = new THREE.Vector3();
    chunkWorld(corpus, current, v);
    const a = anim.current;
    if (first.current) {
      first.current = false;
      a.from.copy(v);
      a.to.copy(v);
      a.t = 1;
      visual.current.copy(v);
    } else {
      a.from.copy(visual.current);
      a.to.copy(v);
      a.t = 0;
    }
  }, [current, corpus]);

  useFrame((state, dt) => {
    const a = anim.current;
    if (a.t < 1) a.t = Math.min(1, a.t + dt / 2.4);
    const e = a.t * a.t * (3 - 2 * a.t);
    visual.current.lerpVectors(a.from, a.to, e);
    const t = state.clock.elapsedTime;

    if (group.current) {
      group.current.position.copy(visual.current);
      group.current.visible = current !== null;
    }
    if (core.current) {
      core.current.position.y = 2.3 + Math.sin(t * 1.1) * 0.3;
      core.current.scale.setScalar((0.85 + 0.25 * Math.sin(t * 1.7)) * (playing ? 1 : 0.7));
    }
    for (let i = 0; i < rings.current.length; i++) {
      const ring = rings.current[i];
      if (!ring) continue;
      const phase = (t * 0.22 + i / 3) % 1;
      ring.scale.setScalar(0.6 + phase * 6);
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.pow(1 - phase, 1.6) * (powered ? 0.4 : 0.12);
    }

    // autonomous camera: slow orbit around the (smoothed) walker
    heading.current += dt * (playing ? 0.05 : 0.02);
    desired.current.set(
      visual.current.x + Math.sin(heading.current) * CAM_RADIUS,
      visual.current.y + CAM_HEIGHT + Math.sin(t * 0.13) * 1.6,
      visual.current.z + Math.cos(heading.current) * CAM_RADIUS,
    );
    const k = 1 - Math.exp(-dt * 0.55);
    state.camera.position.lerp(desired.current, k);
    state.camera.lookAt(visual.current.x, visual.current.y + 2.4, visual.current.z);
  });

  return (
    <group ref={group} visible={false}>
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          ref={(m) => {
            rings.current[i] = m;
          }}
          position={[0, 0.18, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <ringGeometry args={[1, 1.16, 48]} />
          <meshBasicMaterial
            color={ringColor}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      ))}

      {/* slim antenna beam */}
      <mesh position={[0, 3.5, 0]}>
        <cylinderGeometry args={[0.08, 0.08, 7, 10, 1, true]} />
        <meshBasicMaterial
          color={beamColor}
          transparent
          opacity={0.22}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>

      {/* pulsing transmitter core */}
      <mesh ref={core} position={[0, 2.3, 0]}>
        <icosahedronGeometry args={[0.5, 2]} />
        <meshBasicMaterial color={coreColor} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Faint name of the region the walk is currently crossing (cluster top terms). */
function RegionLabel({ corpus }: { corpus: CorpusData }) {
  const current = useRadioStore((s) => s.current);
  const cluster = current !== null ? corpus.atlas.cluster[current] : null;

  const info = useMemo(() => {
    if (cluster === null) return null;
    const c = corpus.clusters[cluster];
    if (!c) return null;
    const terms = cleanTerms(c.terms);
    const label = terms.length ? terms.join(" · ") : `region ${cluster}`;
    const [wx, wz] = toWorld(c.center[0], c.center[1]);
    const y = sampleHeight(corpus.heightmap, c.center[0], c.center[1]) * HEIGHT_SCALE;
    return { label, pos: [wx, y + 10, wz] as [number, number, number], id: cluster };
  }, [cluster, corpus]);

  if (!info) return null;
  return (
    <Billboard position={info.pos}>
      <Text
        fontSize={2.0}
        color="#c3c2b7"
        fillOpacity={0.48}
        outlineWidth={0.05}
        outlineColor="#08070c"
        outlineOpacity={0.6}
        letterSpacing={0.1}
        anchorX="center"
        anchorY="middle"
        maxWidth={44}
        textAlign="center"
      >
        {info.label}
      </Text>
      <Text
        position={[0, -1.9, 0]}
        fontSize={0.85}
        color="#898781"
        fillOpacity={0.55}
        letterSpacing={0.32}
        anchorX="center"
        anchorY="middle"
      >
        {`REGION ${info.id}`}
      </Text>
    </Billboard>
  );
}

/** The tuned station as a distant amber antenna the drift bends toward or away from. */
function StationMarker({ corpus }: { corpus: CorpusData }) {
  const station = useRadioStore((s) => s.station);
  const boost = useAtlasStore((s) => s.hdrBoost);
  const ring = useRef<THREE.Mesh>(null);
  const tip = useRef<THREE.Mesh>(null);

  const colors = useMemo(
    () => ({
      beam: AMBER.clone().multiplyScalar(0.5 * boost),
      hot: AMBER_HOT.clone().multiplyScalar(0.95 * boost),
      ring: AMBER.clone().multiplyScalar(0.65 * boost),
    }),
    [boost],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (ring.current) {
      const phase = (t * 0.3) % 1;
      ring.current.scale.setScalar(0.8 + phase * 5);
      (ring.current.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.35;
    }
    if (tip.current) {
      tip.current.scale.setScalar(0.8 + 0.3 * Math.sin(t * 2.2));
    }
  });

  if (!station) return null;
  const [wx, wz] = toWorld(station.centroid[0], station.centroid[1]);
  const y = sampleHeight(corpus.heightmap, station.centroid[0], station.centroid[1]) * HEIGHT_SCALE;

  return (
    <group position={[wx, y, wz]} key={station.query}>
      <mesh ref={ring} position={[0, 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.4, 1.7, 48]} />
        <meshBasicMaterial
          color={colors.ring}
          transparent
          opacity={0.3}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, 13, 0]}>
        <cylinderGeometry args={[0.14, 0.14, 26, 12, 1, true]} />
        <meshBasicMaterial
          color={colors.beam}
          transparent
          opacity={0.3}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={tip} position={[0, 26, 0]}>
        <octahedronGeometry args={[0.7, 0]} />
        <meshBasicMaterial color={colors.hot} toneMapped={false} />
      </mesh>
      <Billboard position={[0, 28.6, 0]}>
        <Text
          fontSize={1.5}
          color="#ffc46b"
          fillOpacity={0.85}
          outlineWidth={0.04}
          outlineColor="#08070c"
          anchorX="center"
          anchorY="bottom"
          maxWidth={30}
          textAlign="center"
        >
          {station.query}
        </Text>
        <Text
          position={[0, -0.4, 0]}
          fontSize={0.8}
          color="#c98500"
          fillOpacity={0.7}
          letterSpacing={0.3}
          anchorX="center"
          anchorY="top"
        >
          STATION
        </Text>
      </Billboard>
    </group>
  );
}

export default function DriftMap({ corpus }: { corpus: CorpusData }) {
  return (
    <HDRCanvas
      camera={{ position: [0, 54, 88], fov: 50, near: 0.1, far: 420 }}
      clearColor={0x08070c}
    >
      <fog attach="fog" args={[0x08070c, 85, 260]} />
      <ambientLight intensity={0.4} />
      <Landmass corpus={corpus} />
      <TrailComet corpus={corpus} />
      <WalkerRig corpus={corpus} />
      <RegionLabel corpus={corpus} />
      <StationMarker corpus={corpus} />
      <gridHelper args={[WORLD_SIZE, 20, 0x2c2c2a, 0x1c1c22]} position={[0, -0.5, 0]} />
    </HDRCanvas>
  );
}
