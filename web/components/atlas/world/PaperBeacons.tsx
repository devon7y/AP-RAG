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
  const { sprite, dimAttr, selAttr } = useMemo(() => {
    const posG = new THREE.InstancedBufferAttribute(data.paperGround, 3);
    // ground buffer carries y=0; beacons hover on the terrain via morphPosition
    const posS = new THREE.InstancedBufferAttribute(data.paperSpace, 3);
    const colG = new THREE.InstancedBufferAttribute(data.paperColorGround, 3);
    const colS = new THREE.InstancedBufferAttribute(data.paperColorSpace, 3);
    const sizeA = new THREE.InstancedBufferAttribute(data.paperSize, 1);
    const yearA = new THREE.InstancedBufferAttribute(data.paperYear, 1);
    const selAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(data.nPapers),
      1,
    );
    selAttr.setUsage(THREE.DynamicDrawUsage);
    const dimAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(data.nPapers),
      1,
    );
    dimAttr.setUsage(THREE.DynamicDrawUsage);

    const aG = instancedBufferAttribute<"vec3">(posG, "vec3");
    const aS = instancedBufferAttribute<"vec3">(posS, "vec3");
    const aColG = instancedBufferAttribute<"vec3">(colG, "vec3");
    const aColS = instancedBufferAttribute<"vec3">(colS, "vec3");
    const aSize = instancedBufferAttribute<"float">(sizeA, "float");
    const aYear = instancedBufferAttribute<"float">(yearA, "float");
    const aSel = instancedBufferAttribute<"float">(selAttr, "float");
    const aDim = instancedBufferAttribute<"float">(dimAttr, "float");

    const mat = new PointsNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.blending = THREE.AdditiveBlending;
    mat.sizeAttenuation = true;

    mat.positionNode = morphPosition(aG, aS, 1.35);

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
    return { sprite, dimAttr, selAttr };
  }, [data]);

  useEffect(() => {
    const arr = dimAttr.array as Float32Array;
    if (lensMask) arr.set(lensMask);
    else arr.fill(0);
    dimAttr.needsUpdate = true;
  }, [lensMask, dimAttr]);

  useEffect(() => {
    const arr = selAttr.array as Float32Array;
    if (goldMask) arr.set(goldMask);
    else arr.fill(0);
    selAttr.needsUpdate = true;
  }, [goldMask, selAttr]);

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
