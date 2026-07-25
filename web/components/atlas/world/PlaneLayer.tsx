"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { WORLD_SIZE } from "@/lib/atlas/data";
import { useAtlasStore } from "@/lib/atlas/store";
import { glowTexture, ringTexture, sampleField, type WorldData } from "./derive";
import { paperWorldPos } from "./PaperBeacons";
import {
  playExplosion,
  startAltitudeWarning,
  startEngine,
  type EngineSound,
  type WarningSound,
} from "./planeAudio";
import { AIRCRAFT, type AircraftKey, type AircraftSpec } from "./aircraft";
import { useWorld } from "./store";
import { HEIGHT_SCALE, uMorph } from "./uniforms";

/**
 * The hangar in flight: whichever aircraft is selected spawns on the home
 * camera ring at a random azimuth and ends its story one of two ways — an
 * eject, or a fireball on a mountainside that opens the nearest paper's card
 * exactly as clicking its beacon would.
 *
 * There is no stand-in mesh. The chosen airframe streams in on take-off and
 * nothing moves, sounds or reads out until it is in the scene; a placeholder
 * that doesn't match the real jet is worse than a moment of honest waiting.
 * Each aircraft brings its own handling, light anchors and exhaust style from
 * the registry in ./aircraft, so this file is one flight model rather than a
 * pile of special cases. Loaded airframes are cached, so switching back to a
 * jet you have already flown is instant.
 */

/* ---------------- flight constants (world-level) ---------------- */

const CEILING = 55;
const BOUND = 84; // beyond this radius the jet is steered home
const SPAWN_RADIUS = 92; // the home orbit ring
const SPAWN_ALT = 34;
const TRAIL_N = 110;

/** GPWS trigger: below this AGL (display feet) the terrain alarm sounds. */
const WARN_AGL_FT = 350;

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
  /** GPWS: true while dangerously close to the terrain */
  warning: false,
};

export interface PlanePose {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

/* ---------------- the airframe rig (lights only) ---------------- */

interface Airframe {
  group: THREE.Group;
  disposables: (THREE.BufferGeometry | THREE.Material)[];
  /** one per engine — the hot core */
  engineGlows: THREE.Sprite[];

