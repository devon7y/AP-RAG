"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { WORLD_SIZE } from "@/lib/atlas/data";
import { useAtlasStore } from "@/lib/atlas/store";
import { glowTexture, ringTexture, sampleField, type WorldData } from "./derive";
import { paperWorldPos } from "./PaperBeacons";
import { useWorld } from "./store";
import { HEIGHT_SCALE, uMorph } from "./uniforms";

/**
 * The Boeing 747 — a pilotable jumbo jet over the landscape. Spawned from the
 * flight instrument, steered with WASD/arrows, throttled with Shift/Ctrl.
 * Terrain contact ends the flight in a fireball, and the crash opens the
 * nearest paper's card exactly as clicking its beacon would — literature
 * review by air disaster.
 *
 * Two airframes share one transform: a procedural jet (capsules, extruded
 * airfoils, nacelle cylinders — zero network weight) flies immediately, and a
 * real scan ("Boeing 747-400" by Jonne Okkonen, CC BY-SA 4.0, meshopt-
 * compressed to 3.4 MB) streams in lazily on first take-off and replaces the
 * procedural hull. The GLB is pre-baked: centered, nose +Z, length 8.6 model
 * units — same frame as the procedural jet. While parked, nothing renders and
 * nothing downloads.
 */

const REAL_747_URL = "/models/boeing747.glb";

export interface PlanePose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/* ---------------- flight constants ---------------- */

const SCALE = 0.5; // model units → world units
const SPEED_MIN = 6;
const SPEED_MAX = 26;
const TURN_RATE = 1.1; // rad/s at full bank
const PITCH_RATE = 1.25;
const PITCH_MAX = 0.85;
const BANK_MAX = 0.55;
const CEILING = 58;
const BOUND = 72; // beyond this radius the jet is steered home
const TRAIL_N = 90;

/* ---------------- the airframe ---------------- */

const BODY = "#dfe5ec";
const WING = "#c9d0da";
const NACELLE = "#aab3c0";
const DARK = "#10151d";
const ACCENT = "#3987e5";

function airfoil(
  pts: [number, number][],
  thickness: number,
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 1,
  });
}

interface Airframe {
  group: THREE.Group;
  /** the procedural solid meshes — hidden when the real GLB arrives */
  hull: THREE.Group;
  disposables: (THREE.BufferGeometry | THREE.Material)[];
  engineGlows: THREE.Sprite[];
  navLeft: THREE.Sprite;
  navRight: THREE.Sprite;
  strobe: THREE.Sprite;
}

