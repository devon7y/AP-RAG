"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { fract, positionLocal, smoothstep, texture, vec3 } from "three/tsl";
import { WORLD_SIZE } from "@/lib/atlas/data";
import type { WorldData } from "./derive";
import {
  groundHeight,
  groundUV,
  HEIGHT_SCALE,
  uCalm,
  uLensDim,
  uMorph,
} from "./uniforms";

/**
 * The landmass: a displaced grid whose height comes from the era-blended
 * density fields (so the terrain literally grows through the time machine)
 * and whose tint is the cluster-color field. Dark by design — the chunk
 * points carry the light; the terrain gives them geography, coastlines and
 * contour rhythm. Fades away as the world unfolds into space.
 */
export default function Terrain({ data }: { data: WorldData }) {
  const meshRef = useRef<THREE.Mesh>(null);

  const { geometry, material } = useMemo(() => {
    // extend past the data square so edge peaks get their skirt (groundHeight
    // tapers to zero just outside [0,1]²) instead of a sliced-off wall
    const geometry = new THREE.PlaneGeometry(WORLD_SIZE + 14, WORLD_SIZE + 14, 271, 271);
    geometry.rotateX(-Math.PI / 2);

    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = true;
    // the invisible "sea" (alpha≈0) must not write depth over the stars behind it
    material.alphaTest = 0.02;

    const h = groundHeight(positionLocal);
    material.positionNode = positionLocal.add(vec3(0, h, 0));

    const h01 = h.div(HEIGHT_SCALE);
    const tint = texture(data.colorTex, groundUV(positionLocal)).rgb;

    // dark relief shading, brighter with elevation
    const base = tint.mul(h01.pow(1.05).mul(0.5).add(0.12));

    // thin contour bands (ascending smoothstep edges only — WGSL-safe)
    const bands = fract(h01.mul(15.0));
    const line = smoothstep(0.02, 0.06, bands).mul(
      smoothstep(0.1, 0.16, bands).oneMinus(),
    );
    const contour = tint.add(0.22).mul(line).mul(0.085).mul(uCalm).mul(h01.min(1));

    // luminous coastline where the landmass meets the void
    const coast = smoothstep(0.012, 0.03, h01).mul(
      smoothstep(0.05, 0.12, h01).oneMinus(),
    );
    const coastGlow = vec3(0.3, 0.55, 1.0).mul(coast).mul(0.2).mul(uCalm);

    // while a metadata lens is active, the terrain steps back so matches read
    const lensFade = uLensDim.mul(0.66).oneMinus();
    material.colorNode = base.add(contour).add(coastGlow).mul(lensFade);
    material.opacityNode = smoothstep(0.008, 0.05, h01)
      .mul(uMorph.oneMinus())
      .mul(0.97);

    return { geometry, material };
  }, [data]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame(() => {
    const m = meshRef.current;
    if (!m) return;
    // gone in space; stop occluding the cloud once it is mostly faded
    m.visible = uMorph.value < 0.985;
    material.depthWrite = uMorph.value < 0.5;
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      // draw FIRST among transparents so its depth is written before the point
      // sprites test against it — otherwise far hills paint over near orbs
      renderOrder={-10}
    />
  );
}
