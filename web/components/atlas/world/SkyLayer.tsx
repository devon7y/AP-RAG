"use client";

import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { LineBasicNodeMaterial, PointsNodeMaterial } from "three/webgpu";
import {
  attribute,
  clamp,
  float,
  instancedBufferAttribute,
  mix,
  positionLocal,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec3,
} from "three/tsl";
import { clusterColor } from "@/lib/atlas/palette";
import type { CorpusData } from "@/lib/atlas/types";
import { glowTexture, ringTexture, type WorldData } from "./derive";
import { useWorld } from "./store";
import { uBirthWin, uCalm, uFlash, uHit, uMorph, uYear } from "./uniforms";

/**
 * The sky: LightRAG's knowledge graph floating above the literature.
 * Ground frame — entities hover over their member chunks, altitude by
 * abstraction (theories high, datasets low). Space frame — they take their
 * embedding positions among the stars. Figures and the entity–entity web are
 * line geometries whose vertices morph in the vertex stage (no CPU per-frame
 * work); entities ignite in the year their first member chunk was published.
 */

/* ---------------- morphable line set ---------------- */

function MorphLines({
  ground,
  space,
  color,
  opacity,
  visibleNode = 1,
}: {
  ground: Float32Array;
  space: Float32Array;
  color: string;
  opacity: number;
  /** extra multiplier: 0..1 (e.g. fade with morph) */
  visibleNode?: number | "fadeInSpace" | "fadeInAtlas";
}) {
  const { line, mat, geo } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(ground, 3));
    geo.setAttribute("aSpace", new THREE.BufferAttribute(space, 3));

    const mat = new LineBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.positionNode = mix(positionLocal, attribute<"vec3">("aSpace", "vec3"), uMorph);
    const c = new THREE.Color(color);
    mat.colorNode = vec3(c.r, c.g, c.b).mul(uCalm);
    mat.opacityNode =
      visibleNode === "fadeInSpace"
        ? float(opacity).mul(uMorph)
        : visibleNode === "fadeInAtlas"
          ? float(opacity).mul(uMorph.oneMinus())
          : float(opacity);

    const line = new THREE.LineSegments(geo, mat);
    line.frustumCulled = false;
    return { line, mat, geo };
  }, [ground, space, color, opacity, visibleNode]);

  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );

  return <primitive object={line} />;
}

/* ---------------- entity stars ---------------- */

