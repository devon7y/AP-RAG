"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Billboard, OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";
import { sampleHeight, toWorld, WORLD_SIZE } from "@/lib/data";
import { clusterColor } from "@/lib/palette";
import { useAtlasStore } from "@/lib/store";
import type { CorpusData } from "@/lib/types";
import {
  COOL,
  RESULT_HOT,
  STEPS,
  WARM,
  hitKey,
  shortCite,
  type ArithResult,
  type Hit,
  type Mode,
  type Trace,
} from "./engine";

const HEIGHT_SCALE = 16;
const THREAD_LIFT = 2.7;
const MARKER_LIFT = 0.7;

const C_COOL = new THREE.Color(COOL);
const C_WARM = new THREE.Color(WARM);
const C_RESULT = new THREE.Color(RESULT_HOT);

/** Diverging cool→warm ramp along the geodesic (RGB lerp lands on the app violet mid). */
function grad(t: number, out: THREE.Color): THREE.Color {
  return out.copy(C_COOL).lerp(C_WARM, t);
}

function groundY(corpus: CorpusData, x01: number, y01: number): number {
  return sampleHeight(corpus.heightmap, x01, y01) * HEIGHT_SCALE;
}

function threadPoint(corpus: CorpusData, x01: number, y01: number, nudge = 0): THREE.Vector3 {
  const [wx, wz] = toWorld(x01, y01);
  return new THREE.Vector3(wx + nudge, groundY(corpus, x01, y01) + THREAD_LIFT, wz);
}

/** The corpus as a dim landmass — dimmer than /voids so the thread owns the light. */
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
      const lift = 0.15 + 0.32 * (h / HEIGHT_SCALE);
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

interface PathModel {
  curve: THREE.CatmullRomCurve3;
  uOfT: (t: number) => number;
  tOfU: (u: number) => number;
  beadPos: THREE.Vector3[];
}

