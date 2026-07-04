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
  const gameChunk = useWorld((s) => s.gameChunk);

  const { sprite, fxAttr } = useMemo(() => {
    // WebGPU's DEFAULT device limit is 8 vertex buffers (three requests default
    // limits) — pack per-instance data into 5 buffers or the pipeline never builds:
    //   aG4  = [groundX, groundZ, size, phase]   (ground y comes from the terrain)
    //   aS4  = [spaceX, spaceY, spaceZ, year]
    //   colG, colS                                (region tint / stellar age)
    //   aFx  = [sel, dim]                         (dynamic: pulses + lens mask)
    const n = data.n;
    const g4 = new Float32Array(n * 4);
    const s4 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      g4[i * 4] = data.chunkGround[i * 3];
      g4[i * 4 + 1] = data.chunkGround[i * 3 + 2];
      g4[i * 4 + 2] = data.chunkSize[i];
      g4[i * 4 + 3] = data.chunkPhase[i];
      s4[i * 4] = data.chunkSpace[i * 3];
      s4[i * 4 + 1] = data.chunkSpace[i * 3 + 1];
      s4[i * 4 + 2] = data.chunkSpace[i * 3 + 2];
      s4[i * 4 + 3] = data.chunkYear[i];
    }
    const posG4 = new THREE.InstancedBufferAttribute(g4, 4);
    const posS4 = new THREE.InstancedBufferAttribute(s4, 4);
    const colG = new THREE.InstancedBufferAttribute(data.chunkColorGround, 3);
    const colS = new THREE.InstancedBufferAttribute(data.chunkColorSpace, 3);
    const fxAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    fxAttr.setUsage(THREE.DynamicDrawUsage);

    const aG4 = instancedBufferAttribute<"vec4">(posG4, "vec4");
    const aS4 = instancedBufferAttribute<"vec4">(posS4, "vec4");
    const aColG = instancedBufferAttribute<"vec3">(colG, "vec3");
    const aColS = instancedBufferAttribute<"vec3">(colS, "vec3");
    const aFx = instancedBufferAttribute<"vec2">(fxAttr, "vec2");

    const aSize = aG4.z;
    const aPhase = aG4.w;
    const aYear = aS4.w;
    const aSel = aFx.x;
    const aDim = aFx.y;

    const mat = new PointsNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true; // hills occlude the far side of the landmass
    mat.blending = THREE.AdditiveBlending;
    mat.sizeAttenuation = true;

    mat.positionNode = morphPosition(
      vec3(aG4.x, 0, aG4.y),
      vec3(aS4.x, aS4.y, aS4.z),
    );

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
    return { sprite, fxAttr };
  }, [data]);

  // dynamic fx lanes: x = pulse (search hits + today's Semantle passage), y = lens dim
  useEffect(() => {
    const arr = fxAttr.array as Float32Array;
    for (let i = 0; i < data.n; i++) arr[i * 2] = 0;
    if (searchHits) for (const h of searchHits) arr[h.idx * 2] = 1;
    if (gameChunk !== null) arr[gameChunk * 2] = 1;
    fxAttr.needsUpdate = true;
  }, [searchHits, gameChunk, fxAttr, data.n]);

  useEffect(() => {
    const arr = fxAttr.array as Float32Array;
    for (let i = 0; i < data.n; i++) arr[i * 2 + 1] = lensMask ? lensMask[i] : 0;
    fxAttr.needsUpdate = true;
  }, [lensMask, fxAttr, data.n]);

  useEffect(() => () => sprite.material.dispose(), [sprite]);

  return <primitive object={sprite} />;
}