function EntityStars({ data }: { data: WorldData }) {
  const { sprite } = useMemo(() => {
    const n = data.entities.length;
    const ground = new Float32Array(n * 3);
    const space = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const phases = new Float32Array(n);
    const years = new Float32Array(n);
    const c = new THREE.Color();
    const maxDeg = data.entities[0]?.deg ?? 1;
    data.entities.forEach((e, i) => {
      ground[i * 3] = e.ground.x;
      ground[i * 3 + 1] = e.ground.y;
      ground[i * 3 + 2] = e.ground.z;
      space[i * 3] = e.space.x;
      space[i * 3 + 1] = e.space.y;
      space[i * 3 + 2] = e.space.z;
      c.set(e.color);
      // Degree spans four orders of magnitude here, and the sprites blend
      // additively — so a handful of hub entities sitting close together
      // stacked into a single blown-out blob (the amber/orange one in the
      // middle of the galaxy). Flatten the curve so brightness still ranks
      // them without any cluster saturating.
      const lum = 0.42 + 0.34 * (Math.log1p(e.deg) / Math.log1p(maxDeg));
      colors[i * 3] = c.r * lum;
      colors[i * 3 + 1] = c.g * lum;
      colors[i * 3 + 2] = c.b * lum;
      sizes[i] = 1.4 + 1.8 * (Math.log1p(e.deg) / Math.log1p(maxDeg));
      phases[i] = ((i * 0.7548776662) % 1) * Math.PI * 2;
      years[i] = e.minYear;
    });

    const posG = new THREE.InstancedBufferAttribute(ground, 3);
    const posS = new THREE.InstancedBufferAttribute(space, 3);
    const colA = new THREE.InstancedBufferAttribute(colors, 3);
    const sizeA = new THREE.InstancedBufferAttribute(sizes, 1);
    const phaseA = new THREE.InstancedBufferAttribute(phases, 1);
    const yearA = new THREE.InstancedBufferAttribute(years, 1);

    const aG = instancedBufferAttribute<"vec3">(posG, "vec3");
    const aS = instancedBufferAttribute<"vec3">(posS, "vec3");
    const aCol = instancedBufferAttribute<"vec3">(colA, "vec3");
    const aSize = instancedBufferAttribute<"float">(sizeA, "float");
    const aPhase = instancedBufferAttribute<"float">(phaseA, "float");
    const aYear = instancedBufferAttribute<"float">(yearA, "float");

    const mat = new PointsNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.depthTest = true;
    mat.blending = THREE.AdditiveBlending;
    mat.sizeAttenuation = true;

    mat.positionNode = mix(aG, aS, uMorph);

    const alive = step(aYear, uYear.add(0.01));
    // the graph belongs to the galaxy — it materializes as the world lifts off
    const reveal = smoothstep(0.12, 0.55, uMorph);
    const ignite = clamp(uYear.add(0.01).sub(aYear).div(uBirthWin), 0, 1)
      .oneMinus()
      .mul(step(0.5, aYear));
    const twinkle = sin(time.mul(0.9).add(aPhase)).mul(0.5).add(0.5).mul(0.35).add(0.65);
    const d = uv().sub(0.5).length().mul(2.0).clamp(0, 1);
    // four-point diffraction spikes make entities read as *named* stars
    const p = uv().sub(0.5);
    const spike = float(1)
      .sub(p.x.abs().min(p.y.abs()).mul(26.0))
      .clamp(0, 1)
      .pow(2.2)
      .mul(smoothstep(1.0, 0.25, d))
      .mul(0.5);
    const core = smoothstep(0.0, 0.45, d).oneMinus().pow(2.4).mul(2.2).add(spike);

    mat.colorNode = aCol
      .mul(twinkle)
      .mul(core)
      .mul(uCalm)
      .mul(alive)
      .add(vec3(1, 1, 1).mul(ignite).mul(uFlash).mul(uHit).mul(core).mul(alive))
      .mul(reveal);
    mat.opacityNode = d.oneMinus().pow(2.0).add(spike).clamp(0, 1).mul(alive).mul(reveal);
    mat.sizeNode = aSize.mul(ignite.mul(uFlash).mul(0.8).add(1.0));

    const sprite = new THREE.Sprite(mat as unknown as THREE.SpriteMaterial);
    sprite.count = n;
    sprite.frustumCulled = false;
    return { sprite };
  }, [data]);

  useEffect(() => () => sprite.material.dispose(), [sprite]);
  return <primitive object={sprite} />;
}

/* ---------------- focus: selected entity ---------------- */

export function entityWorldPos(
  data: WorldData,
  idx: number,
  morph: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const e = data.entities[idx];
  return out.copy(e.ground).lerp(e.space, morph);
}

