"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
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
import { ringTexture, type WorldData } from "./derive";
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
import { useAtlasStore } from "@/lib/atlas/store";

/**
 * Papers as beacons — a halo-ringed sprite per paper, the primary interactive
 * object at mid zoom. At the full ~10k-paper corpus this stays ONE draw call.
 * Gold pulse marks the active author-lens oeuvre; unborn papers respect the
 * time lens like everything else.
 */

const GOLD = new THREE.Color("#ffd27a");

/** Beacons ride a little higher than chunk points (lift 1.35 vs 0.55). */
const BEACON_EXTRA_LIFT = 0.8;

export function paperWorldPos(
  data: WorldData,
  i: number,
  morph: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(
    THREE.MathUtils.lerp(data.paperGround[i * 3], data.paperSpace[i * 3], morph),
    THREE.MathUtils.lerp(
      data.paperGroundY[i] + BEACON_EXTRA_LIFT,
      data.paperSpace[i * 3 + 1],
      morph,
    ),
    THREE.MathUtils.lerp(
      data.paperGround[i * 3 + 2],
      data.paperSpace[i * 3 + 2],
      morph,
    ),
  );
}

export default function PaperBeacons({
  data,
  lensMask,
  goldMask,
}: {
  data: WorldData;
  lensMask: Float32Array | null;
  /** papers pulsing gold (author lens / game reveal) */
  goldMask: Float32Array | null;
}) {
  const { sprite, fxAttr } = useMemo(() => {
    // ≤8 vertex buffers (WebGPU default limit): pack instance data into 5
    //   aG4 = [groundX, groundZ, size, year] · aS4 = [space xyz, unused]
    //   colG, colS · aFx = [gold, dim] (dynamic)
    const n = data.nPapers;
    const g4 = new Float32Array(n * 4);
    const s4 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      g4[i * 4] = data.paperGround[i * 3];
      g4[i * 4 + 1] = data.paperGround[i * 3 + 2];
      g4[i * 4 + 2] = data.paperSize[i];
      g4[i * 4 + 3] = data.paperYear[i];
      s4[i * 4] = data.paperSpace[i * 3];
      s4[i * 4 + 1] = data.paperSpace[i * 3 + 1];
      s4[i * 4 + 2] = data.paperSpace[i * 3 + 2];
    }
    const posG4 = new THREE.InstancedBufferAttribute(g4, 4);
    const posS4 = new THREE.InstancedBufferAttribute(s4, 4);
    const colG = new THREE.InstancedBufferAttribute(data.paperColorGround, 3);
    const colS = new THREE.InstancedBufferAttribute(data.paperColorSpace, 3);
    const fxAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    fxAttr.setUsage(THREE.DynamicDrawUsage);

    const aG4 = instancedBufferAttribute<"vec4">(posG4, "vec4");
    const aS4 = instancedBufferAttribute<"vec4">(posS4, "vec4");
    const aColG = instancedBufferAttribute<"vec3">(colG, "vec3");
    const aColS = instancedBufferAttribute<"vec3">(colS, "vec3");
    const aFx = instancedBufferAttribute<"vec2">(fxAttr, "vec2");

    const aSize = aG4.z;
    const aYear = aG4.w;
    const aSel = aFx.x;
    const aDim = aFx.y;

    const mat = new PointsNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.blending = THREE.AdditiveBlending;
    mat.sizeAttenuation = true;

    mat.positionNode = morphPosition(
      vec3(aG4.x, 0, aG4.y),
      vec3(aS4.x, aS4.y, aS4.z),
      1.35,
    );

    const alive = step(aYear, uYear.add(0.5)).mul(step(uYearLo, aYear.add(0.5)));
    const recency = clamp(uYear.add(0.5).sub(aYear).div(2.2), 0, 1)
      .oneMinus()
      .mul(step(0.5, aYear));
    const dim = float(1).sub(aDim.mul(0.9));
    const goldPulse = sin(time.mul(3.4)).mul(0.5).add(0.5).mul(0.6).add(0.4).mul(aSel);

    const d = uv().sub(0.5).length().mul(2.0).clamp(0, 1);
    // beacon profile: hot core + a distinct halo ring (reads different from chunks)
    const core = smoothstep(0.0, 0.42, d).oneMinus().pow(3.0).mul(2.4).add(0.35);
    const ring = smoothstep(0.5, 0.65, d).mul(smoothstep(0.78, 0.95, d).oneMinus()).mul(0.85);
    const profile = core.add(ring);

    const baseCol = mix(aColG, aColS, uMorph);
    mat.colorNode = baseCol
      .mul(profile)
      .mul(uCalm)
      .mul(dim)
      .mul(alive)
      .add(vec3(GOLD.r, GOLD.g, GOLD.b).mul(goldPulse).mul(uHit).mul(profile).mul(alive))
      .add(vec3(1, 1, 1).mul(recency).mul(uFlash).mul(uHit).mul(profile).mul(alive));
    mat.opacityNode = smoothstep(0.95, 0.55, d)
      .mul(alive)
      .mul(dim.mul(0.85).add(0.15));
    mat.sizeNode = aSize
      .mul(goldPulse.mul(0.5).add(1.0))
      .mul(recency.mul(uFlash).mul(0.8).add(1.0));

    const sprite = new THREE.Sprite(mat as unknown as THREE.SpriteMaterial);
    sprite.count = data.nPapers;
    sprite.frustumCulled = false;
    return { sprite, fxAttr };
  }, [data]);

  useEffect(() => {
    const arr = fxAttr.array as Float32Array;
    for (let i = 0; i < data.nPapers; i++) {
      arr[i * 2] = goldMask ? goldMask[i] : 0;
      arr[i * 2 + 1] = lensMask ? lensMask[i] : 0;
    }
    fxAttr.needsUpdate = true;
  }, [lensMask, goldMask, fxAttr, data.nPapers]);

  useEffect(() => () => sprite.material.dispose(), [sprite]);

  return (
    <group>
      <primitive object={sprite} />
      <SelectionRings data={data} />
    </group>
  );
}