/** Catmull-Rom through [anchorA?, waypoint centroids…, anchorB?] over the terrain. */
function usePathModel(corpus: CorpusData, trace: Trace | null): PathModel | null {
  return useMemo(() => {
    if (!trace) return null;
    const dist = (p: [number, number], q: [number, number]) =>
      Math.hypot(p[0] - q[0], p[1] - q[1]);
    const pts: THREE.Vector3[] = [];
    let aOff = 0;
    if (dist(trace.anchorA2, trace.steps[0].centroid2) > 0.012) {
      pts.push(threadPoint(corpus, trace.anchorA2[0], trace.anchorA2[1]));
      aOff = 1;
    }
    trace.steps.forEach((s, i) =>
      // tiny x-nudge keeps consecutive control points distinct when two
      // waypoints retrieve the same chunks (zero-length segments)
      pts.push(threadPoint(corpus, s.centroid2[0], s.centroid2[1], i * 0.002)),
    );
    if (dist(trace.anchorB2, trace.steps[trace.steps.length - 1].centroid2) > 0.012) {
      pts.push(threadPoint(corpus, trace.anchorB2[0], trace.anchorB2[1]));
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
    const nSeg = pts.length - 1;
    const uOfT = (t: number) => (aOff + t * (STEPS - 1)) / nSeg;
    const tOfU = (u: number) =>
      Math.min(1, Math.max(0, (u * nSeg - aOff) / (STEPS - 1)));
    const beadPos = trace.steps.map((_, i) => curve.getPoint(uOfT(i / (STEPS - 1))));
    return { curve, uOfT, tOfU, beadPos };
  }, [corpus, trace]);
}

/** The geodesic as a dense thread of glowing points, cool→warm along t. */
function ThreadDots({ model }: { model: PathModel }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const geom = useMemo(() => {
    const N = 280;
    const pts = model.curve.getPoints(N - 1);
    const pos = new Float32Array(pts.length * 3);
    const col = new Float32Array(pts.length * 3);
    const c = new THREE.Color();
    pts.forEach((p, i) => {
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      grad(model.tOfU(i / (pts.length - 1)), c).multiplyScalar(0.55 * boost);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  }, [model, boost]);

  return (
    <points geometry={geom}>
      <pointsMaterial
        size={0.5}
        sizeAttenuation
        vertexColors
        transparent
        opacity={0.9}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function Bead({
  pos,
  i,
  active,
  onPick,
}: {
  pos: THREE.Vector3;
  i: number;
  active: boolean;
  onPick: (i: number) => void;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const ref = useRef<THREE.Mesh>(null);
  const color = useMemo(
    () => grad(i / (STEPS - 1), new THREE.Color()).multiplyScalar((active ? 1.7 : 0.8) * boost),
    [i, active, boost],
  );

  useFrame((state) => {
    if (!ref.current) return;
    const s = active ? 1 + 0.18 * Math.sin(state.clock.elapsedTime * 3.2) : 1;
    ref.current.scale.setScalar(s);
  });

  return (
    <group position={pos}>
      <mesh ref={ref}>
        <sphereGeometry args={[active ? 0.62 : 0.42, 16, 16]} />
        <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.95} depthWrite={false} />
      </mesh>
      {/* generous invisible hit target */}
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onPick(i);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "auto";
        }}
      >
        <sphereGeometry args={[1.15, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** The comet that rides the thread as the slider scrubs. */
function Playhead({ model, tRef }: { model: PathModel; tRef: React.RefObject<number> }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const cur = useRef(0.5); // eased toward tRef each frame
  const tmp = useMemo(() => new THREE.Color(), []);

  useFrame((state, dt) => {
    const target = tRef.current ?? 0;
    cur.current += (target - cur.current) * Math.min(1, dt * 9);
    if (mesh.current) {
      mesh.current.position.copy(model.curve.getPoint(model.uOfT(cur.current)));
      mesh.current.scale.setScalar(1 + 0.12 * Math.sin(state.clock.elapsedTime * 4));
    }
    if (mat.current) mat.current.color.copy(grad(cur.current, tmp)).multiplyScalar(1.5 * boost);
  });

  return (
    <mesh ref={mesh}>
      <icosahedronGeometry args={[0.72, 2]} />
      <meshBasicMaterial ref={mat} toneMapped={false} />
    </mesh>
  );
}

/** Every retrieved passage at its true map position (instanced). */
function HitMarkers({
  corpus,
  hits,
  mode,
  tRef,
  hoverKey,
  openChunk,
  onHover,
  onPick,
}: {
  corpus: CorpusData;
  hits: Hit[];
  mode: Mode;
  tRef: React.RefObject<number>;
  hoverKey: string | null;
  openChunk: string | null;
  onHover: (k: string | null) => void;
  onPick: (h: Hit) => void;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const ref = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => new THREE.Color(), []);
  const mat4 = useMemo(() => new THREE.Matrix4(), []);

  const model = useMemo(() => {
    const pos: THREE.Vector3[] = [];
    const base: THREE.Color[] = [];
    for (const h of hits) {
      const x01 = h.chunkIdx >= 0 ? corpus.atlas.pos2[h.chunkIdx * 2] : 0.5;
      const y01 = h.chunkIdx >= 0 ? corpus.atlas.pos2[h.chunkIdx * 2 + 1] : 0.5;
      const [wx, wz] = toWorld(x01, y01);
      pos.push(new THREE.Vector3(wx, groundY(corpus, x01, y01) + MARKER_LIFT, wz));
      base.push(
        mode === "arithmetic"
          ? C_RESULT.clone()
          : grad(h.step / (STEPS - 1), new THREE.Color()),
      );
    }
    return { pos, base };
  }, [hits, corpus, mode]);

  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    model.pos.forEach((p, i) => {
      mat4.makeTranslation(p.x, p.y, p.z);
      m.setMatrixAt(i, mat4);
      m.setColorAt(i, model.base[i]);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [model, mat4]);

  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const cur = (tRef.current ?? 0) * (STEPS - 1);
    hits.forEach((h, i) => {
      let k: number;
      if (mode === "arithmetic") {
        k = 1.0 - Math.min(i * 0.07, 0.5); // fade with rank
      } else {
        const d = Math.abs(h.step - cur); // bright near the playhead
        k = 0.22 + 1.35 * Math.exp(-(d * d) / 1.3);
      }
      if (hitKey(h) === hoverKey) k *= 1.9;
      if (h.chunkId === openChunk) k = Math.max(k, 1.6);
      tmp.copy(model.base[i]).multiplyScalar(k * boost * 0.8);
      m.setColorAt(i, tmp);
    });
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  const hoverIdx = hoverKey ? hits.findIndex((h) => hitKey(h) === hoverKey) : -1;

  if (!hits.length) return null;

  return (
    <group>
      <instancedMesh
        ref={ref}
        args={[undefined, undefined, hits.length]}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          if (e.instanceId == null) return;
          onHover(hitKey(hits[e.instanceId]));
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          onHover(null);
          document.body.style.cursor = "auto";
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.instanceId == null) return;
          onPick(hits[e.instanceId]);
        }}
      >
        <sphereGeometry args={[0.3, 12, 12]} />
        <meshBasicMaterial
          toneMapped={false}
          transparent
          opacity={0.95}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>
      {hoverIdx >= 0 && (
        <Billboard
          position={[model.pos[hoverIdx].x, model.pos[hoverIdx].y + 1.5, model.pos[hoverIdx].z]}
        >
          <Text
            fontSize={1.05}
            color="#ffffff"
            anchorX="center"
            anchorY="bottom"
            outlineWidth={0.05}
            outlineColor="#0d0d0d"
          >
            {shortCite(corpus, hits[hoverIdx])}
          </Text>
        </Billboard>
      )}
    </group>
  );
}

/** Labeled endpoint / input marker: ring + translucent spire + name. */
function Beacon({
  corpus,
  x01,
  y01,
  letter,
  label,
  color,
}: {
  corpus: CorpusData;
  x01: number;
  y01: number;
  letter: string;
  label: string;
  color: string;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const [wx, wz] = toWorld(x01, y01);
  const y = groundY(corpus, x01, y01);
  const { spireColor, coreColor } = useMemo(() => {
    const c = new THREE.Color(color);
    return {
      spireColor: c.clone().multiplyScalar(0.5 * boost),
      coreColor: c.clone().multiplyScalar(1.2 * boost),
    };
  }, [color, boost]);
  const H = 7;

  return (
    <group position={[wx, y, wz]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.12, 0]}>
        <ringGeometry args={[1.3, 1.7, 40]} />
        <meshBasicMaterial
          color={spireColor}
          transparent
          opacity={0.5}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, H / 2, 0]}>
        <coneGeometry args={[1.0, H, 20, 1, true]} />
        <meshBasicMaterial
          color={spireColor}
          transparent
          opacity={0.3}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[0, H + 0.4, 0]}>
        <sphereGeometry args={[0.4, 12, 12]} />
        <meshBasicMaterial color={coreColor} toneMapped={false} />
      </mesh>
      <Billboard position={[0, H + 1.7, 0]}>
        <Text
          fontSize={1.35}
          color="#ffffff"
          anchorX="center"
          anchorY="bottom"
          outlineWidth={0.05}
          outlineColor="#0d0d0d"
          maxWidth={24}
          textAlign="center"
        >
          {label}
        </Text>
        <Text
          position={[0, -0.25, 0]}
          fontSize={0.75}
          color={color}
          anchorX="center"
          anchorY="top"
          letterSpacing={0.2}
        >
          {letter}
        </Text>
      </Billboard>
    </group>
  );
}

export default function PathScene({
  corpus,
  mode,
  trace,
  arith,
  stepIdx,
  tRef,
  hoverKey,
  openChunk,
  onPickStep,
  onPickHit,
  onHover,
}: {
  corpus: CorpusData;
  mode: Mode;
  trace: Trace | null;
  arith: ArithResult | null;
  stepIdx: number;
  tRef: React.RefObject<number>;
  hoverKey: string | null;
  openChunk: string | null;
  onPickStep: (i: number) => void;
  onPickHit: (h: Hit) => void;
  onHover: (k: string | null) => void;
}) {
  const model = usePathModel(corpus, trace);
  const geoHits = useMemo(() => (trace ? trace.steps.flatMap((s) => s.hits) : []), [trace]);

  return (
    <>
      <fog attach="fog" args={[0x08070c, 90, 240]} />
      <ambientLight intensity={0.4} />

      <Landmass corpus={corpus} />

      {mode === "geodesic" && trace && model && (
        <group>
          <ThreadDots model={model} />
          {model.beadPos.map((p, i) => (
            <Bead key={i} pos={p} i={i} active={i === stepIdx} onPick={onPickStep} />
          ))}
          <Playhead model={model} tRef={tRef} />
          <HitMarkers
            key={`geo-${trace.id}`}
            corpus={corpus}
            hits={geoHits}
            mode="geodesic"
            tRef={tRef}
            hoverKey={hoverKey}
            openChunk={openChunk}
            onHover={onHover}
            onPick={onPickHit}
          />
          <Beacon
            corpus={corpus}
            x01={trace.anchorA2[0]}
            y01={trace.anchorA2[1]}
            letter="A · origin"
            label={trace.aLabel}
            color={COOL}
          />
          <Beacon
            corpus={corpus}
            x01={trace.anchorB2[0]}
            y01={trace.anchorB2[1]}
            letter="B · destination"
            label={trace.bLabel}
            color={WARM}
          />
        </group>
      )}

      {mode === "arithmetic" && arith && (
        <group>
          {arith.anchors.map((a, i) => (
            <Beacon
              key={`${arith.id}-${i}`}
              corpus={corpus}
              x01={a.pos2[0]}
              y01={a.pos2[1]}
              letter={`${a.sign} ${"ABC"[i]}`}
              label={a.label}
              color={a.color}
            />
          ))}
          {arith.hits.length > 0 && arith.hits[0].chunkIdx >= 0 && (
            <Beacon
              corpus={corpus}
              x01={corpus.atlas.pos2[arith.hits[0].chunkIdx * 2]}
              y01={corpus.atlas.pos2[arith.hits[0].chunkIdx * 2 + 1]}
              letter="≈ nearest passage"
              label={shortCite(corpus, arith.hits[0])}
              color={RESULT_HOT}
            />
          )}
          <HitMarkers
            key={`ar-${arith.id}`}
            corpus={corpus}
            hits={arith.hits}
            mode="arithmetic"
            tRef={tRef}
            hoverKey={hoverKey}
            openChunk={openChunk}
            onHover={onHover}
            onPick={onPickHit}
          />
        </group>
      )}

      <gridHelper args={[WORLD_SIZE, 20, 0x2c2c2a, 0x1c1c22]} position={[0, -0.5, 0]} />

      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        minDistance={12}
        maxDistance={200}
        maxPolarAngle={Math.PI / 2.05}
        target={[0, 4, 0]}
      />
    </>
  );
}