function FocusEntity({ data }: { data: WorldData }) {
  const selection = useWorld((s) => s.selection);
  const idx = selection?.kind === "entity" ? selection.idx : null;

  const shafts = useMemo(() => {
    if (idx === null) return null;
    const e = data.entities[idx];
    const members = e.members.slice(0, 40);
    const g = new Float32Array(members.length * 6);
    const s = new Float32Array(members.length * 6);
    members.forEach((m, i) => {
      g.set(
        [
          e.ground.x,
          e.ground.y,
          e.ground.z,
          data.chunkGround[m * 3],
          data.chunkGroundY[m],
          data.chunkGround[m * 3 + 2],
        ],
        i * 6,
      );
      s.set(
        [
          e.space.x,
          e.space.y,
          e.space.z,
          data.chunkSpace[m * 3],
          data.chunkSpace[m * 3 + 1],
          data.chunkSpace[m * 3 + 2],
        ],
        i * 6,
      );
    });
    return { g, s, entity: e };
  }, [data, idx]);

  if (!shafts) return null;
  return (
    <group>
      <MorphLines
        ground={shafts.entity.figureGround}
        space={shafts.entity.figureSpace}
        color={shafts.entity.color}
        opacity={0.5}
        visibleNode="fadeInSpace"
      />
      <MorphLines
        ground={shafts.g}
        space={shafts.s}
        color={shafts.entity.color}
        opacity={0.14}
        visibleNode="fadeInSpace"
      />
      <EntityRing data={data} idx={shafts.entity.idx} color={shafts.entity.color} />
    </group>
  );
}

function EntityRing({ data, idx, color }: { data: WorldData; idx: number; color: string }) {
  const sprite = useMemo(() => {
    const m = new THREE.SpriteMaterial({
      map: ringTexture(),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    m.color.set(color);
    const s = new THREE.Sprite(m);
    s.renderOrder = 10;
    return s;
  }, [color]);
  useEffect(() => () => sprite.material.dispose(), [sprite]);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    entityWorldPos(data, idx, uMorph.value, tmp);
    sprite.position.copy(tmp);
    const t = state.clock.elapsedTime;
    sprite.scale.setScalar(3.6 * (1.1 + 0.2 * Math.sin(t * 2.4)));
    sprite.material.rotation = -t * 0.25;
    sprite.material.opacity = uMorph.value; // graph focus lives in the galaxy
    sprite.visible = uMorph.value > 0.05;
  });
  return <primitive object={sprite} />;
}

/* ---------------- nebulae (space frame) ---------------- */

function Nebulae({ corpus }: { corpus: CorpusData }) {
  const group = useMemo(() => {
    const g = new THREE.Group();
    const tex = glowTexture();
    const sorted = [...corpus.clusters].sort((a, b) => b.size - a.size).slice(0, 28);
    for (const cl of sorted) {
      const m = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      });
      m.color.set(clusterColor(cl.id)).multiplyScalar(0.55);
      const s = new THREE.Sprite(m);
      s.position.set(
        (cl.center3[0] - 0.5) * 100,
        (cl.center3[1] - 0.5) * 100,
        (cl.center3[2] - 0.5) * 100,
      );
      s.scale.setScalar(10 + Math.sqrt(cl.size) * 0.55);
      g.add(s);
    }
    return g;
  }, [corpus]);

  useEffect(
    () => () => {
      for (const s of group.children) (s as THREE.Sprite).material.dispose();
    },
    [group],
  );

  useFrame(() => {
    const o = uMorph.value * 0.15;
    for (const s of group.children) {
      (s as THREE.Sprite).material.opacity = o;
    }
    group.visible = o > 0.004;
  });

  return <primitive object={group} />;
}

/* ---------------- the layer ---------------- */

export default function SkyLayer({
  data,
  corpus,
}: {
  data: WorldData;
  corpus: CorpusData;
}) {
  const showSky = useWorld((s) => s.showSky);
  const showWeb = useWorld((s) => s.showWeb);

  if (!showSky)
    return (
      <group>
        <Nebulae corpus={corpus} />
      </group>
    );

  return (
    <group>
      <EntityStars data={data} />
      <MorphLines
        ground={data.ambientFiguresGround}
        space={data.ambientFiguresSpace}
        color="#8fa8cf"
        opacity={0.13}
        visibleNode="fadeInSpace"
      />
      {showWeb && (
        <MorphLines
          ground={data.webGround}
          space={data.webSpace}
          color="#5a6a8c"
          opacity={0.07}
          visibleNode="fadeInSpace"
        />
      )}
      <FocusEntity data={data} />
      <Nebulae corpus={corpus} />
    </group>
  );
}
