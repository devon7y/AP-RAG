"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { WorldData } from "./derive";
import { AIRCRAFT } from "./aircraft";
import type { PlanePose } from "./PlaneLayer";
import { homeShot, useWorld } from "./store";
import { uMorph } from "./uniforms";

/**
 * Flight controls + warp drive (eased slew with a distance-scaled FOV kick),
 * adapted from the Observatory. Two world-specific behaviours:
 *  - in atlas view the orbit stays above the horizon and the camera never
 *    dips under the terrain; in space view the sphere is free
 *  - when the radio rover is driving with follow enabled, the target glides
 *    after the rover for a slow cinematic drift
 */

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const UP = new THREE.Vector3(0, 1, 0);

interface Tween {
  t0: number | null;
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTgt: THREE.Vector3;
  toTgt: THREE.Vector3;
  kick: number;
}

export default function CameraRig({
  getRoverPos,
  getPlanePose,
}: {
  /** current rover world position (or null when the radio is off) */
  getRoverPos: () => THREE.Vector3 | null;
  /** current 747 pose (or null when it isn't flying) */
  getPlanePose: () => PlanePose | null;
}) {
  // `| null` in the generic: this repo's @types/react (18) makes useRef<T>(null) a
  // readonly RefObject, so bindControls below couldn't assign to .current.
  const controls = useRef<OrbitControlsImpl | null>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const warp = useWorld((s) => s.warp);
  const tween = useRef<Tween | null>(null);
  const baseFov = useRef<number | null>(null);
  const followTmp = useMemo(() => new THREE.Vector3(), []);
  const chaseFwd = useMemo(() => new THREE.Vector3(), []);
  const chasePos = useMemo(() => new THREE.Vector3(), []);
  const chaseTgt = useMemo(() => new THREE.Vector3(), []);
  // lagging chase heading — the swing that gives the camera its momentum
  const smoothFwd = useMemo(() => new THREE.Vector3(), []);
  const chasing = useRef(false);
  const shake = useRef(0);

  // the crash rattles the camera
  useEffect(() => {
    const onCrash = () => {
      shake.current = 1;
    };
    window.addEventListener("world:plane-crash", onCrash);
    return () => window.removeEventListener("world:plane-crash", onCrash);
  }, []);

  // hand the camera to the chase the instant flight starts, so OrbitControls
  // never gets a frame to fight it (the chase is fully manual thereafter)
  const planeOn = useWorld((s) => s.planeOn);
  useEffect(() => {
    const ctl = controls.current;
    if (ctl && planeOn && useWorld.getState().planeFollow) ctl.enabled = false;
  }, [planeOn]);

  // Warps are seq-stamped; ignore any that predates this mount. The world
  // store is a module singleton that outlives client-side navigation, so on a
  // return visit the previous visit's warp is still sitting in it and would
  // re-fire here as a surprise flight.
  const mountSeq = useRef<number | null>(null);
  if (mountSeq.current === null) mountSeq.current = useWorld.getState().warp?.seq ?? 0;

  // open framed on the resting shot. The camera already mounts at
  // OPENING_SHOT.position, but OrbitControls defaults its target to the
  // origin — without this the world would sit a few units low on the first
  // frame and snap when something first drove the target.
  //
  // Same singleton problem as above for the flags that mean "something other
  // than the user is driving the camera". Nothing is warping or flying on
  // frame one of a fresh mount, but a previous visit can have left either set
  // — a stale `warping` deadens the picker (no hover, no clicks, so the scene
  // stops responding), and a stale `planeOn` disables the controls outright.
  const framed = useRef(false);
  const bindControls = useCallback(
    (ctl: OrbitControlsImpl | null) => {
      controls.current = ctl;
      if (!ctl || framed.current) return;
      framed.current = true;
      // the canvas mounts the camera at the atlas shot; a return visit can be
      // in galaxy view, whose resting orbit sits further out
      const shot = homeShot(useWorld.getState().view);
      camera.position.set(...shot.position);
      ctl.target.set(...shot.target);
      ctl.update();
      useWorld.setState({ warping: false, planeOn: false });
    },
    [camera],
  );

  // the idle orbit stops for good the moment the user moves the camera
  useEffect(() => {
    const ctl = controls.current;
    if (!ctl) return;
    const stop = () => useWorld.getState().set("autoRotate", false);
    ctl.addEventListener("start", stop);
    return () => ctl.removeEventListener("start", stop);
  }, []);

  useEffect(() => {
    if (!warp || warp.seq <= (mountSeq.current ?? 0) || !controls.current) return;
    baseFov.current ??= camera.fov;
    const toTgt = new THREE.Vector3(...warp.center);
    let toPos: THREE.Vector3;
    if (warp.orbit) {
      // land on the resting orbit at the point nearest the current camera:
      // keep the camera's azimuth, take the orbit's radius and height
      const dx = camera.position.x - toTgt.x;
      const dz = camera.position.z - toTgt.z;
      const len = Math.hypot(dx, dz) || 1;
      toPos = new THREE.Vector3(
        toTgt.x + (dx / len) * warp.orbit.radius,
        warp.orbit.height,
        toTgt.z + (dz / len) * warp.orbit.radius,
      );
    } else if (warp.pose) {
      // fixed framing: same position every time
      toPos = new THREE.Vector3(...warp.pose);
    } else {
      const dir = camera.position.clone().sub(toTgt);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0.35, 1);
      toPos = toTgt.clone().add(dir.normalize().multiplyScalar(warp.standoff));
      if (uMorph.value < 0.5) toPos.y = Math.max(toPos.y, 3.5);
    }
    const fromPos = camera.position.clone();
    // already there (e.g. Esc while resting on the home orbit) → no-op
    if (
      fromPos.distanceTo(toPos) < 2.5 &&
      controls.current.target.distanceTo(toTgt) < 2.5
    ) {
      return;
    }
    tween.current = {
      t0: null,
      dur: warp.duration,
      fromPos,
      toPos,
      fromTgt: controls.current.target.clone(),
      toTgt,
      kick: THREE.MathUtils.clamp(fromPos.distanceTo(toPos) * 0.26, 3, 19),
    };
    controls.current.enabled = false;
    useWorld.getState().set("warping", true);
  }, [warp, camera]);

  useFrame((state, dt) => {
    const ctl = controls.current;
    if (!ctl) return;

    // chase teardown — runs BEFORE the tween branch so an eject-into-warp
    // still restores the near-clip and orbit constraints the chase changed.
    // enabled is only handed back when no tween owns the camera (a warp sets
    // enabled itself and must keep it false until it completes).
    const followState = useWorld.getState();
    // the chase claims the camera from the moment flight is armed — before the
    // pose exists — so OrbitControls never gets a frame to fight it
    const planeClaims = followState.planeOn && followState.planeFollow;
    const flyingNow = planeClaims && getPlanePose() !== null;
    if (chasing.current && !flyingNow) {
      chasing.current = false;
      ctl.minDistance = 3;
      camera.near = 0.1;
      camera.updateProjectionMatrix();
      if (!tween.current) ctl.enabled = true;
    }

    // Nothing else owns the camera, so the user does. A tween owns it while it
    // runs and re-enables on completion; the chase disables it every frame
    // while armed. Outside those two a disabled control can only be a leak
    // from one of them being interrupted (navigating away mid-flight, mid-warp)
    // — heal it rather than leaving the world frozen with no way back.
    if (!planeClaims && !tween.current && !ctl.enabled) ctl.enabled = true;

    // warp tween
    const tw = tween.current;
    if (tw) {
      tw.t0 ??= state.clock.elapsedTime;
      const t = Math.min(1, (state.clock.elapsedTime - tw.t0) / tw.dur);
      const s = easeInOutCubic(t);
      camera.position.lerpVectors(tw.fromPos, tw.toPos, s);
      ctl.target.lerpVectors(tw.fromTgt, tw.toTgt, s);
      camera.fov = (baseFov.current ?? 55) + Math.sin(Math.PI * s) * tw.kick;
      camera.updateProjectionMatrix();
      ctl.update();
      if (t >= 1) {
        tween.current = null;
        camera.fov = baseFov.current ?? 55;
        camera.updateProjectionMatrix();
        ctl.enabled = true;
        useWorld.getState().set("warping", false);
      }
      return;
    }

    // post-crash camera rattle (decays over ~1.2 s; scaled to the close cam)
    if (shake.current > 0.004) {
      camera.position.x += (Math.random() - 0.5) * 0.18 * shake.current;
      camera.position.y += (Math.random() - 0.5) * 0.14 * shake.current;
      camera.position.z += (Math.random() - 0.5) * 0.18 * shake.current;
      shake.current *= Math.exp(-2.6 * dt);
    }

    // 747 chase cam — FULLY manual, bypassing OrbitControls (we never call
    // ctl.update(): it re-derives the camera from spherical coords and fights
    // a follow-cam; drei only auto-updates when ctl.enabled, so disabling it
    // hands us the camera outright).
    //
    // Momentum without drifting away: only the chase HEADING lags, never the
    // position. A positional lag is speed-dependent (v x time-constant, so
    // 0.5-1.3 units at cruise) which dwarfs the sub-unit follow distance and
    // silently pushes the camera back as you accelerate. Anchoring at the
    // plane's exact position keeps the framing identical at any speed, while
    // the lagging heading still swings the camera wide through a turn and
    // settles it behind on roll-out — which is what reads as weight anyway.
    // Stability: dt is clamped to the same 0.05 the flight model uses, so a
    // frame spike can't blow the smoothing factor into a snap (exactly what
    // the old eased follow did), and the flow is one-way — plane → heading →
    // camera — so nothing feeds back to oscillate.
    const st = useWorld.getState();
    const plane = getPlanePose();
    if (plane && st.planeOn && st.planeFollow) {
      // each airframe carries its own chase offsets, scaled to its size
      const CHASE = (AIRCRAFT[st.aircraft] ?? AIRCRAFT.a380).chase;
      chaseFwd.set(0, 0, 1).applyQuaternion(plane.quat);
      const dtc = Math.min(dt, 0.05);
      if (!chasing.current) {
        smoothFwd.copy(chaseFwd); // first frame — planted, no swing-in
      } else {
        smoothFwd.lerp(chaseFwd, 1 - Math.exp(-3.5 * dtc));
        if (smoothFwd.lengthSq() < 1e-6) smoothFwd.copy(chaseFwd);
        else smoothFwd.normalize();
      }
      chasePos
        .copy(plane.pos)
        .addScaledVector(smoothFwd, -CHASE.back)
        .addScaledVector(UP, CHASE.up);
      camera.position.copy(chasePos);
      if (camera.position.y < 0.05) camera.position.y = 0.05;
      // aim ahead of the plane and slightly UP, so the shot sits level behind
      // the fuselage rather than looking down on it
      chaseTgt
        .copy(plane.pos)
        .addScaledVector(chaseFwd, CHASE.ahead)
        .addScaledVector(UP, CHASE.aimUp);
      ctl.target.copy(chaseTgt); // keep synced so the eject handoff is smooth
      camera.up.set(0, 1, 0);
      camera.lookAt(chaseTgt);
      ctl.enabled = false;
      // hugging the tail — pull the near-clip plane in so it doesn't slice
      // through the fuselage (restored by the teardown when the chase ends)
      if (camera.near !== 0.01) {
        camera.near = 0.01;
        camera.updateProjectionMatrix();
      }
      chasing.current = true;
      return;
    }

    // rover follow
    if (st.radioOn && st.radioFollow) {
      const rover = getRoverPos();
      if (rover) {
        followTmp.copy(rover);
        ctl.target.lerp(followTmp, Math.min(1, dt * 1.6));
        const d = camera.position.distanceTo(ctl.target);
        if (d > 34) {
          const dir = camera.position.clone().sub(ctl.target).normalize();
          camera.position.copy(ctl.target).add(dir.multiplyScalar(34));
        }
      }
    }

    // gentle idle orbit, rotated manually with real dt — OrbitControls'
    // built-in autoRotate advances per update() call, which drifts and
    // pulses with frame timing (drei also calls update() internally)
    if (st.autoRotate && !tween.current) {
      const ang = 0.045 * dt;
      const off = camera.position.clone().sub(ctl.target);
      off.applyAxisAngle(UP, ang);
      camera.position.copy(ctl.target).add(off);
    }

    // pan speed compensates for zoomToCursor collapsing the orbit radius —
    // without this, panning grinds to a halt when zoomed way in
    const radius = camera.position.distanceTo(ctl.target);
    ctl.panSpeed = 0.3 * THREE.MathUtils.clamp(40 / Math.max(radius, 1), 1, 14);

    // horizon discipline in atlas view
    const groundness = 1 - uMorph.value;
    ctl.maxPolarAngle = THREE.MathUtils.lerp(Math.PI, Math.PI / 2.06, groundness);
    if (groundness > 0.5) {
      if (camera.position.y < 1.4) camera.position.y = 1.4;
      if (ctl.target.y < 0) ctl.target.y = 0;
    }
    ctl.update();
  });

  return (
    <OrbitControls
      ref={bindControls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.55}
      zoomSpeed={0.85}
      panSpeed={0.6}
      minDistance={3}
      maxDistance={300}
      screenSpacePanning
      zoomToCursor
    />
  );
}
