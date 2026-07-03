"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useObservatory } from "./store";

/**
 * Flight controls + the warp drive. Orbit/zoom/pan for local flying; a warp
 * request slews the camera along an eased path toward the destination with a
 * distance-scaled FOV kick (the "jump to hyperspace" stretch). User input is
 * locked while the drive is engaged.
 */

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

interface Tween {
  t0: number | null; // set on first frame after request
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTgt: THREE.Vector3;
  toTgt: THREE.Vector3;
  kick: number;
}

export default function CameraRig() {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const warp = useObservatory((s) => s.warp);
  const setWarping = useObservatory((s) => s.setWarping);
  const tween = useRef<Tween | null>(null);
  const baseFov = useRef<number | null>(null);

  useEffect(() => {
    if (!warp || !controls.current) return;
    baseFov.current ??= camera.fov;
    const toTgt = new THREE.Vector3(...warp.center);
    const dir = camera.position.clone().sub(toTgt);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.25, 1);
    const toPos = toTgt.clone().add(dir.normalize().multiplyScalar(warp.standoff));
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
    setWarping(true);
  }, [warp, camera, setWarping]);

  useFrame((state) => {
    const tw = tween.current;
    if (!tw || !controls.current) return;
    tw.t0 ??= state.clock.elapsedTime;
    const t = Math.min(1, (state.clock.elapsedTime - tw.t0) / tw.dur);
    const s = easeInOutCubic(t);
    camera.position.lerpVectors(tw.fromPos, tw.toPos, s);
    controls.current.target.lerpVectors(tw.fromTgt, tw.toTgt, s);
    camera.fov = (baseFov.current ?? 55) + Math.sin(Math.PI * s) * tw.kick;
    camera.updateProjectionMatrix();
    controls.current.update();
    if (t >= 1) {
      tween.current = null;
      camera.fov = baseFov.current ?? 55;
      camera.updateProjectionMatrix();
      controls.current.enabled = true;
      setWarping(false);
    }
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
      maxDistance={260}
      screenSpacePanning
    />
  );
}
