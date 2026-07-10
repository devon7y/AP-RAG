"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import {
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import { mix, positionLocal, smoothstep, vec3 } from "three/tsl";
import { WORLD_SIZE } from "@/lib/atlas/data";
import { useAtlasStore } from "@/lib/atlas/store";
import { glowTexture, ringTexture, sampleField, type WorldData } from "./derive";
import { paperWorldPos } from "./PaperBeacons";
import {
  playExplosion,
  startEngine,
  type EngineSound,
} from "./planeAudio";
import { useWorld } from "./store";
import { HEIGHT_SCALE, uMorph } from "./uniforms";

/**
 * The Boeing 747 — a pilotable jumbo over the landscape. It spawns on the
 * home camera ring at a random azimuth, flies heavy (it is a 747), and ends
 * every story one of two ways: an eject, or a fireball on a mountainside
 * that opens the nearest paper's card exactly as clicking its beacon would.
 *
 * Two airframes share one transform: a tiny procedural jet flies instantly,
 * and the real scan ("Boeing 747-400" by Jonne Okkonen, CC BY-SA 4.0,
 * meshopt-compressed to 3.4 MB, PCA-aligned nose-+Z and rescaled at bake
 * time) streams in on the first take-off and replaces the procedural hull,
 * wearing a procedural livery (no UVs in the scan — the paint is banded in
 * model space). While parked, nothing renders and nothing downloads.
 */

const REAL_747_URL = "/models/boeing747.glb";

/* ---------------- flight constants ---------------- */

const SCALE = 0.12; // model units → world units (≈1-unit jet: the world reads vast)
const SPEED_MIN = 4;
const SPEED_MAX = 15;
const TURN_RATE = 0.5; // rad/s at full bank — ponderous, like 390 tonnes
const PITCH_RATE = 0.5;
const PITCH_MAX = 0.55;
const BANK_MAX = 0.42;
const CEILING = 55;
const BOUND = 84; // beyond this radius the jet is steered home
const SPAWN_RADIUS = 92; // the home orbit ring
const SPAWN_ALT = 34;
const TRAIL_N = 110;

/** Chase-cam offsets (world units) — right on the tail, so the jet fills the
 *  frame and the landscape reads enormous. CameraRig shares these. */
export const CHASE = { back: 1.7, up: 0.5, ahead: 1.15 };

/** Live cockpit readouts for the DOM HUD (written every frame, read by rAF —
 *  deliberately outside React state). Display units: 1 world unit ≈ 34 m,
 *  fudged into round aviation numbers. */
export const planeTelemetry = {
  active: false,
  kts: 0,
  altFt: 0,
  aglFt: 0,
  vsFpm: 0,
  heading: 0,
  pitchDeg: 0,
  rollDeg: 0,
  throttle: 0,
};

export interface PlanePose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/* ---------------- the procedural stand-in airframe ---------------- */

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
  const navLeft = navSprite("#ff4d4d", -3.85, -0.12, -1.05);
  const navRight = navSprite("#4dff7a", 3.85, -0.12, -1.05);
  const strobe = navSprite("#ffffff", 0, 1.9, -2.95);

  group.scale.setScalar(SCALE);
  group.rotation.order = "YXZ";
  group.visible = false;
  return { group, hull, disposables, engineGlows, navLeft, navRight, strobe };
}

/* ---------------- livery for the real jet (the scan has no UVs) ---------- */

