"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { WorldData } from "./derive";
import { CHASE, type PlanePose } from "./PlaneLayer";
import { useWorld, warpHome } from "./store";
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
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const warp = useWorld((s) => s.warp);
  const tween = useRef<Tween | null>(null);
  const baseFov = useRef<number | null>(null);
  const followTmp = useMemo(() => new THREE.Vector3(), []);
  const chaseFwd = useMemo(() => new THREE.Vector3(), []);
  const chasePos = useMemo(() => new THREE.Vector3(), []);
  const chaseTgt = useMemo(() => new THREE.Vector3(), []);
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

  // the idle orbit stops for good the moment the user moves the camera
  useEffect(() => {
    const ctl = controls.current;
    if (!ctl) return;
    const stop = () => useWorld.getState().set("autoRotate", false);
    ctl.addEventListener("start", stop);
    return () => ctl.removeEventListener("start", stop);
  }, []);

  useEffect(() => {
    if (!warp || !controls.current) return;
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

    // 747 chase cam — right on the tail so the jet reads big and the world
    // reads vast; the user's orbit input is suspended while it flies. The
    // orbit constraints (minDistance 3, horizon polar clamp) must be lifted
    // for the duration — ctl.update() re-applies them to the camera we set.
    const st = useWorld.getState();
    const plane = getPlanePose();
    if (plane && st.planeOn && st.planeFollow) {
      chaseFwd.set(0, 0, 1).applyQuaternion(plane.quat);
      chasePos
        .copy(plane.pos)
        .addScaledVector(chaseFwd, -CHASE.back)
        .addScaledVector(UP, CHASE.up);
      camera.position.lerp(chasePos, 1 - Math.exp(-9 * dt));
      if (camera.position.y < 0.06) camera.position.y = 0.06;
      chaseTgt.copy(plane.pos).addScaledVector(chaseFwd, CHASE.ahead);
      ctl.target.lerp(chaseTgt, 1 - Math.exp(-12 * dt));
      if (ctl.enabled) ctl.enabled = false;
      ctl.minDistance = 0.02;
      ctl.maxPolarAngle = Math.PI;
      // hugging the tail — pull the near-clip plane in so it doesn't slice
      // through the fuselage (restored the moment the chase ends)
      if (camera.near !== 0.01) {
        camera.near = 0.01;
        camera.updateProjectionMatrix();
      }
      chasing.current = true;
      ctl.update();
      return;
    }
    if (chasing.current) {
      chasing.current = false;
      ctl.enabled = true;
      ctl.minDistance = 3; // restore the resting orbit constraint
      camera.near = 0.1; // restore the atlas's default near-clip
      camera.updateProjectionMatrix();
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
      ref={controls}
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

/** One-time cinematic entry: fall from deep space onto the resting shot. */
export function useIntroWarp(ready: boolean) {
  const fired = useRef(false);
  useEffect(() => {
    if (!ready || fired.current) return;
    fired.current = true;
    const t = setTimeout(() => warpHome(3.4), 250);
    return () => clearTimeout(t);
  }, [ready]);
}