function build747(): Airframe {
  const group = new THREE.Group();
  const hull = new THREE.Group();
  group.add(hull);
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  const mat = (color: string, metalness = 0.4, roughness = 0.4) => {
    const m = new MeshStandardNodeMaterial();
    m.color = new THREE.Color(color);
    m.metalness = metalness;
    m.roughness = roughness;
    m.side = THREE.DoubleSide;
    disposables.push(m);
    return m;
  };
  const bodyMat = mat(BODY, 0.35, 0.35);
  const wingMat = mat(WING, 0.45, 0.45);
  const nacelleMat = mat(NACELLE, 0.6, 0.35);
  const darkMat = mat(DARK, 0.2, 0.6);
  const accentMat = mat(ACCENT, 0.3, 0.45);

  const add = (geo: THREE.BufferGeometry, m: THREE.Material) => {
    disposables.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    hull.add(mesh);
    return mesh;
  };

  // fuselage — nose toward +Z
  const fuselage = new THREE.CapsuleGeometry(0.55, 7.4, 8, 24);
  fuselage.rotateX(Math.PI / 2);
  add(fuselage, bodyMat);

  // the 747's upper-deck hump
  const hump = new THREE.CapsuleGeometry(0.34, 2.0, 6, 16);
  hump.rotateX(Math.PI / 2);
  add(hump, bodyMat).position.set(0, 0.42, 2.0);

  // cockpit glass under the hump's brow
  const cockpit = new THREE.SphereGeometry(0.3, 16, 12);
  const cp = add(cockpit, darkMat);
  cp.position.set(0, 0.3, 3.45);
  cp.scale.set(1, 0.6, 0.9);

  // cabin window stripes
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.04, 0.1, 6.2), darkMat).position.set(
      sx * 0.55,
      0.1,
      -0.2,
    );
  }

  // main wings — swept, tapered, slight dihedral (shape XY → XZ via rotateX)
  // shape: x = span outward, y maps to -Z after rotation (sweep goes aft)
  const wingShape: [number, number][] = [
    [0.5, -0.95],
    [3.6, 1.0],
    [3.6, 1.55],
    [0.5, 0.95],
  ];
  const wingR = airfoil(wingShape, 0.07);
  wingR.rotateX(-Math.PI / 2);
  const wingL = wingR.clone();
  wingL.scale(-1, 1, 1);
  const wr = add(wingR, wingMat);
  wr.position.set(0, -0.18, 0.4);
  wr.rotation.z = -0.07;
  const wl = add(wingL, wingMat);
  wl.position.set(0, -0.18, 0.4);
  wl.rotation.z = 0.07;

  // horizontal stabilizers
  const stabShape: [number, number][] = [
    [0.2, -0.5],
    [1.5, 0.35],
    [1.5, 0.7],
    [0.2, 0.45],
  ];
  const stabR = airfoil(stabShape, 0.05);
  stabR.rotateX(-Math.PI / 2);
  const stabL = stabR.clone();
  stabL.scale(-1, 1, 1);
  add(stabR, wingMat).position.set(0, 0.15, -3.45);
  add(stabL, wingMat).position.set(0, 0.15, -3.45);

  // vertical fin — the accent-blue tail
  const finShape: [number, number][] = [
    [-0.7, 0],
    [0.9, 0],
    [1.35, 1.5],
    [0.55, 1.5],
  ];
  const fin = airfoil(finShape, 0.06);
  fin.rotateY(Math.PI / 2);
  add(fin, accentMat).position.set(0, 0.35, -3.55 + 0.7);

  // four engines, hung under the wings on pylons
  const engineGlows: THREE.Sprite[] = [];
  const glow = glowTexture();
  const enginePos: [number, number][] = [
    [1.25, 0.35],
    [2.35, -0.35],
  ];
  for (const sx of [-1, 1]) {
    for (const [ex, ez] of enginePos) {
      const nacelle = new THREE.CylinderGeometry(0.21, 0.19, 0.95, 16);
      nacelle.rotateX(Math.PI / 2);
      add(nacelle, nacelleMat).position.set(sx * ex, -0.52, ez);
      const intake = new THREE.CylinderGeometry(0.215, 0.215, 0.08, 16);
      intake.rotateX(Math.PI / 2);
      add(intake, darkMat).position.set(sx * ex, -0.52, ez + 0.46);
      add(new THREE.BoxGeometry(0.06, 0.3, 0.5), wingMat).position.set(
        sx * ex,
        -0.32,
        ez + 0.1,
      );
      // exhaust glow, brightening with throttle
      const gm = new THREE.SpriteMaterial({
        map: glow,
        color: "#ffb36b",
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      disposables.push(gm);
      const gs = new THREE.Sprite(gm);
      gs.position.set(sx * ex, -0.52, ez - 0.55);
      gs.scale.setScalar(0.55);
      group.add(gs);
      engineGlows.push(gs);
    }
  }

  // navigation lights: red port, green starboard, white tail strobe
  const navSprite = (color: string, x: number, y: number, z: number) => {
    const m = new THREE.SpriteMaterial({
      map: glow,
      color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    disposables.push(m);
    const s = new THREE.Sprite(m);
    s.position.set(x, y, z);
    s.scale.setScalar(0.5);
    group.add(s);
    return s;
  };
  const navLeft = navSprite("#ff4d4d", -3.6, -0.18, -1.15);
  const navRight = navSprite("#4dff7a", 3.6, -0.18, -1.15);
  const strobe = navSprite("#ffffff", 0, 1.9, -2.95);

  group.scale.setScalar(SCALE);
  group.rotation.order = "YXZ";
  group.visible = false;
  return { group, hull, disposables, engineGlows, navLeft, navRight, strobe };
}

/* ---------------- the explosion ---------------- */

const DEBRIS_N = 150;

interface Explosion {
  group: THREE.Group;
  points: THREE.Points;
  posAttr: THREE.BufferAttribute;
  vels: Float32Array;
  fireCore: THREE.Sprite;
  fireMid: THREE.Sprite;
  fireOuter: THREE.Sprite;
  ring: THREE.Sprite;
  flash: THREE.Sprite;
  disposables: (THREE.BufferGeometry | THREE.Material)[];
}

function buildExplosion(): Explosion {
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const group = new THREE.Group();
  group.visible = false;

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(
    new Float32Array(DEBRIS_N * 3),
    3,
  ).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posAttr);
  const colors = new Float32Array(DEBRIS_N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < DEBRIS_N; i++) {
    const t = i / DEBRIS_N;
    if (t < 0.25) c.setRGB(1.5, 1.35, 1.05); // white-hot
    else if (t < 0.65) c.setRGB(1.6, 0.7, 0.2); // orange
    else c.setRGB(1.2, 0.28, 0.08); // ember red
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const pMat = new THREE.PointsMaterial({
    map: glowTexture(),
    size: 0.9,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  disposables.push(geo, pMat);
  const points = new THREE.Points(geo, pMat);
  points.frustumCulled = false;
  group.add(points);

  const sprite = (color: string) => {
    const m = new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    disposables.push(m);
    const s = new THREE.Sprite(m);
    group.add(s);
    return s;
  };
  const fireCore = sprite("#fff4d8");
  const fireMid = sprite("#ff9a3d");
  const fireOuter = sprite("#ff5a1f");
  const flash = sprite("#ffffff");

  const ringMat = new THREE.SpriteMaterial({
    map: ringTexture(),
    color: "#ffb36b",
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  disposables.push(ringMat);
  const ring = new THREE.Sprite(ringMat);
  group.add(ring);

  return {
    group,
    points,
    posAttr,
    vels: new Float32Array(DEBRIS_N * 3),
    fireCore,
    fireMid,
    fireOuter,
    ring,
    flash,
    disposables,
  };
}

/* ---------------- trails ---------------- */

function makeTrail(): {
  geo: THREE.BufferGeometry;
  line: THREE.Line;
  pts: number[];
} {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3).setUsage(
      THREE.DynamicDrawUsage,
    ),
  );
  geo.setDrawRange(0, 0);
  const line = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({
      color: "#bcd2ff",
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  line.frustumCulled = false;
  return { geo, line, pts: [] };
}

/* ---------------- helpers ---------------- */

function groundHeightAt(data: WorldData, x: number, z: number): number {
  const x01 = x / WORLD_SIZE + 0.5;
  const y01 = z / WORLD_SIZE + 0.5;
  if (x01 < 0 || x01 > 1 || y01 < 0 || y01 > 1) return 0;
  return sampleField(data.eras.final, x01, y01) * HEIGHT_SCALE;
}

function nearestPaper(data: WorldData, p: THREE.Vector3): number {
  let best = 0;
  let bd = Number.POSITIVE_INFINITY;
  for (let i = 0; i < data.nPapers; i++) {
    const dx = data.paperGround[i * 3] - p.x;
    const dy = data.paperGroundY[i] - p.y;
    const dz = data.paperGround[i * 3 + 2] - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/* ---------------- the layer ---------------- */

export default function PlaneLayer({
  data,
  poseRef,
}: {
  data: WorldData;
  poseRef: { current: PlanePose | null };
}) {
  const planeOn = useWorld((s) => s.planeOn);
  const camera = useThree((s) => s.camera);
  const boost = useAtlasStore((s) => s.hdrBoost);

  const airframe = useMemo(build747, []);
  const explosion = useMemo(buildExplosion, []);
  const trailL = useMemo(makeTrail, []);
  const trailR = useMemo(makeTrail, []);

  // flight state — refs, never React state (per-frame)
  const mode = useRef<"flying" | "exploding" | null>(null);
  const yaw = useRef(0);
  const pitch = useRef(0);
  const roll = useRef(0);
  const speed = useRef(12);
  const throttle = useRef(0.5);
  const keys = useRef<Set<string>>(new Set());
  const explodeT = useRef(0);
  const crashGroundY = useRef(0);
  const timeouts = useRef<number[]>([]);
  const pose = useMemo<PlanePose>(
    () => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion() }),
    [],
  );
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);

  // spawn / despawn
  useEffect(() => {
    if (planeOn) {
      camera.getWorldDirection(fwd);
      yaw.current = Math.atan2(fwd.x, fwd.z);
      pitch.current = 0;
      roll.current = 0;
      throttle.current = 0.5;
      speed.current = 12;
      const g = airframe.group;
      g.position.copy(camera.position).addScaledVector(fwd, 24);
      g.position.x = THREE.MathUtils.clamp(g.position.x, -55, 55);
      g.position.z = THREE.MathUtils.clamp(g.position.z, -55, 55);
      const floor = groundHeightAt(data, g.position.x, g.position.z) + 14;
      g.position.y = THREE.MathUtils.clamp(
        g.position.y,
        Math.max(floor, 16),
        44,
      );
      g.rotation.set(0, yaw.current, 0);
      g.visible = true;
      trailL.pts.length = 0;
      trailR.pts.length = 0;
      trailL.geo.setDrawRange(0, 0);
      trailR.geo.setDrawRange(0, 0);
      mode.current = "flying";
    } else if (mode.current === "flying") {
      // ejected mid-air (panel toggle / Esc) — vanish without the fireball
      airframe.group.visible = false;
      mode.current = null;
      poseRef.current = null;
      trailL.pts.length = 0;
      trailR.pts.length = 0;
      trailL.geo.setDrawRange(0, 0);
      trailR.geo.setDrawRange(0, 0);
    }
  }, [planeOn, airframe, camera, data, fwd, trailL, trailR, poseRef]);

  // the real 747 — streamed in once, on the first take-off, so the page's
  // initial load never pays for it; the procedural jet flies until it lands
  const realJet = useRef<THREE.Group | null>(null);
  const loadState = useRef<"idle" | "loading" | "done" | "failed">("idle");
  useEffect(() => {
    if (!planeOn || loadState.current !== "idle") return;
    loadState.current = "loading";
    (async () => {
      try {
        const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
          import("three/examples/jsm/loaders/GLTFLoader.js"),
          import("three/examples/jsm/libs/meshopt_decoder.module.js"),
        ]);
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(REAL_747_URL);
        realJet.current = gltf.scene;
        airframe.group.add(gltf.scene);
        airframe.hull.visible = false; // the stand-in retires; lights stay on
        loadState.current = "done";
      } catch {
        loadState.current = "failed"; // procedural jet keeps flying
      }
    })();
  }, [planeOn, airframe]);

  // controls — captured only while the jet exists, never while typing
  useEffect(() => {
    if (!planeOn) return;
    const ks = keys.current;
    const RELEVANT = new Set([
      "w", "a", "s", "d",
      "arrowup", "arrowdown", "arrowleft", "arrowright",
      "shift", "control",
    ]);
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return (
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      );
    };
    const onDown = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (!RELEVANT.has(k)) return;
      ks.add(k);
      if (k.startsWith("arrow")) e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => ks.delete(e.key.toLowerCase());
    const onBlur = () => ks.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      ks.clear();
    };
  }, [planeOn]);

  // cleanup on unmount
  useEffect(
    () => () => {
      for (const id of timeouts.current) window.clearTimeout(id);
      for (const d of airframe.disposables) d.dispose();
      for (const d of explosion.disposables) d.dispose();
      realJet.current?.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          for (const mat of Array.isArray(m) ? m : [m]) mat.dispose();
        }
      });
      trailL.geo.dispose();
      (trailL.line.material as THREE.Material).dispose();
      trailR.geo.dispose();
      (trailR.line.material as THREE.Material).dispose();
    },
    [airframe, explosion, trailL, trailR],
  );

  const crash = () => {
    const st = useWorld.getState();
    const g = airframe.group;
    mode.current = "exploding";
    explodeT.current = 0;
    poseRef.current = null;

    const gy = groundHeightAt(data, g.position.x, g.position.z);
    crashGroundY.current = Math.max(gy, 0);
    g.position.y = crashGroundY.current + 0.5;

    // seed debris: the jet's momentum plus a hot radial burst
    fwd.set(
      Math.sin(yaw.current) * Math.cos(pitch.current),
      Math.sin(pitch.current),
      Math.cos(yaw.current) * Math.cos(pitch.current),
    );
    const pa = explosion.posAttr.array as Float32Array;
    for (let i = 0; i < DEBRIS_N; i++) {
      pa[i * 3] = g.position.x;
      pa[i * 3 + 1] = g.position.y + 0.3;
      pa[i * 3 + 2] = g.position.z;
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s2 = Math.sqrt(1 - u * u);
      const burst = 3.5 + Math.random() * 7;
      explosion.vels[i * 3] =
        s2 * Math.cos(th) * burst + fwd.x * speed.current * 0.3;
      explosion.vels[i * 3 + 1] =
        Math.abs(u) * burst + 2.5 + Math.random() * 5;
      explosion.vels[i * 3 + 2] =
        s2 * Math.sin(th) * burst + fwd.z * speed.current * 0.3;
    }
    explosion.posAttr.needsUpdate = true;
    explosion.group.position.set(0, 0, 0);
    const at = (s: THREE.Sprite, lift: number) =>
      s.position.set(g.position.x, g.position.y + lift, g.position.z);
    at(explosion.fireCore, 0.8);
    at(explosion.fireMid, 1.2);
    at(explosion.fireOuter, 1.6);
    at(explosion.ring, 0.4);
    at(explosion.flash, 1.0);
    explosion.group.visible = true;
    g.visible = false;
    trailL.pts.length = 0;
    trailR.pts.length = 0;
    trailL.geo.setDrawRange(0, 0);
    trailR.geo.setDrawRange(0, 0);

    // the payoff: the crash opens the nearest paper, exactly like clicking
    // its beacon, then the camera flies over to frame it
    const idx = nearestPaper(data, g.position);
    st.set("planeOn", false);
    timeouts.current.push(
      window.setTimeout(() => {
        useWorld.getState().select({ kind: "paper", idx });
      }, 600),
      window.setTimeout(() => {
        paperWorldPos(data, idx, uMorph.value, tmp);
        useWorld
          .getState()
          .requestWarp(
            [tmp.x, tmp.y, tmp.z],
            9 + data.paperSize[idx] * 2,
            1.8,
          );
      }, 1700),
    );
  };

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const g = airframe.group;

    /* ---- explosion playback (independent of planeOn) ---- */
    if (mode.current === "exploding") {
      explodeT.current += dt;
      const e = explodeT.current;
      const pa = explosion.posAttr.array as Float32Array;
      const vs = explosion.vels;
      const floor = crashGroundY.current + 0.06;
      for (let i = 0; i < DEBRIS_N; i++) {
        vs[i * 3 + 1] -= 12 * dt;
        pa[i * 3] += vs[i * 3] * dt;
        pa[i * 3 + 1] += vs[i * 3 + 1] * dt;
        pa[i * 3 + 2] += vs[i * 3 + 2] * dt;
        if (pa[i * 3 + 1] < floor) {
          pa[i * 3 + 1] = floor;
          vs[i * 3 + 1] *= -0.3;
          vs[i * 3] *= 0.6;
          vs[i * 3 + 2] *= 0.6;
        }
      }
      explosion.posAttr.needsUpdate = true;
      (explosion.points.material as THREE.PointsMaterial).opacity =
        Math.max(0, 1 - e / 2.1) * boost;

      const ease = 1 - Math.exp(-3.2 * e);
      const fade = (life: number) => Math.max(0, 1 - e / life);
      explosion.fireCore.scale.setScalar(2 + 7 * ease);
      explosion.fireCore.material.opacity = fade(0.8) * boost;
      explosion.fireMid.scale.setScalar(3 + 11 * ease);
      explosion.fireMid.material.opacity = fade(1.2) * 0.85 * boost;
      explosion.fireOuter.scale.setScalar(4 + 15 * ease);
      explosion.fireOuter.material.opacity = fade(1.6) * 0.6 * boost;
      explosion.ring.scale.setScalar(1 + 26 * Math.min(1, e / 0.9));
      explosion.ring.material.opacity = fade(0.9) * 0.7 * boost;
      explosion.flash.scale.setScalar(24);
      explosion.flash.material.opacity = fade(0.15) * boost;

      if (e > 2.3) {
        explosion.group.visible = false;
        mode.current = null;
      }
      return;
    }

    if (mode.current !== "flying") return;

    /* ---- read the stick ---- */
    const ks = keys.current;
    const turn =
      (ks.has("a") || ks.has("arrowleft") ? 1 : 0) -
      (ks.has("d") || ks.has("arrowright") ? 1 : 0);
    const pit =
      (ks.has("w") || ks.has("arrowup") ? 1 : 0) -
      (ks.has("s") || ks.has("arrowdown") ? 1 : 0);
    const thr = (ks.has("shift") ? 1 : 0) - (ks.has("control") ? 1 : 0);

    throttle.current = THREE.MathUtils.clamp(
      throttle.current + thr * 0.55 * dt,
      0,
      1,
    );
    pitch.current = THREE.MathUtils.clamp(
      pitch.current + pit * PITCH_RATE * dt,
      -PITCH_MAX,
      PITCH_MAX,
    );
    if (!pit) pitch.current *= Math.max(0, 1 - 1.1 * dt); // gentle auto-level
    roll.current +=
      (-turn * BANK_MAX - roll.current) * Math.min(1, 6 * dt);
    yaw.current +=
      turn * TURN_RATE * dt * (0.4 + 0.6 * Math.min(1, speed.current / 16));

    /* ---- fly ---- */
    const target = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * throttle.current;
    speed.current += (target - speed.current) * Math.min(1, 0.8 * dt);
    speed.current = THREE.MathUtils.clamp(
      speed.current - pitch.current * 7 * dt, // dives gain speed, climbs bleed it
      4,
      34,
    );
    fwd.set(
      Math.sin(yaw.current) * Math.cos(pitch.current),
      Math.sin(pitch.current),
      Math.cos(yaw.current) * Math.cos(pitch.current),
    );
    g.position.addScaledVector(fwd, speed.current * dt);

    // ceiling + steer home past the map's edge
    if (g.position.y > CEILING) {
      g.position.y = CEILING;
      pitch.current = Math.min(pitch.current, 0);
    }
    const r = Math.hypot(g.position.x, g.position.z);
    if (r > BOUND) {
      const home = Math.atan2(-g.position.x, -g.position.z);
      const d = wrapAngle(home - yaw.current);
      yaw.current +=
        THREE.MathUtils.clamp(d, -1, 1) *
        Math.min(1, (r - BOUND) / 16) *
        1.8 *
        dt;
      if (r > BOUND + 22) {
        g.position.x *= (BOUND + 22) / r;
        g.position.z *= (BOUND + 22) / r;
      }
    }

    g.rotation.set(-pitch.current, yaw.current, roll.current);
    pose.pos.copy(g.position);
    pose.quat.copy(g.quaternion);
    poseRef.current = pose;

    /* ---- terrain contact (only while the world is a landscape) ---- */
    if (uMorph.value < 0.5) {
      const gy = Math.max(groundHeightAt(data, g.position.x, g.position.z), 0);
      if (g.position.y <= gy + 0.9) {
        crash();
        return;
      }
    }

    /* ---- dressing: strobes, exhaust, contrails ---- */
    const phase = t % 1.2;
    airframe.navLeft.material.opacity = (phase < 0.12 ? 0.9 : 0.25) * boost;
    airframe.navRight.material.opacity = (phase < 0.12 ? 0.9 : 0.25) * boost;
    airframe.strobe.material.opacity =
      (phase > 0.55 && phase < 0.63 ? 1 : 0.08) * boost;
    for (const gs of airframe.engineGlows) {
      gs.material.opacity = (0.12 + 0.6 * throttle.current) * boost;
    }

    for (const [trail, sx] of [
      [trailL, -3.6],
      [trailR, 3.6],
    ] as const) {
      tmp.set(sx, -0.18, -1.3);
      g.localToWorld(tmp);
      trail.pts.push(tmp.x, tmp.y, tmp.z);
      if (trail.pts.length > TRAIL_N * 3) trail.pts.splice(0, 3);
      const attr = trail.geo.getAttribute("position") as THREE.BufferAttribute;
      (attr.array as Float32Array).set(trail.pts);
      attr.needsUpdate = true;
      trail.geo.setDrawRange(0, trail.pts.length / 3);
    }
  });

  return (
    <group>
      {planeOn && (
        <>
          <ambientLight intensity={0.55} />
          <directionalLight position={[30, 60, 20]} intensity={2.6} />
        </>
      )}
      <primitive object={airframe.group} />
      <primitive object={trailL.line} />
      <primitive object={trailR.line} />
      <primitive object={explosion.group} />
    </group>
  );
}