function applyLivery(
  root: THREE.Group,
  disposables: (THREE.BufferGeometry | THREE.Material)[],
): void {
  const body = new MeshPhysicalNodeMaterial();
  body.metalness = 0.32;
  body.roughness = 0.3;
  body.clearcoat = 0.55;
  body.clearcoatRoughness = 0.3;
  body.side = THREE.DoubleSide;
  {
    // banded paint in baked model space: silver belly, blue cheatline along
    // the window line, white crown, blue tail fin (all ascending smoothsteps
    // — WGSL requires low < high)
    const white = vec3(0.93, 0.94, 0.97);
    const belly = vec3(0.55, 0.6, 0.68);
    const blue = vec3(0.12, 0.32, 0.7);
    const y = positionLocal.y;
    const z = positionLocal.z;
    const bellyMask = smoothstep(-0.26, -0.14, y).oneMinus();
    const cheatMask = smoothstep(-0.3, -0.2, y).mul(
      smoothstep(-0.04, 0.04, y).oneMinus(),
    );
    const finMask = smoothstep(-3.6, -2.8, z)
      .oneMinus()
      .mul(smoothstep(0.28, 0.55, y));
    body.colorNode = mix(
      mix(mix(white, belly, bellyMask), blue, cheatMask),
      blue,
      finMask,
    );
  }

  const engines = new MeshStandardNodeMaterial();
  engines.color = new THREE.Color("#3f454f");
  engines.metalness = 0.85;
  engines.roughness = 0.32;
  engines.side = THREE.DoubleSide;

  disposables.push(body, engines);

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const old = o.material as THREE.Material | THREE.Material[];
    const olds = Array.isArray(old) ? old : [old];
    const isEngine = olds.some((m) => /engine/i.test(m.name ?? ""));
    o.material = isEngine ? engines : body;
    for (const m of olds) m.dispose();
  });
}

/* ---------------- the crash ---------------- */

const DEBRIS_N = 240;
const SMOKE_N = 16;
const FIRE_N = 9;
const FIRE_COLORS = ["#fff3d0", "#ffab45", "#ff6a22"];
const EXPLOSION_LIFE = 10;

let smokeTex: THREE.CanvasTexture | null = null;
function smokeTexture(): THREE.CanvasTexture {
  if (smokeTex) return smokeTex;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g2 = canvas.getContext("2d")!;
  const grad = g2.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, "rgba(58,50,42,0.85)");
  grad.addColorStop(0.45, "rgba(36,31,26,0.5)");
  grad.addColorStop(1, "rgba(20,17,14,0)");
  g2.fillStyle = grad;
  g2.fillRect(0, 0, size, size);
  smokeTex = new THREE.CanvasTexture(canvas);
  return smokeTex;
}

interface Explosion {
  group: THREE.Group;
  points: THREE.Points;
  posAttr: THREE.BufferAttribute;
  vels: Float32Array;
  smoke: THREE.Sprite[];
  smokeVel: Float32Array;
  smokeAge: Float32Array;
  smokeLife: Float32Array;
  smokeScale0: Float32Array;
  fire: THREE.Sprite[];
  fireVel: Float32Array;
  fireAge: Float32Array;
  fireLife: Float32Array;
  fireScale0: Float32Array;
  ring: THREE.Sprite;
  flash: THREE.Sprite;
  scorch: THREE.Mesh;
  disposables: (THREE.BufferGeometry | THREE.Material)[];
}

