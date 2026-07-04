"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { LineBasicNodeMaterial } from "three/webgpu";
import { attribute, mix, positionLocal, vec3 } from "three/tsl";
import {
  COOL,
  RESULT_HOT,
  STEPS,
  WARM,
  type ArithResult,
  type Hit,
  type Trace,
} from "./engineBridge";
import { glowTexture, ringTexture, sampleField, toWorldXZ, type WorldData } from "./derive";
import { useWorld } from "./store";
import { HEIGHT_SCALE, uCalm, uMorph } from "./uniforms";
import { useAtlasStore } from "@/lib/atlas/store";

/**
 * The Interpolation Engine, in-world: the geodesic between two ideas becomes a
 * luminous arc bridging the landscape (cool → warm along its length), with a
 * beacon per retrieval waypoint, a probe that glides with the slider, and
 * light-shaft pings dropping onto the actual passages retrieved at the active
 * step. Arithmetic mode plants signed anchors and an echo-hot result marker.
 * All geometry carries both frames and morphs with the world.
 */

const ARC_SAMPLES = 140;

interface FramePoint {
  g: THREE.Vector3;
  s: THREE.Vector3;
}

function chunkFramePos(data: WorldData, idx: number): FramePoint {
  return {
    g: new THREE.Vector3(
      data.chunkGround[idx * 3],
      data.chunkGroundY[idx],
      data.chunkGround[idx * 3 + 2],
    ),
    s: new THREE.Vector3(
      data.chunkSpace[idx * 3],
      data.chunkSpace[idx * 3 + 1],
      data.chunkSpace[idx * 3 + 2],
    ),
  };
}

function hitsFrameCentroid(data: WorldData, hits: Hit[]): FramePoint | null {
  const g = new THREE.Vector3();
  const s = new THREE.Vector3();
  let w = 0;
  for (const h of hits) {
    if (h.chunkIdx < 0) continue;
    const wi = Math.max(0.01, h.score) ** 4;
    const p = chunkFramePos(data, h.chunkIdx);
    g.addScaledVector(p.g, wi);
    s.addScaledVector(p.s, wi);
    w += wi;
  }
  if (w <= 0) return null;
  g.divideScalar(w);
  s.divideScalar(w);
  return { g, s };
}

function groundAt(data: WorldData, x01: number, y01: number, lift = 0): THREE.Vector3 {
  const [x, z] = toWorldXZ(x01, y01);
  return new THREE.Vector3(
    x,
    sampleField(data.eras.final, x01, y01) * HEIGHT_SCALE + lift,
    z,
  );
}

/** Waypoints in both frames; missing space centroids are interpolated. */
function traceWaypoints(data: WorldData, trace: Trace): FramePoint[] {
  const pts: (FramePoint | null)[] = trace.steps.map((st) => {
    const c = hitsFrameCentroid(data, st.hits);
    if (c) {
      c.g.copy(groundAt(data, st.centroid2[0], st.centroid2[1]));
      return c;
    }
    return null;
  });
  // fill space gaps by linear interpolation between defined neighbors
  const defined = pts
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: FramePoint; i: number } => x.p !== null);
  if (!defined.length) return [];
  return pts.map((p, i) => {
    if (p) return p;
    const g = groundAt(data, trace.steps[i].centroid2[0], trace.steps[i].centroid2[1]);
    let lo = defined[0];
    let hi = defined[defined.length - 1];
    for (const d of defined) {
      if (d.i <= i) lo = d;
      if (d.i >= i) {
        hi = d;
        break;
      }
    }
    const t = hi.i === lo.i ? 0 : (i - lo.i) / (hi.i - lo.i);
    return { g, s: lo.p.s.clone().lerp(hi.p.s, t) };
  });
}