  /** red port light (+X) */
  navPort: THREE.Sprite;
  /** green starboard light (−X) */
  navStbd: THREE.Sprite;
  /** one per anti-collision strobe */
  strobes: THREE.Sprite[];
  /** oriented exhaust quads (slit aircraft) — parented, so they roll with it */
  exhaustParts: { mat: THREE.MeshBasicMaterial; base: number }[];
}

/**
 * The airframe rig is lights only — nav lights, one strobe per tail, and an
 * exhaust per engine. A "glow" exhaust is a round warm haze over each nacelle;
 * a "slit" exhaust is stretched wide and flat to sit over a long shallow
 * trough, and the airframe's own emissive map does the burning underneath it.
 * Positions are placeholders; anchorRealJet pins them to the mesh.
 */
function buildAirframe(spec: AircraftSpec): Airframe {
  const group = new THREE.Group();
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const glow = glowTexture();

  const sprite = (color: string, w: number, h = w) => {
    const m = new THREE.SpriteMaterial({
      map: glow,
      color,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    disposables.push(m);
    const sp = new THREE.Sprite(m);
    sp.scale.set(w, h, 1);
    group.add(sp);
    return sp;
  };

  const slit = spec.exhaust.kind === "slit";

  // Round nacelle haze for a turbofan: camera-facing sprites are fine, since a
  // circular glow looks the same from every angle.
  const engineGlows = slit
    ? []
    : spec.anchors.engines.map(() => sprite(spec.exhaust.core, spec.exhaust.size));
  const halos = slit
    ? []
    : spec.anchors.engines.map(() =>
        sprite(spec.exhaust.halo, spec.exhaust.size * 1.9),
      );
  (group.userData as { halos?: THREE.Sprite[] }).halos = halos;

  // A slit exhaust is a long angled trough, so its glow is built from ORIENTED
  // quads parented to the airframe — they roll with the jet and sit in the
  // slit's own plane. A camera-facing sprite could do neither, which is why it
  // sheared through the fuselage.
  const exhaustParts: { mat: THREE.MeshBasicMaterial; base: number }[] = [];
  if (slit) {
    const quad = (
      holder: THREE.Group,
      w: number,
      h: number,
      base: number,
    ) => {
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: new THREE.Color(spec.exhaust.halo),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      disposables.push(geo, mat);
      const m = new THREE.Mesh(geo, mat);
      holder.add(m);
      exhaustParts.push({ mat, base });
      return m;
    };
    for (const sl of spec.anchors.slits ?? []) {
      const holder = new THREE.Group();
      holder.position.set(...sl.pos);
      holder.rotation.set(...sl.rot);
      group.add(holder);
      // the trough itself, lying in the slit plane a hair proud of the skin so
      // it never z-fights the surface it sits on
      quad(holder, sl.wid * 1.6, sl.len * 1.06, 1).position.z = 0.04;
      // the exit, turned to face aft (+Y is aft in the slit's frame) so the
      // burn still reads from directly behind, where the chase camera lives
      const exit = quad(holder, sl.wid * 1.5, sl.wid * 1.0, 0.9);
      exit.rotation.x = -Math.PI / 2;
      exit.position.set(0, sl.len * 0.52, 0.03);
    }
  }

  const navPort = sprite("#ff4d4d", 0.28); // +X — red
  const navStbd = sprite("#4dff7a", 0.28); // −X — green
  const strobes = spec.anchors.strobes.map(() => sprite("#ffffff", 0.28));

  group.scale.setScalar(spec.scale);
  group.rotation.order = "YXZ";
  group.visible = false;
  return {
    group,
    disposables,
    engineGlows,
    navPort,
    navStbd,
    strobes,
    exhaustParts,
  };
}

/* ---------------- the real jet's painted livery ---------------- */

/**
 * A tiny equirectangular gradient — night sky above, dark ground below, with a
 * soft highlight where the key light sits — pre-filtered into a reflection
 * probe. Airliner paint is glossy, and gloss is mostly *reflection*: with only
 * direct lights the hull can only ever look matte. This is attached to the
 * jet's own materials rather than to scene.environment, so nothing else in the
 * world changes. Returns null if the renderer can't build a probe.
 */
function makeEnvProbe(renderer: THREE.WebGLRenderer): THREE.Texture | null {
  try {
    const W = 64;
    const H = 32;
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const t = y / (H - 1); // 0 = zenith, 1 = nadir
      const sky = Math.pow(1 - t, 0.7);
      for (let x = 0; x < W; x++) {
        // a broad soft "sun" so the fuselage catches a travelling highlight
        const az = (x / W) * Math.PI * 2;
        const sun =
          Math.max(0, Math.cos(az - 1.1)) ** 12 * Math.max(0, 1 - t * 1.8);
        const i = (y * W + x) * 4;
        data[i] = Math.min(255, (26 + 150 * sky + 210 * sun) | 0);
        data[i + 1] = Math.min(255, (30 + 165 * sky + 205 * sun) | 0);
        data[i + 2] = Math.min(255, (42 + 190 * sky + 190 * sun) | 0);
        data[i + 3] = 255;
      }
    }
    const src = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    src.mapping = THREE.EquirectangularReflectionMapping;
    src.colorSpace = THREE.SRGBColorSpace;
    src.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(src).texture;
    pmrem.dispose();
    src.dispose();
    return env;
  } catch {
    return null; // no probe — the material tweaks below still apply
  }
}

/**
 * The scan ships its own UV-mapped PBR set (base colour with airline titles,
 * window rows and doors, plus normal and metallic-roughness maps), so we KEEP
 * its materials rather than painting over them, and only push them toward the
 * gloss of real airline paint: roughness pulled down for a tight highlight,
 * a little metalness for a specular tint, and the reflection probe attached.
 * Metalness stays capped — with no probe a fully-metallic surface goes black —
 * and thin single-sided panels are drawn double-sided so the airframe never
 * shows holes from the chase camera.
 */
function adoptLivery(
  root: THREE.Group,
  env: THREE.Texture | null,
  spec: AircraftSpec,
): THREE.MeshStandardMaterial[] {
  const emissives: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial) {
        std.metalness = THREE.MathUtils.clamp(std.metalness ?? 0, 0.28, 0.5);
        std.roughness = THREE.MathUtils.clamp(std.roughness ?? 1, 0.12, 0.32);
        if (env) {
          std.envMap = env;
          std.envMapIntensity = 1.15;
        }
      }
      // the airframe's own emissive map IS its exhaust glow (the F-117 ships
      // one, painted orange and flattened to a mask at bake time). Tint it to
      // the aircraft's exhaust colour; the frame loop drives its intensity.
      if (std.isMeshStandardMaterial && std.emissiveMap && spec.exhaust.emissiveMax > 0) {
        std.emissive = new THREE.Color(spec.exhaust.emissive);
        std.emissiveIntensity = 0;
        std.toneMapped = false; // let the burner blow out past white
        emissives.push(std);
      }
      m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    }
  });
  return emissives;
}

