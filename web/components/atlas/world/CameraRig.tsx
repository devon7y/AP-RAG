"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { WorldData } from "./derive";
import { useWorld } from "./store";
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
}: {
  /** current rover world position (or null when the radio is off) */
  getRoverPos: () => THREE.Vector3 | null;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const warp = useWorld((s) => s.warp);
  const tween = useRef<Tween | null>(null);
  const baseFov = useRef<number | null>(null);
  const followTmp = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    if (!warp || !controls.current) return;
    baseFov.current ??= camera.fov;
    const toTgt = new THREE.Vector3(...warp.center);
    const dir = camera.position.clone().sub(toTgt);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.35, 1);
    const toPos = toTgt.clone().add(dir.normalize().multiplyScalar(warp.standoff));
    if (uMorph.value < 0.5) toPos.y = Math.max(toPos.y, 3.5);
    const fromPos = camera.position.clone();
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

    // rover follow
    const st = useWorld.getState();
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
    />
  );
}

/** One-time cinematic entry: fall from deep space onto the landmass. */
export function useIntroWarp(ready: boolean) {
  const requestWarp = useWorld((s) => s.requestWarp);
  const fired = useRef(false);
  useEffect(() => {
    if (!ready || fired.current) return;
    fired.current = true;
    const t = setTimeout(() => requestWarp([0, 4, 0], 105, 3.4), 250);
    return () => clearTimeout(t);
  }, [ready, requestWarp]);
}