/** Build the two-frame arc geometry: lifted catmull-rom over the ground pts. */
function buildArc(way: FramePoint[]): {
  gCurve: THREE.CatmullRomCurve3;
  sCurve: THREE.CatmullRomCurve3;
  positions: Float32Array;
  spaces: Float32Array;
  colors: Float32Array;
} {
  const span = way[0].g.distanceTo(way[way.length - 1].g);
  const lifted = way.map((p, i) => {
    const t = i / (way.length - 1);
    return p.g
      .clone()
      .add(new THREE.Vector3(0, 3.5 + Math.sin(Math.PI * t) * (5 + span * 0.14), 0));
  });
  const gCurve = new THREE.CatmullRomCurve3(lifted, false, "centripetal", 0.6);
  const sCurve = new THREE.CatmullRomCurve3(
    way.map((p) => p.s),
    false,
    "centripetal",
    0.6,
  );
  const positions = new Float32Array((ARC_SAMPLES + 1) * 3);
  const spaces = new Float32Array((ARC_SAMPLES + 1) * 3);
  const colors = new Float32Array((ARC_SAMPLES + 1) * 3);
  const cool = new THREE.Color(COOL);
  const warm = new THREE.Color(WARM);
  const c = new THREE.Color();
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const t = i / ARC_SAMPLES;
    const gp = gCurve.getPoint(t);
    const sp = sCurve.getPoint(t);
    positions.set([gp.x, gp.y, gp.z], i * 3);
    spaces.set([sp.x, sp.y, sp.z], i * 3);
    c.copy(cool).lerp(warm, t).multiplyScalar(1.15);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  return { gCurve, sCurve, positions, spaces, colors };
}

function MorphStrip({
  positions,
  spaces,
  colors,
  opacity,
}: {
  positions: Float32Array;
  spaces: Float32Array;
  colors: Float32Array;
  opacity: number;
}) {
  const { line, geo, mat } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSpace", new THREE.BufferAttribute(spaces, 3));
    geo.setAttribute("aCol", new THREE.BufferAttribute(colors, 3));
    const mat = new LineBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.positionNode = mix(positionLocal, attribute<"vec3">("aSpace", "vec3"), uMorph);
    mat.colorNode = vec3(attribute<"vec3">("aCol", "vec3")).mul(uCalm.mul(1.25));
    mat.opacityNode = uCalm.mul(opacity);
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    return { line, geo, mat };
  }, [positions, spaces, colors, opacity]);
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  return <primitive object={line} />;
}

/* ---------------- pings on the retrieved passages ---------------- */

function HitPings({ data, hits, color }: { data: WorldData; hits: Hit[]; color: string }) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const group = useMemo(() => {
    const g = new THREE.Group();
    const glow = glowTexture();
    const ring = ringTexture();
    for (const h of hits) {
      if (h.chunkIdx < 0) continue;
      const shaft = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glow,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const rg = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: ring,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      shaft.userData = { idx: h.chunkIdx, score: h.score, kind: "shaft" };
      rg.userData = { idx: h.chunkIdx, score: h.score, kind: "ring" };
      shaft.material.color.set(color);
      rg.material.color.set(color);
      g.add(shaft, rg);
    }
    return g;
  }, [data, hits, color]);

  useEffect(
    () => () => {
      for (const s of group.children) (s as THREE.Sprite).material.dispose();
    },
    [group],
  );

  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    const m = uMorph.value;
    const t = state.clock.elapsedTime;
    for (const child of group.children) {
      const s = child as THREE.Sprite;
      const { idx, score, kind } = s.userData as {
        idx: number;
        score: number;
        kind: string;
      };
      tmp.set(
        THREE.MathUtils.lerp(data.chunkGround[idx * 3], data.chunkSpace[idx * 3], m),
        THREE.MathUtils.lerp(data.chunkGroundY[idx], data.chunkSpace[idx * 3 + 1], m),
        THREE.MathUtils.lerp(
          data.chunkGround[idx * 3 + 2],
          data.chunkSpace[idx * 3 + 2],
          m,
        ),
      );
      if (kind === "shaft") {
        s.position.set(tmp.x, tmp.y + 2.6 * (1 - m), tmp.z);
        s.scale.set(1.3, 6.5 * (1 - m) + 1.3, 1);
        s.material.opacity = (0.25 + score * 0.5) * boost;
      } else {
        s.position.copy(tmp);
        s.scale.setScalar(1.5 + score * 1.6 + 0.25 * Math.sin(t * 3 + idx));
        s.material.opacity = 0.35 + score * 0.5;
        s.material.rotation = t * 0.5;
      }
    }
  });

  return <primitive object={group} />;
}