/** Pin every light onto the airframe once the scan has loaded. */
function anchorRealJet(
  airframe: Airframe,
  spec: AircraftSpec,
  wing: { port: THREE.Vector3; stbd: THREE.Vector3 },
): void {
  const A = spec.anchors;
  airframe.navPort.position.set(...A.navPort);
  airframe.navStbd.position.set(...A.navStbd);
  A.strobes.forEach((p, i) => airframe.strobes[i]?.position.set(...p));
  const halos =
    (airframe.group.userData as { halos?: THREE.Sprite[] }).halos ?? [];
  A.engines.forEach(([x, y, z], i) => {
    airframe.engineGlows[i]?.position.set(x, y, z);
    halos[i]?.position.set(x, y, z);
  });
  // contrails stream from the wingtips, just aft of the nav lights
  wing.port.set(A.navPort[0], A.navPort[1], A.navPort[2] - spec.trailAft);
  wing.stbd.set(A.navStbd[0], A.navStbd[1], A.navStbd[2] - spec.trailAft);
}

/* ---------------- the crash ---------------- */

const DEBRIS_N = 420;
const SMOKE_N = 24;
const FIRE_N = 22;
const FLAME_SUSTAIN = 4.2; // the wreck keeps re-igniting flames this long
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
  fireGlow: THREE.Sprite;
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

  // the fireball — a flickering cluster of tongues, each color-ramped
  // white-hot → orange → ember red as it ages (set per frame)
  const fire: THREE.Sprite[] = [];
  for (let i = 0; i < FIRE_N; i++) {
    const m = new THREE.SpriteMaterial({
      map: glowTexture(),
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
  // the burning wreck lights the ground long after the blast
  const fireGlow = sprite(glowTexture(), "#ff7a2a");

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
    fireGlow,
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
  const planeStatus = useWorld((s) => s.planeStatus);
  const camera = useThree((s) => s.camera);
  const renderer = useThree((s) => s.gl);
  const boost = useAtlasStore((s) => s.hdrBoost);

  const aircraftKey = useWorld((st) => st.aircraft);
  const spec = AIRCRAFT[aircraftKey] ?? AIRCRAFT.a380;
  // the rig is rebuilt per aircraft — different engine count, exhaust and scale
  const airframe = useMemo(() => buildAirframe(spec), [spec]);
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
  const warnSound = useRef<WarningSound | null>(null);
  const lastY = useRef(0);
  const vsSmooth = useRef(0);
  const pose = useMemo<PlanePose>(
    () => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion() }),
    [],
  );
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const crashPos = useMemo(() => new THREE.Vector3(), []);
  // contrail emit points (group-local); re-pinned to the real wingtips on load
  const wingAnchors = useMemo(
    () => ({
      port: new THREE.Vector3(3.85, -0.12, -1.15),
      stbd: new THREE.Vector3(-3.85, -0.12, -1.15),
    }),
    [],
  );

  const clearTrails = () => {
    trailL.pts.length = 0;
    trailR.pts.length = 0;
    trailL.geo.setDrawRange(0, 0);
    trailR.geo.setDrawRange(0, 0);
  };

  /** Put the jet on the ring and hand it the controls. Only ever called once
   *  the real airframe is in the scene — there is no stand-in to fly. */
  const startFlight = () => {
    const st = useWorld.getState();
    const g = airframe.group;
    // wheels-up from a random point on the home orbit ring, flying inward
    const az = Math.random() * Math.PI * 2;
    g.position.set(
      Math.sin(az) * SPAWN_RADIUS,
      SPAWN_ALT,
      Math.cos(az) * SPAWN_RADIUS,
    );
    yaw.current = az + Math.PI; // toward the center of the world
    pitch.current = 0;
    roll.current = 0;
    throttle.current = spec.flight.startThrottle;
    speed.current = spec.flight.startSpeed;
    lastY.current = g.position.y;
    vsSmooth.current = 0;
    g.rotation.set(0, yaw.current, 0);
    g.visible = true;
    clearTrails();
    mode.current = "flying";
    st.set("planeStatus", "ready");

    // put the camera right on its tail so the jet reads big immediately
    if (st.planeFollow) {
      fwd.set(Math.sin(yaw.current), 0, Math.cos(yaw.current));
      camera.position
        .copy(g.position)
        .addScaledVector(fwd, -spec.chase.back)
        .add(new THREE.Vector3(0, spec.chase.up, 0));
    }
  };
  const startFlightRef = useRef(startFlight);
  startFlightRef.current = startFlight;

  // spawn / despawn
  useEffect(() => {
    const st = useWorld.getState();
    if (planeOn) {
      st.select(null); // a fresh flight closes whatever card was open
      // the airframe streams in on the first take-off; the loader starts the
      // flight when it lands, so nothing moves (or sounds) before then
      // the loader effect attaches the airframe and hands over; if it is
      // already cached that happens on the same tick
      if (!jetCache.current.has(spec.key)) st.set("planeStatus", "loading");
    } else if (mode.current === "flying") {
      // ejected mid-air (panel toggle / Esc) — vanish without the fireball
      airframe.group.visible = false;
      mode.current = null;
      poseRef.current = null;
      planeTelemetry.active = false;
      planeTelemetry.warning = false;
      warnSound.current?.stop();
      warnSound.current = null;
      clearTrails();
      if (st.planeStatus !== "error") st.set("planeStatus", "idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planeOn, airframe, camera]);

  // engine sound — only once the real airframe is flying
  useEffect(() => {
    if (planeOn && planeSound && planeStatus === "ready") {
      engine.current = startEngine(spec.key === "f117" ? "fighter" : "turbofan");
      return () => {
        engine.current?.stop();
        engine.current = null;
      };
    }
    return undefined;
  }, [planeOn, planeSound, planeStatus, spec]);

  // the real 747 — streamed in once, on the first take-off, so the page's
  // initial load never pays for it; the procedural jet flies until it lands
  const jetCache = useRef<Map<AircraftKey, THREE.Group>>(new Map());
  const realJet = useRef<THREE.Group | null>(null);
  const envProbe = useRef<THREE.Texture | null>(null);
  const exhaustMats = useRef<THREE.MeshStandardMaterial[]>([]);
  const loadState = useRef<Map<AircraftKey, "loading" | "done" | "failed">>(
    new Map(),
  );
  useEffect(() => {
    if (!planeOn) return;
    const key = spec.key;
    const state = loadState.current.get(key);
    if (state === "loading" || state === "failed") return;

    // already flown this airframe — re-attach the cached mesh and go
    const cached = jetCache.current.get(key);
    if (cached) {
      if (cached.parent !== airframe.group) airframe.group.add(cached);
      realJet.current = cached;
      exhaustMats.current = [];
      cached.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          const std = m as THREE.MeshStandardMaterial;
          if (std.isMeshStandardMaterial && std.emissiveMap && spec.exhaust.emissiveMax > 0) {
            exhaustMats.current.push(std);
          }
        }
      });
      anchorRealJet(airframe, spec, wingAnchors);
      if (useWorld.getState().planeOn) startFlightRef.current();
      return;
    }

    loadState.current.set(key, "loading");
    (async () => {
      try {
        const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
          import("three/examples/jsm/loaders/GLTFLoader.js"),
          import("three/examples/jsm/libs/meshopt_decoder.module.js"),
        ]);
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync(spec.url);
        envProbe.current ??= makeEnvProbe(
          renderer as unknown as THREE.WebGLRenderer,
        );
        exhaustMats.current = adoptLivery(gltf.scene, envProbe.current, spec);
        jetCache.current.set(key, gltf.scene);
        loadState.current.set(key, "done");
        // the pilot may have ejected or switched jets while this was streaming
        const st = useWorld.getState();
        if (!st.planeOn || st.aircraft !== key) {
          if (!st.planeOn) st.set("planeStatus", "idle");
          return;
        }
        airframe.group.add(gltf.scene);
        realJet.current = gltf.scene;
        anchorRealJet(airframe, spec, wingAnchors);
        startFlightRef.current();
      } catch {
        // no stand-in to fall back on — say so and cancel the take-off
        loadState.current.set(key, "failed");
        useWorld.getState().set("planeStatus", "error");
        useWorld.getState().set("planeOn", false);
      }
    })();
  }, [planeOn, airframe, renderer, spec, wingAnchors]);

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

  // the light rig is rebuilt whenever the aircraft changes — free the old one.
  // Deliberately NOT the cached airframes or the env probe: those are shared
  // across switches, and disposing them here would break flying a jet twice.
  useEffect(
    () => () => {
      for (const d of airframe.disposables) d.dispose();
    },
    [airframe],
  );

  // teardown on unmount — everything that outlives an aircraft switch
  useEffect(() => {
    const cache = jetCache.current;
    const timers = timeouts.current;
    return () => {
      for (const id of timers) window.clearTimeout(id);
      for (const d of explosion.disposables) d.dispose();
      trailL.geo.dispose();
      (trailL.line.material as THREE.Material).dispose();
      trailR.geo.dispose();
      (trailR.line.material as THREE.Material).dispose();
      // each scan owns its materials + livery textures — free every cached one
      for (const jet of cache.values()) {
        jet.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return;
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            for (const v of Object.values(m)) {
              if (v instanceof THREE.Texture) v.dispose();
            }
            m.dispose();
          }
        });
      }
      cache.clear();
      envProbe.current?.dispose();
      engine.current?.stop();
      warnSound.current?.stop();
      planeTelemetry.active = false;
      planeTelemetry.warning = false;
    };
  }, [explosion, trailL, trailR]);

  const crash = () => {
    const st = useWorld.getState();
    const g = airframe.group;
    mode.current = null;
    expActive.current = true;
    expT.current = 0;
    poseRef.current = null;
    planeTelemetry.active = false;
    planeTelemetry.warning = false;
    warnSound.current?.stop();
    warnSound.current = null;

    const gy = groundHeightAt(data, g.position.x, g.position.z);
    crashGroundY.current = Math.max(gy, 0);
    g.position.y = crashGroundY.current + 0.08;
    const cp = g.position;
    crashPos.copy(cp);

    // debris carries the jet's momentum plus a hot radial burst
    fwd.set(
      Math.sin(yaw.current) * Math.cos(pitch.current),
      Math.sin(pitch.current),
      Math.cos(yaw.current) * Math.cos(pitch.current),
    );
    const pa = explosion.posAttr.array as Float32Array;
    for (let i = 0; i < DEBRIS_N; i++) {
      pa[i * 3] = cp.x;
      pa[i * 3 + 1] = cp.y + 0.08;
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
      explosion.fireVel[i * 3 + 1] = 0.8 + Math.random() * 1.3; // the fireball climbs
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
    explosion.fireGlow.position.set(cp.x, crashGroundY.current + 0.3, cp.z);
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
        vs[i * 3 + 1] -= 8.5 * dt;
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
        Math.max(0, 1 - e / 3.2) * boost;

      for (let i = 0; i < FIRE_N; i++) {
        explosion.fireAge[i] += dt;
        let age = explosion.fireAge[i];
        const s = explosion.fire[i];
        if (age > explosion.fireLife[i]) {
          if (e < FLAME_SUSTAIN) {
            // the wreck keeps burning — this tongue of flame re-ignites
            s.position.set(
              crashPos.x + (Math.random() - 0.5) * 0.7,
              crashGroundY.current + 0.1 + Math.random() * 0.2,
              crashPos.z + (Math.random() - 0.5) * 0.7,
            );
            explosion.fireVel[i * 3] = (Math.random() - 0.5) * 0.3;
            explosion.fireVel[i * 3 + 1] = 0.35 + Math.random() * 0.8;
            explosion.fireVel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
            explosion.fireAge[i] = 0;
            explosion.fireLife[i] = 0.7 + Math.random() * 0.9;
            explosion.fireScale0[i] = 0.45 + Math.random() * 0.7;
            age = 0;
          } else {
            s.visible = false;
            continue;
          }
        }
        if (age < 0) {
          s.visible = false;
          continue;
        }
        const life = explosion.fireLife[i];
        s.visible = true;
        s.position.x += explosion.fireVel[i * 3] * dt;
        s.position.y += explosion.fireVel[i * 3 + 1] * dt;
        s.position.z += explosion.fireVel[i * 3 + 2] * dt;
        const grow = 1 - Math.exp(-3.5 * age);
        const shrink = 1 - 0.85 * Math.max(0, age / life - 0.55) / 0.45;
        const flicker = 0.7 + 0.3 * Math.sin(t * 19 + i * 2.4);
        s.scale.setScalar(
          explosion.fireScale0[i] * (0.4 + 2.6 * grow) * shrink,
        );
        // white-hot → orange → ember red across each flame's life
        const k = age / life;
        if (k < 0.3) {
          const u = k / 0.3;
          s.material.color.setRGB(1.9, 1.7 - 0.95 * u, 1.3 - 1.1 * u);
        } else {
          const u = (k - 0.3) / 0.7;
          s.material.color.setRGB(1.9 - 0.8 * u, 0.75 - 0.53 * u, 0.2 - 0.15 * u);
        }
        s.material.opacity = (1 - k) * flicker * boost;
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
        // young smoke glows fire-lit orange, then cools to sooty gray
        const lit = Math.max(0, 1 - age / 1.2);
        s.material.color.setRGB(1 + 0.9 * lit, 1 + 0.15 * lit, 1 - 0.45 * lit);
        s.material.opacity =
          Math.min(1, age * 2.5) * (1 - age / life) * 0.6;
      }

      const bump =
        e > 0.26 && e < 0.44 ? Math.sin((Math.PI * (e - 0.26)) / 0.18) : 0;
      const bump2 =
        e > 0.6 && e < 0.78 ? Math.sin((Math.PI * (e - 0.6)) / 0.18) : 0;
      explosion.flash.scale.setScalar(14);
      explosion.flash.material.opacity =
        (Math.max(0, 1 - e / 0.13) + 0.5 * bump + 0.3 * bump2) * boost;

      const rt = Math.min(1, e / 0.7);
      explosion.ring.scale.setScalar(1 + 20 * rt);
      explosion.ring.material.opacity = Math.pow(1 - rt, 1.5) * 0.9 * boost;

      // the burning wreck throws flickering orange light until the flames die
      const glowLife = Math.max(0, 1 - e / (FLAME_SUSTAIN + 1.6));
      explosion.fireGlow.scale.setScalar(2.6 + 0.5 * Math.sin(t * 11));
      explosion.fireGlow.material.opacity =
        glowLife * (0.4 + 0.2 * Math.sin(t * 23 + 1.3)) * boost;

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
    const F = spec.flight;
    throttle.current = THREE.MathUtils.clamp(
      throttle.current + thr * F.throttleRate * dt,
      0,
      1,
    );
    pitch.current = THREE.MathUtils.clamp(
      pitch.current + pit * F.pitchRate * dt,
      -F.pitchMax,
      F.pitchMax,
    );
    if (!pit) pitch.current *= Math.max(0, 1 - F.pitchDamp * dt); // auto-trim
    roll.current +=
      (-turn * F.bankMax - roll.current) * Math.min(1, F.rollLerp * dt);
    const agility = 0.5 + 0.5 * Math.min(1, speed.current / F.speedMax);
    yaw.current +=
      (-roll.current / F.bankMax) * F.turnRate * dt * agility +
      rudder * F.turnRate * 0.8 * dt * agility; // Q/E — flat rudder yaw

    /* ---- fly ---- */
    const target = F.speedMin + (F.speedMax - F.speedMin) * throttle.current;
    speed.current += (target - speed.current) * Math.min(1, F.speedLerp * dt);
    speed.current = THREE.MathUtils.clamp(
      speed.current - pitch.current * F.diveGain * dt, // dive gains, climb bleeds
      F.speedFloor,
      F.speedCeil,
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
    if (uMorph.value < 0.5 && g.position.y <= gy + 0.05) {
      crash();
      return;
    }

    /* ---- cockpit telemetry for the HUD ---- */
    const vsRaw = ((g.position.y - lastY.current) / Math.max(dt, 1e-4)) * 112 * 60;
    lastY.current = g.position.y;
    vsSmooth.current += (vsRaw - vsSmooth.current) * Math.min(1, dt * 4);
    planeTelemetry.active = true;
    planeTelemetry.kts = speed.current * F.ktsPerUnit;
    planeTelemetry.altFt = g.position.y * 112;
    planeTelemetry.aglFt = Math.max(0, (g.position.y - gy) * 112);
    planeTelemetry.vsFpm = vsSmooth.current;
    planeTelemetry.warning = planeTelemetry.aglFt < WARN_AGL_FT;

    // GPWS siren tracks the warning state (and the sound toggle)
    const wantSiren =
      planeTelemetry.warning && useWorld.getState().planeSound;
    if (wantSiren && !warnSound.current) {
      warnSound.current = startAltitudeWarning();
    } else if (!wantSiren && warnSound.current) {
      warnSound.current.stop();
      warnSound.current = null;
    }
    planeTelemetry.heading =
      (Math.atan2(fwd.x, fwd.z) * (180 / Math.PI) + 360) % 360;
    planeTelemetry.pitchDeg = pitch.current * (180 / Math.PI);
    planeTelemetry.rollDeg = -roll.current * (180 / Math.PI);
    planeTelemetry.throttle = throttle.current;

    engine.current?.update(throttle.current, speed.current);

    /* ---- dressing: strobes, exhaust, contrails ---- */
    const phase = t % 1.2;
    airframe.navPort.material.opacity = (phase < 0.12 ? 0.9 : 0.25) * boost;
    airframe.navStbd.material.opacity = (phase < 0.12 ? 0.9 : 0.25) * boost;
    for (const st of airframe.strobes) {
      st.material.opacity = (phase > 0.55 && phase < 0.63 ? 1 : 0.08) * boost;
    }

    // Exhaust: the airliner's haze tracks the throttle; the fighter's exhaust
    // glow tracks SPEED, so the slits brighten as it actually accelerates.
    const slit = spec.exhaust.kind === "slit";
    const drive =
      spec.exhaustFollows === "speed"
        ? THREE.MathUtils.clamp(
            (speed.current - F.speedMin) / (F.speedMax - F.speedMin),
            0,
            1,
          )
        : throttle.current;
    const flick = slit ? 0.9 + 0.1 * Math.sin(t * 37) : 1;
    for (const gs of airframe.engineGlows) {
      gs.material.opacity = (0.12 + 0.6 * drive) * boost;
    }
    const halos =
      (airframe.group.userData as { halos?: THREE.Sprite[] }).halos ?? [];
    for (const h of halos) {
      h.material.opacity = (0.06 + 0.5 * drive) * boost;
    }
    // the oriented trough quads brighten with speed; they never resize, since
    // their shape is the slit's real geometry
    for (const part of airframe.exhaustParts) {
      part.mat.opacity = part.base * (0.06 + 0.94 * drive) * flick * boost;
    }
    // the airframe's own emissive slits burn hotter the faster it flies
    for (const m of exhaustMats.current) {
      m.emissiveIntensity = spec.exhaust.emissiveMax * (0.12 + 0.88 * drive) * flick;
    }

    for (const [trail, anchor] of [
      [trailL, wingAnchors.port],
      [trailR, wingAnchors.stbd],
    ] as const) {
      tmp.copy(anchor);
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
          <ambientLight intensity={0.28} />
          <hemisphereLight
            color="#9db8ff"
            groundColor="#3a2f22"
            intensity={0.75}
          />
          <directionalLight position={[30, 60, 20]} intensity={2.6} />
          {/* rim light off the opposite shoulder — gives the gloss a second
              highlight to travel across as the jet rolls */}
          <directionalLight position={[-40, 25, -30]} intensity={1.1} />
        </>
      )}
      <primitive object={airframe.group} />
      <primitive object={trailL.line} />
      <primitive object={trailR.line} />
      <primitive object={explosion.group} />
    </group>
  );
}