function buildExplosion(): Explosion {
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const group = new THREE.Group();
  group.visible = false;

  // white-hot → ember debris spray
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
    if (t < 0.22) c.setRGB(1.6, 1.45, 1.1);
    else if (t < 0.6) c.setRGB(1.7, 0.72, 0.2);
    else c.setRGB(1.25, 0.3, 0.08);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const pMat = new THREE.PointsMaterial({
    map: glowTexture(),
    size: 0.55,
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

  // billowing smoke column (normal blending — it must read DARK)
  const smoke: THREE.Sprite[] = [];
  for (let i = 0; i < SMOKE_N; i++) {
    const m = new THREE.SpriteMaterial({
      map: smokeTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    disposables.push(m);
    const s = new THREE.Sprite(m);
    s.visible = false;
    group.add(s);
    smoke.push(s);
  }

  // the fireball — a flickering cluster, not one perfect sphere
  const fire: THREE.Sprite[] = [];
  for (let i = 0; i < FIRE_N; i++) {
    const m = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: FIRE_COLORS[i % FIRE_COLORS.length],
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    disposables.push(m);
    const s = new THREE.Sprite(m);
    s.visible = false;
    group.add(s);
    fire.push(s);
  }

  const sprite = (map: THREE.Texture, color: string) => {
    const m = new THREE.SpriteMaterial({
      map,
      color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    disposables.push(m);
    const s = new THREE.Sprite(m);
    group.add(s);
    return s;
  };
  const flash = sprite(glowTexture(), "#ffffff");
  const ring = sprite(ringTexture(), "#ffb36b");

  // scorched ground where the jet died
  const scorchGeo = new THREE.CircleGeometry(1.8, 40);
  const scorchMat = new THREE.MeshBasicMaterial({
    color: 0x050403,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  disposables.push(scorchGeo, scorchMat);
  const scorch = new THREE.Mesh(scorchGeo, scorchMat);
  scorch.rotation.x = -Math.PI / 2;
  group.add(scorch);

  return {
    group,
    points,
    posAttr,
    vels: new Float32Array(DEBRIS_N * 3),
    smoke,
    smokeVel: new Float32Array(SMOKE_N * 3),
    smokeAge: new Float32Array(SMOKE_N),
    smokeLife: new Float32Array(SMOKE_N),
    smokeScale0: new Float32Array(SMOKE_N),
    fire,
    fireVel: new Float32Array(FIRE_N * 3),
    fireAge: new Float32Array(FIRE_N),
    fireLife: new Float32Array(FIRE_N),
    fireScale0: new Float32Array(FIRE_N),
    ring,
    flash,
    scorch,
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
      opacity: 0.22,
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
  const planeSound = useWorld((s) => s.planeSound);
  const camera = useThree((s) => s.camera);
  const boost = useAtlasStore((s) => s.hdrBoost);

  const airframe = useMemo(build747, []);
  const explosion = useMemo(buildExplosion, []);
  const trailL = useMemo(makeTrail, []);
  const trailR = useMemo(makeTrail, []);

  // flight state — refs, never React state (per-frame)
  const mode = useRef<"flying" | null>(null);
  const yaw = useRef(0);
  const pitch = useRef(0);
  const roll = useRef(0);
  const speed = useRef(9);
  const throttle = useRef(0.55);
  const keys = useRef<Set<string>>(new Set());
  const expActive = useRef(false);
  const expT = useRef(0);
  const crashGroundY = useRef(0);
  const timeouts = useRef<number[]>([]);
  const engine = useRef<EngineSound | null>(null);
  const lastY = useRef(0);
  const vsSmooth = useRef(0);
  const pose = useMemo<PlanePose>(
    () => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion() }),
    [],
  );
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);

  const clearTrails = () => {
    trailL.pts.length = 0;
    trailR.pts.length = 0;
    trailL.geo.setDrawRange(0, 0);
    trailR.geo.setDrawRange(0, 0);
  };

  // spawn / despawn
  useEffect(() => {
    if (planeOn) {
      const st = useWorld.getState();
      st.select(null); // a fresh flight closes whatever card was open

      // wheels-up from a random point on the home orbit ring, flying inward
      const az = Math.random() * Math.PI * 2;
      const g = airframe.group;
      g.position.set(
        Math.sin(az) * SPAWN_RADIUS,
        SPAWN_ALT,
        Math.cos(az) * SPAWN_RADIUS,
      );
      yaw.current = az + Math.PI; // toward the center of the world
      pitch.current = 0;
      roll.current = 0;
      throttle.current = 0.55;
      speed.current = 8;
      lastY.current = g.position.y;
      vsSmooth.current = 0;
      g.rotation.set(0, yaw.current, 0);
      g.visible = true;
      clearTrails();
      mode.current = "flying";

      // put the camera right on its tail so the jet reads big immediately
      if (st.planeFollow) {
        fwd.set(Math.sin(yaw.current), 0, Math.cos(yaw.current));
        camera.position
          .copy(g.position)
          .addScaledVector(fwd, -CHASE.back)
          .add(new THREE.Vector3(0, CHASE.up, 0));
      }
    } else if (mode.current === "flying") {
      // ejected mid-air (panel toggle / Esc) — vanish without the fireball
      airframe.group.visible = false;
      mode.current = null;
      poseRef.current = null;
      planeTelemetry.active = false;
      clearTrails();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planeOn, airframe, camera]);

  // engine sound — runs while flying and audible
  useEffect(() => {
    if (planeOn && planeSound) {
      engine.current = startEngine();
      return () => {
        engine.current?.stop();
        engine.current = null;
      };
    }
    return undefined;
  }, [planeOn, planeSound]);

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
        applyLivery(gltf.scene, airframe.disposables);
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
      "w", "a", "s", "d", "q", "e",
      "arrowup", "arrowdown", "arrowleft", "arrowright",
      " ", "shift",
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
      if (k.startsWith("arrow") || k === " ") e.preventDefault();
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
      trailL.geo.dispose();
      (trailL.line.material as THREE.Material).dispose();
      trailR.geo.dispose();
      (trailR.line.material as THREE.Material).dispose();
      realJet.current?.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      engine.current?.stop();
      planeTelemetry.active = false;
    },
    [airframe, explosion, trailL, trailR],
  );

  const crash = () => {
    const st = useWorld.getState();
    const g = airframe.group;
    mode.current = null;
    expActive.current = true;
    expT.current = 0;
    poseRef.current = null;
    planeTelemetry.active = false;

    const gy = groundHeightAt(data, g.position.x, g.position.z);
    crashGroundY.current = Math.max(gy, 0);
    g.position.y = crashGroundY.current + 0.2;
    const cp = g.position;

    // debris carries the jet's momentum plus a hot radial burst
    fwd.set(
      Math.sin(yaw.current) * Math.cos(pitch.current),
      Math.sin(pitch.current),
      Math.cos(yaw.current) * Math.cos(pitch.current),
    );
    const pa = explosion.posAttr.array as Float32Array;
    for (let i = 0; i < DEBRIS_N; i++) {
      pa[i * 3] = cp.x;
      pa[i * 3 + 1] = cp.y + 0.18;
      pa[i * 3 + 2] = cp.z;
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s2 = Math.sqrt(1 - u * u);
      const burst = 2.5 + Math.random() * 6;
      explosion.vels[i * 3] =
        s2 * Math.cos(th) * burst + fwd.x * speed.current * 0.6;
      explosion.vels[i * 3 + 1] = Math.abs(u) * burst + 2 + Math.random() * 5;
      explosion.vels[i * 3 + 2] =
        s2 * Math.sin(th) * burst + fwd.z * speed.current * 0.6;
    }
    explosion.posAttr.needsUpdate = true;

    // seed the fire cluster
    for (let i = 0; i < FIRE_N; i++) {
      const s = explosion.fire[i];
      s.position.set(
        cp.x + (Math.random() - 0.5) * 1.0,
        cp.y + 0.25 + Math.random() * 0.6,
        cp.z + (Math.random() - 0.5) * 1.0,
      );
      explosion.fireVel[i * 3] = (Math.random() - 0.5) * 0.5 + fwd.x * 1.0;
      explosion.fireVel[i * 3 + 1] = 0.5 + Math.random() * 0.9;
      explosion.fireVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5 + fwd.z * 1.0;
      explosion.fireAge[i] = -i * 0.035;
      explosion.fireLife[i] = 1.5 + Math.random() * 0.7;
      explosion.fireScale0[i] = 0.9 + Math.random() * 1.1;
      s.visible = false;
    }

    // seed the smoke column
    for (let i = 0; i < SMOKE_N; i++) {
      const s = explosion.smoke[i];
      s.position.set(
        cp.x + (Math.random() - 0.5) * 0.9,
        cp.y + 0.3 + Math.random() * 0.4,
        cp.z + (Math.random() - 0.5) * 0.9,
      );
      explosion.smokeVel[i * 3] = (Math.random() - 0.5) * 0.4;
      explosion.smokeVel[i * 3 + 1] = 0.45 + Math.random() * 0.7;
      explosion.smokeVel[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
      explosion.smokeAge[i] = -i * 0.12; // the column builds, puff by puff
      explosion.smokeLife[i] = 4.5 + Math.random() * 3;
      explosion.smokeScale0[i] = 0.7 + Math.random() * 0.8;
      s.visible = false;
    }

    explosion.flash.position.set(cp.x, cp.y + 0.55, cp.z);
    explosion.ring.position.set(cp.x, cp.y + 0.25, cp.z);
    explosion.scorch.position.set(cp.x, crashGroundY.current + 0.05, cp.z);
    (explosion.scorch.material as THREE.MeshBasicMaterial).opacity = 0;
    explosion.group.visible = true;
    g.visible = false;
    clearTrails();

    window.dispatchEvent(new CustomEvent("world:plane-crash"));
    if (st.planeSound) playExplosion();

    // the payoff: the crash opens the nearest paper, exactly like clicking
    // its beacon, then the camera flies over to frame it
    const idx = nearestPaper(data, cp);
    st.set("planeOn", false);
    timeouts.current.push(
      window.setTimeout(() => {
        useWorld.getState().select({ kind: "paper", idx });
      }, 600),
      window.setTimeout(() => {
        paperWorldPos(data, idx, uMorph.value, tmp);
        useWorld
          .getState()
          .requestWarp([tmp.x, tmp.y, tmp.z], 9 + data.paperSize[idx] * 2, 1.9);
      }, 1900),
    );
  };

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const g = airframe.group;

    /* ---- explosion playback (independent of the next flight) ---- */
    if (expActive.current) {
      expT.current += dt;
      const e = expT.current;
      const pa = explosion.posAttr.array as Float32Array;
      const vs = explosion.vels;
      const floor = crashGroundY.current + 0.05;
      for (let i = 0; i < DEBRIS_N; i++) {
        vs[i * 3 + 1] -= 9.5 * dt;
        pa[i * 3] += vs[i * 3] * dt;
        pa[i * 3 + 1] += vs[i * 3 + 1] * dt;
        pa[i * 3 + 2] += vs[i * 3 + 2] * dt;
        if (pa[i * 3 + 1] < floor) {
          pa[i * 3 + 1] = floor;
          vs[i * 3 + 1] *= -0.32;
          vs[i * 3] *= 0.55;
          vs[i * 3 + 2] *= 0.55;
        }
      }
      explosion.posAttr.needsUpdate = true;
      (explosion.points.material as THREE.PointsMaterial).opacity =
        Math.max(0, 1 - e / 2.6) * boost;

      for (let i = 0; i < FIRE_N; i++) {
        explosion.fireAge[i] += dt;
        const age = explosion.fireAge[i];
        const life = explosion.fireLife[i];
        const s = explosion.fire[i];
        if (age < 0 || age > life) {
          s.visible = false;
          continue;
        }
        s.visible = true;
        s.position.x += explosion.fireVel[i * 3] * dt;
        s.position.y += explosion.fireVel[i * 3 + 1] * dt;
        s.position.z += explosion.fireVel[i * 3 + 2] * dt;
        const grow = 1 - Math.exp(-3.5 * age);
        const shrink = 1 - 0.85 * Math.max(0, age / life - 0.55) / 0.45;
        const flicker = 0.72 + 0.28 * Math.sin(t * 17 + i * 2.4);
        s.scale.setScalar(
          explosion.fireScale0[i] * (0.4 + 2.6 * grow) * shrink,
        );
        s.material.opacity = (1 - age / life) * flicker * boost;
      }

      for (let i = 0; i < SMOKE_N; i++) {
        explosion.smokeAge[i] += dt;
        const age = explosion.smokeAge[i];
        const life = explosion.smokeLife[i];
        const s = explosion.smoke[i];
        if (age < 0 || age > life) {
          s.visible = false;
          continue;
        }
        s.visible = true;
        s.position.x += explosion.smokeVel[i * 3] * dt;
        s.position.y += explosion.smokeVel[i * 3 + 1] * dt;
        s.position.z += explosion.smokeVel[i * 3 + 2] * dt;
        s.material.rotation = i * 1.7 + age * 0.35 * (i % 2 ? 1 : -1);
        s.scale.setScalar(explosion.smokeScale0[i] + age * 0.8);
        s.material.opacity =
          Math.min(1, age * 2.5) * (1 - age / life) * 0.55;
      }

      const bump =
        e > 0.26 && e < 0.44 ? Math.sin((Math.PI * (e - 0.26)) / 0.18) : 0;
      explosion.flash.scale.setScalar(10);
      explosion.flash.material.opacity =
        (Math.max(0, 1 - e / 0.13) + 0.45 * bump) * boost;

      const rt = Math.min(1, e / 0.85);
      explosion.ring.scale.setScalar(1 + 16 * rt);
      explosion.ring.material.opacity = Math.pow(1 - rt, 1.5) * 0.8 * boost;

      (explosion.scorch.material as THREE.MeshBasicMaterial).opacity =
        Math.min(1, e * 2.5) * 0.7 * Math.max(0, 1 - e / EXPLOSION_LIFE);

      if (e > EXPLOSION_LIFE) {
        explosion.group.visible = false;
        expActive.current = false;
      }
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
    const rudder = (ks.has("q") ? 1 : 0) - (ks.has("e") ? 1 : 0);
    const thr = (ks.has(" ") ? 1 : 0) - (ks.has("shift") ? 1 : 0);

    // 390 tonnes: every response is slow and committed
    throttle.current = THREE.MathUtils.clamp(
      throttle.current + thr * 0.28 * dt,
      0,
      1,
    );
    pitch.current = THREE.MathUtils.clamp(
      pitch.current + pit * PITCH_RATE * dt,
      -PITCH_MAX,
      PITCH_MAX,
    );
    if (!pit) pitch.current *= Math.max(0, 1 - 0.35 * dt); // lazy auto-trim
    roll.current += (-turn * BANK_MAX - roll.current) * Math.min(1, 2.2 * dt);
    const agility = 0.5 + 0.5 * Math.min(1, speed.current / 12);
    yaw.current +=
      (-roll.current / BANK_MAX) * TURN_RATE * dt * agility +
      rudder * 0.4 * dt * agility; // Q/E — flat rudder yaw

    /* ---- fly ---- */
    const target = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * throttle.current;
    speed.current += (target - speed.current) * Math.min(1, 0.22 * dt);
    speed.current = THREE.MathUtils.clamp(
      speed.current - pitch.current * 4.5 * dt, // dives gain speed, climbs bleed it
      3,
      20,
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
        1.6 *
        dt;
      if (r > BOUND + 26) {
        g.position.x *= (BOUND + 26) / r;
        g.position.z *= (BOUND + 26) / r;
      }
    }

    g.rotation.set(-pitch.current, yaw.current, roll.current);
    pose.pos.copy(g.position);
    pose.quat.copy(g.quaternion);
    poseRef.current = pose;

    /* ---- terrain contact (only while the world is a landscape) ---- */
    const gy = Math.max(groundHeightAt(data, g.position.x, g.position.z), 0);
    if (uMorph.value < 0.5 && g.position.y <= gy + 0.15) {
      crash();
      return;
    }

    /* ---- cockpit telemetry for the HUD ---- */
    const vsRaw = ((g.position.y - lastY.current) / Math.max(dt, 1e-4)) * 112 * 60;
    lastY.current = g.position.y;
    vsSmooth.current += (vsRaw - vsSmooth.current) * Math.min(1, dt * 4);
    planeTelemetry.active = true;
    planeTelemetry.kts = speed.current * 29;
    planeTelemetry.altFt = g.position.y * 112;
    planeTelemetry.aglFt = Math.max(0, (g.position.y - gy) * 112);
    planeTelemetry.vsFpm = vsSmooth.current;
    planeTelemetry.heading =
      (Math.atan2(fwd.x, fwd.z) * (180 / Math.PI) + 360) % 360;
    planeTelemetry.pitchDeg = pitch.current * (180 / Math.PI);
    planeTelemetry.rollDeg = -roll.current * (180 / Math.PI);
    planeTelemetry.throttle = throttle.current;

    engine.current?.update(throttle.current, speed.current);

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
      [trailL, -3.85],
      [trailR, 3.85],
    ] as const) {
      tmp.set(sx, -0.12, -1.15);
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
          <ambientLight intensity={0.3} />
          <hemisphereLight
            color="#9db8ff"
            groundColor="#3a2f22"
            intensity={0.8}
          />
          <directionalLight position={[30, 60, 20]} intensity={2.2} />
        </>
      )}
      <primitive object={airframe.group} />
      <primitive object={trailL.line} />
      <primitive object={trailR.line} />
      <primitive object={explosion.group} />
    </group>
  );
}