/** Billboard rings marking the hovered / selected paper (morph-aware). */
function SelectionRings({ data }: { data: WorldData }) {
  const hovered = useWorld((s) => s.hovered);
  const selection = useWorld((s) => s.selection);
  const hoverIdx = hovered?.kind === "paper" ? hovered.idx : null;
  const selIdx = selection?.kind === "paper" ? selection.idx : null;

  return (
    <>
      {hoverIdx !== null && hoverIdx !== selIdx && (
        <Ring data={data} idx={hoverIdx} color="#c3c2b7" base={1.0} pulse={0.12} speed={5} />
      )}
      {selIdx !== null && (
        <Ring data={data} idx={selIdx} color="#9ec5f4" base={1.15} pulse={0.22} speed={2.6} />
      )}
    </>
  );
}

function Ring({
  data,
  idx,
  color,
  base,
  pulse,
  speed,
}: {
  data: WorldData;
  idx: number;
  color: string;
  base: number;
  pulse: number;
  speed: number;
}) {
  const boost = useAtlasStore((s) => s.hdrBoost);
  const sprite = useMemo(() => {
    const m = new THREE.SpriteMaterial({
      map: ringTexture(),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    return new THREE.Sprite(m);
  }, []);
  useEffect(() => {
    sprite.material.color.set(color).multiplyScalar(0.85 * boost);
  }, [sprite, color, boost]);
  useEffect(() => () => sprite.material.dispose(), [sprite]);

  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    paperWorldPos(data, idx, uMorph.value, tmp);
    sprite.position.copy(tmp);
    const size = 2.2 + data.paperSize[idx] * 1.6;
    sprite.scale.setScalar(size * (base + pulse * (0.5 + 0.5 * Math.sin(t * speed))));
    sprite.material.rotation = t * 0.3;
  });

  return <primitive object={sprite} />;
}