/* ---------------- geodesic ---------------- */

function GeodesicArc({ data, trace }: { data: WorldData; trace: Trace }) {
  const traceT = useWorld((s) => s.traceT);
  const boost = useAtlasStore((s) => s.hdrBoost);

  const arc = useMemo(() => {
    const way = traceWaypoints(data, trace);
    if (way.length < 2) return null;
    return { ...buildArc(way), way };
  }, [data, trace]);

  const probe = useMemo(() => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    s.material.color.set("#ffffff");
    return s;
  }, []);
  useEffect(() => () => probe.material.dispose(), [probe]);

  const beacons = useMemo(() => {
    if (!arc) return null;
    const g = new THREE.Group();
    const cool = new THREE.Color(COOL);
    const warm = new THREE.Color(WARM);
    trace.steps.forEach((_, i) => {
      const t = i / (trace.steps.length - 1);
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture(),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      s.material.color.copy(cool).lerp(warm, t);
      s.userData = { t, i };
      g.add(s);
    });
    return g;
  }, [arc, trace]);
  useEffect(
    () => () => {
      if (beacons) for (const s of beacons.children) (s as THREE.Sprite).material.dispose();
    },
    [beacons],
  );

  const activeStep = Math.round(traceT * (STEPS - 1));
  const activeHits = trace.steps[activeStep]?.hits ?? [];

  useFrame((state) => {
    if (!arc || !beacons) return;
    const m = uMorph.value;
    const t = state.clock.elapsedTime;
    const gp = arc.gCurve.getPoint(traceT);
    const sp = arc.sCurve.getPoint(traceT);
    probe.position.lerpVectors(gp, sp, m);
    probe.scale.setScalar(2.6 * (1 + 0.12 * Math.sin(t * 6)));
    probe.material.opacity = 0.95 * boost;

    beacons.children.forEach((child, i) => {
      const s = child as THREE.Sprite;
      const bt = (s.userData as { t: number }).t;
      const bg = arc.gCurve.getPoint(bt);
      const bs = arc.sCurve.getPoint(bt);
      s.position.lerpVectors(bg, bs, m);
      const active = i === activeStep;
      s.scale.setScalar(active ? 2.1 + 0.35 * Math.sin(t * 5) : 1.25);
      s.material.opacity = active ? 0.95 : 0.6;
    });
  });

  if (!arc || !beacons) return null;
  return (
    <group>
      <MorphStrip
        positions={arc.positions}
        spaces={arc.spaces}
        colors={arc.colors}
        opacity={0.85}
      />
      <primitive object={beacons} />
      <primitive object={probe} />
      <HitPings data={data} hits={activeHits} color={RESULT_HOT} />
    </group>
  );
}

/* ---------------- arithmetic ---------------- */

function ArithmeticMarks({ data, arith }: { data: WorldData; arith: ArithResult }) {
  const anchors = useMemo(
    () =>
      arith.anchors.map((a) => ({
        ...a,
        pos: groundAt(data, a.pos2[0], a.pos2[1], 3.2),
      })),
    [data, arith],
  );

  const group = useMemo(() => {
    const g = new THREE.Group();
    for (const a of anchors) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture(),
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      s.material.color.set(a.color);
      s.position.copy(a.pos);
      s.scale.setScalar(3.2);
      g.add(s);
    }
    return g;
  }, [anchors]);
  useEffect(
    () => () => {
      for (const s of group.children) (s as THREE.Sprite).material.dispose();
    },
    [group],
  );

  useFrame(() => {
    group.visible = uMorph.value < 0.9;
    const o = 1 - uMorph.value;
    for (const s of group.children) ((s as THREE.Sprite).material).opacity = 0.75 * o;
  });

  return (
    <group>
      <primitive object={group} />
      <HitPings data={data} hits={arith.hits} color={RESULT_HOT} />
    </group>
  );
}

export default function ArcLayer({ data }: { data: WorldData }) {
  const trace = useWorld((s) => s.trace);
  const arith = useWorld((s) => s.arith);
  return (
    <group>
      {trace && <GeodesicArc data={data} trace={trace} />}
      {arith && <ArithmeticMarks data={data} arith={arith} />}
    </group>
  );
}
