"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { PointsNodeMaterial } from "three/webgpu";
import {
  clamp,
  float,
  instancedBufferAttribute,
  mix,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec3,
} from "three/tsl";
import type { WorldData } from "./derive";
import { useWorld } from "./store";
import {
  morphPosition,
  uCalm,
  uFlash,
  uHit,
  uMorph,
  uYear,
  uYearLo,
} from "./uniforms";

/**
 * Every chunk in the corpus as one instanced-sprite draw call (the three r185
 * WebGPU pattern: a single THREE.Sprite with count = n + PointsNodeMaterial).
 *
 * The same points are the landscape's city lights AND the galaxy's stars:
 * positionNode morphs ground → space, colors cross-fade region tint → stellar
 * age, the time lens hides unborn chunks and flares the newly born, and the
 * lens mask dims whatever the active metadata filter excludes.
 */

const HIT = new THREE.Color("#86b6ef");
const FLASH = new THREE.Color("#cfe4ff");

export default function ChunkCloud({
  data,
  lensMask,
}: {
  data: WorldData;
  lensMask: Float32Array | null;
}) {
  const searchHits = useWorld((s) => s.searchHits);

  const { sprite, selAttr, dimAttr } = useMemo(() => {
    const posG = new THREE.InstancedBufferAttribute(data.chunkGround, 3);
    const posS = new THREE.InstancedBufferAttribute(data.chunkSpace, 3);
    const colG = new THREE.InstancedBufferAttribute(data.chunkColorGround, 3);
    const colS = new THREE.InstancedBufferAttribute(data.chunkColorSpace, 3);
    const sizeA = new THREE.InstancedBufferAttribute(data.chunkSize, 1);
    const phaseA = new THREE.InstancedBufferAttribute(data.chunkPhase, 1);
    const yearA = new THREE.InstancedBufferAttribute(data.chunkYear, 1);
    const selAttr = new THREE.InstancedBufferAttribute(new Float32Array(data.n), 1);
    selAttr.setUsage(THREE.DynamicDrawUsage);
    const dimAttr = new THREE.InstancedBufferAttribute(new Float32Array(data.n), 1);
    dimAttr.setUsage(THREE.DynamicDrawUsage);

    const aG = instancedBufferAttribute<"vec3">(posG, "vec3");
    const aS = instancedBufferAttribute<"vec3">(posS, "vec3");
    const aColG = instancedBufferAttribute<"vec3">(colG, "vec3");
    const aColS = instancedBufferAttribute<"vec3">(colS, "vec3");
    const aSize = instancedBufferAttribute<"float">(sizeA, "float");
    const aPhase = instancedBufferAttribute<"float">(phaseA, "float");
    const aYear = instancedBufferAttribute<"float">(yearA, "float");
    const aSel = instancedBufferAttribute<"float">(selAttr, "float");
    const aDim = instancedBufferAttribute<"float">(dimAttr, "float");

    const mat = new PointsNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true; // hills occlude the far side of the landmass
    mat.blending = THREE.AdditiveBlending;
    mat.sizeAttenuation = true;

    mat.positionNode = morphPosition(aG, aS);

    // time lens: unborn chunks are dark; the newly-born flash white-hot
    const alive = step(aYear, uYear.add(0.5)).mul(step(uYearLo, aYear.add(0.5)));
    const recency = clamp(uYear.add(0.5).sub(aYear).div(2.6), 0, 1)
      .oneMinus()
      .mul(step(0.5, aYear));

    const twinkle = sin(time.mul(1.5).add(aPhase)).mul(0.5).add(0.5).mul(0.3).add(0.7);
    const hitPulse = sin(time.mul(5.0)).mul(0.5).add(0.5).mul(0.75).add(0.25).mul(aSel);
    const dim = float(1).sub(aDim.mul(0.92));

    const d = uv().sub(0.5).length().mul(2.0).clamp(0, 1);
    const core = smoothstep(0.0, 0.5, d).oneMinus().pow(2.0).mul(1.6).add(1.0);

    const baseCol = mix(aColG, aColS, uMorph);
    mat.colorNode = baseCol
      .mul(twinkle)
      .mul(core)
      .mul(uCalm)
      .mul(dim)
      .mul(alive)
      .add(
        vec3(FLASH.r, FLASH.g, FLASH.b)
          .mul(recency)
          .mul(uFlash)
          .mul(uHit)
          .mul(core)
          .mul(alive),
      )
      .add(vec3(HIT.r, HIT.g, HIT.b).mul(hitPulse).mul(uHit).mul(core));
    mat.opacityNode = d
      .oneMinus()
      .pow(2.6)
      .mul(alive)
      .mul(dim.mul(0.86).add(0.14));
    mat.sizeNode = aSize
      .mul(hitPulse.mul(1.2).add(1.0))
      .mul(recency.mul(uFlash).mul(0.9).add(1.0))
      .mul(mix(float(0.85), float(1.0), uMorph));

    const sprite = new THREE.Sprite(mat as unknown as THREE.SpriteMaterial);
    sprite.count = data.n;
    sprite.frustumCulled = false;
    return { sprite, selAttr, dimAttr };
  }, [data]);

  // warp-drive search hits pulse in both frames
  useEffect(() => {
    const arr = selAttr.array as Float32Array;
    arr.fill(0);
    if (searchHits) for (const h of searchHits) arr[h.idx] = 1;
    selAttr.needsUpdate = true;
  }, [searchHits, selAttr]);

  // metadata lens mask (1 = dimmed)
  useEffect(() => {
    const arr = dimAttr.array as Float32Array;
    if (lensMask) arr.set(lensMask);
    else arr.fill(0);
    dimAttr.needsUpdate = true;
  }, [lensMask, dimAttr]);

  useEffect(() => () => sprite.material.dispose(), [sprite]);

  return <primitive object={sprite} />;
}
